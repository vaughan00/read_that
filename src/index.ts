/**
 * Minimal personal Reddit client on Cloudflare Workers
 * Endpoints:
 *   GET /            -> tiny UI
 *   GET /api/feed    -> JSON feed with custom ranking & filters
 */

export interface Env {
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET?: string; // optional when using refresh-token (installed app)
  REDDIT_USERNAME?: string;      // only for password grant (script app)
  REDDIT_PASSWORD?: string;      // only for password grant (script app)
  USER_AGENT: string;
  REFRESH_TOKEN?: string;        // preferred: use refresh-token flow

  // Optional defaults for UI
  DEFAULT_SUBS?: string;   // e.g. "best" or "programming+webdev"
  DEFAULT_LIMIT?: string;  // e.g. "50"
}

// In-memory token cache per isolate
let tokenCache: { token: string; expiresAt: number } | null = null;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/feed") {
      return handleApiFeed(url, env);
    }
    if (url.pathname === "/api/me") {
      try {
        const token = await getAccessToken(env);
        const me = await redditGet(token, env, '/api/v1/me');
        return json(me);
      } catch (err: any) {
        console.error('[api/me] Error:', err && (err.stack || err));
        return json({ error: err?.message || String(err) }, 500);
      }
    }
    return new Response(renderHtml(env), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

async function handleApiFeed(url: URL, env: Env): Promise<Response> {
  try {
    const accessToken = await getAccessToken(env);

    const subs = (url.searchParams.get("sub") || env.DEFAULT_SUBS || "best").trim();
    const limit = clampInt(url.searchParams.get("limit"), 10, 100, parseInt(env.DEFAULT_LIMIT || "50", 10));
    const minUp = clampInt(url.searchParams.get("min"), 0, 10000, 0);
    const excludeDomains = (url.searchParams.get("exclude") || "")
      .split(/[,+\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const includeNSFW = (url.searchParams.get("nsfw") || "false").toLowerCase() === "true";
    const sort = (url.searchParams.get("sort") || "rank").toLowerCase(); // "rank" | "new" | "top"
    const time = (url.searchParams.get("t") || "day").toLowerCase(); // for /top (hour,day,week,month,year,all)

    let path: string;
    let baseListing = "new";
    if (subs === "best" || subs === "home") {
      path = `/best?limit=${limit}`;
      baseListing = "best";
    } else if (sort === "top") {
      path = `/r/${encodeURIComponent(subs)}/top?limit=${limit}&t=${encodeURIComponent(time)}`;
      baseListing = "top";
    } else {
      path = `/r/${encodeURIComponent(subs)}/new?limit=${limit}`;
      baseListing = "new";
    }

    const listing = await redditGet(accessToken, env, path);
    const now = Date.now() / 1000;

    const posts = (listing.data?.children || [])
      .map((c: any) => c.data)
      .filter((p: any) => {
        if (!includeNSFW && p.over_18) return false;
        if (p.score < minUp) return false;
        if (excludeDomains.length) {
          const d = (p.domain || "").toLowerCase();
          if (excludeDomains.some((ex) => d.includes(ex))) return false;
        }
        return true;
      })
      .map((p: any) => {
        const ageHours = Math.max(0.0, (now - p.created_utc) / 3600.0);
        const rank =
          (p.ups + 1) / Math.pow(ageHours + 2, 1.5) +
          (p.num_comments ? Math.log10(p.num_comments + 1) * 0.5 : 0);
        return {
          id: p.id,
          title: p.title,
          url: "url_overridden_by_dest" in p ? p.url_overridden_by_dest : p.url,
          permalink: `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit,
          author: p.author,
          score: p.score,
          ups: p.ups,
          comments: p.num_comments,
          created_utc: p.created_utc,
          over_18: p.over_18,
          domain: p.domain,
          preview: p.thumbnail && p.thumbnail.startsWith("http") ? p.thumbnail : null,
          rank,
        };
      });

    if (sort === "new") {
      posts.sort((a: any, b: any) => b.created_utc - a.created_utc);
    } else if (sort === "top" || baseListing === "top") {
      posts.sort((a: any, b: any) => b.score - a.score);
    } else {
      posts.sort((a: any, b: any) => b.rank - a.rank);
    }

    return json(posts);
  } catch (err: any) {
    console.error('[api/feed] Error:', err && (err.stack || err));
    return json({ error: err?.message || String(err) }, 500);
  }
}

async function getAccessToken(env: Env): Promise<string> {
  // Preflight: support either refresh-token flow or password grant
  const usingRefresh = !!env.REFRESH_TOKEN;
  const missing: string[] = [];
  if (!env.REDDIT_CLIENT_ID) missing.push('REDDIT_CLIENT_ID');
  if (!env.USER_AGENT) missing.push('USER_AGENT');
  if (usingRefresh) {
    if (!env.REFRESH_TOKEN) missing.push('REFRESH_TOKEN');
  } else {
    if (!env.REDDIT_CLIENT_SECRET) missing.push('REDDIT_CLIENT_SECRET');
    if (!env.REDDIT_USERNAME) missing.push('REDDIT_USERNAME');
    if (!env.REDDIT_PASSWORD) missing.push('REDDIT_PASSWORD');
  }
  if (missing.length) {
    throw new Error('Missing Worker secrets: ' + missing.join(', ') + '. Set them with `wrangler secret put <NAME>` or in a `.dev.vars` file for local dev.');
  }

  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  // If a refresh token is provided, use refresh flow (installed app). Client secret may be empty.
  if (env.REFRESH_TOKEN) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.REFRESH_TOKEN,
    });
    const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET || ''}`);
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': env.USER_AGENT,
      },
      body,
    });
    if (!res.ok) {
      console.error('[auth] Refresh token failed', res.status, await res.text());
      throw new Error('Token request failed: ' + res.status);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "password",
    username: env.REDDIT_USERNAME!,
    password: env.REDDIT_PASSWORD!,
    scope: "read,mysubreddits,history",
  });

  const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": env.USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    console.error('[auth] Password grant failed', res.status, await res.text());
    throw new Error('Token request failed: ' + res.status);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

async function redditGet(token: string, env: Env, path: string): Promise<any> {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": env.USER_AGENT,
    },
  });
  if (!res.ok) {
    console.error('[reddit] API error', res.status, await res.text());
    throw new Error('Reddit API error: ' + res.status);
  }
  return res.json();
}

function clampInt(val: string | null, min: number, max: number, fallback: number): number {
  const n = val ? parseInt(val, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function renderHtml(env: Env): string {
  const defaultSubs = (env.DEFAULT_SUBS || "best").replace(/"/g, "&quot;");
  const defaultLimit = env.DEFAULT_LIMIT || "50";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Reddit — Cloudflare Worker</title>
<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 24px; line-height: 1.4; }
  header { display:flex; gap:12px; flex-wrap:wrap; align-items: end; }
  label { display:block; font-size:12px; color:#555; }
  input, select { padding:8px; border:1px solid #ccc; border-radius:8px; }
  button { padding:10px 14px; border:0; border-radius:10px; cursor:pointer; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  button:hover { filter: brightness(0.98); }
  .row { display:grid; grid-template-columns: 1fr; gap:8px; }
  @media (min-width: 880px) {
    .row { grid-template-columns: repeat(6, minmax(0,1fr)); align-items: end; }
  }
  ul { list-style:none; padding:0; margin:20px 0 0; display:grid; gap:10px; }
  li { border:1px solid #e7e7e7; border-radius:12px; padding:12px; display:grid; gap:6px; }
  .meta { font-size:12px; color:#666; display:flex; gap:10px; flex-wrap:wrap; }
  .title { font-weight:600; font-size:16px; }
  .thumb { width: 80px; height: 80px; object-fit:cover; border-radius:8px; border:1px solid #eee; }
  .item { display:grid; grid-template-columns: 1fr auto; gap:12px; align-items:center; }
</style>
<header>
  <div>
    <label>Subreddits (e.g. programming+javascript or "best")</label>
    <input id="sub" value="${defaultSubs}" placeholder="best">
  </div>
  <div>
    <label>Limit (10–100)</label>
    <input id="limit" type="number" min="10" max="100" value="${defaultLimit}">
  </div>
  <div>
    <label>Min upvotes</label>
    <input id="min" type="number" min="0" value="0">
  </div>
  <div>
    <label>Exclude domains (comma/space separated)</label>
    <input id="exclude" placeholder="twitter.com, youtube.com">
  </div>
  <div>
    <label>Sort</label>
    <select id="sort">
      <option value="rank" selected>Rank (custom)</option>
      <option value="new">New</option>
      <option value="top">Top</option>
    </select>
  </div>
  <div>
    <label>Top time window (if Sort=Top)</label>
    <select id="t">
      <option>hour</option><option selected>day</option><option>week</option>
      <option>month</option><option>year</option><option>all</option>
    </select>
  </div>
  <div>
    <label>Include NSFW</label>
    <select id="nsfw"><option>false</option><option>true</option></select>
  </div>
  <div>
    <button id="go">Fetch</button>
  </div>
</header>

<ul id="list"></ul>

<script>
async function run() {
  const sub = document.getElementById('sub').value.trim();
  const limit = document.getElementById('limit').value;
  const min = document.getElementById('min').value;
  const exclude = document.getElementById('exclude').value.trim();
  const sort = document.getElementById('sort').value;
  const t = document.getElementById('t').value;
  const nsfw = document.getElementById('nsfw').value;

  const params = new URLSearchParams({ sub, limit, min, sort, t, nsfw });
  if (exclude) params.set('exclude', exclude);
  const res = await fetch('/api/feed?' + params.toString());
  const data = await res.json();
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  for (const p of data) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.className = 'title';
    const a = document.createElement('a');
    a.href = p.permalink; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = p.title;
    left.appendChild(a);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = p.subreddit + ' • u/' + p.author + ' • ↑' + p.ups + ' • ' + p.comments + ' comments • ' + new Date(p.created_utc * 1000).toLocaleString();

    const link = document.createElement('div');
    link.className = 'meta';
    const ext = document.createElement('a');
    ext.href = p.url; ext.target = '_blank'; ext.rel = 'noopener';
    ext.textContent = p.domain;
    link.appendChild(ext);

    const item = document.createElement('div');
    item.className = 'item';
    const stack = document.createElement('div');
    stack.appendChild(left);
    stack.appendChild(meta);
    stack.appendChild(link);
    item.appendChild(stack);

    if (p.preview) {
      const img = document.createElement('img');
      img.src = p.preview; img.className = 'thumb';
      item.appendChild(img);
    }

    li.appendChild(item);
    ul.appendChild(li);
  }
}

document.getElementById('go').addEventListener('click', run);
run();
</script>
</html>`;
}
