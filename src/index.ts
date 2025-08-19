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
  API_KEY?: string;              // optional shared secret for /api/*

  // Optional defaults for UI
  DEFAULT_SUBS?: string;   // e.g. "best" or "programming+webdev"
  DEFAULT_LIMIT?: string;  // e.g. "50"
}

// In-memory token cache per isolate
let tokenCache: { token: string; expiresAt: number } | null = null;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Simple API key protection for API routes only; accept header or ?key=
    const requiresKey = url.pathname.startsWith('/api/');
    if (requiresKey) {
      const apiKey = request.headers.get('x-api-key') || url.searchParams.get('key');
      if (apiKey !== env.API_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
    }
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
    if (url.pathname === "/api/mysubs") {
      try {
        const token = await getAccessToken(env);
        const results: string[] = [];
        let after: string | null = null;
        let guard = 0;
        do {
          const q = new URLSearchParams({ limit: "100" });
          if (after) q.set("after", after);
          const page = await redditGet(token, env, "/subreddits/mine/subscriber?" + q.toString());
          const children = page?.data?.children || [];
          for (const c of children) {
            const name = c?.data?.display_name_prefixed || c?.data?.display_name;
            if (name) results.push(String(name).replace(/^r\//i, ""));
          }
          after = page?.data?.after || null;
          guard++;
        } while (after && guard < 20);
        const uniq = Array.from(new Set(results.map((s) => s.toLowerCase())));
        uniq.sort((a, b) => a.localeCompare(b));
        return json({ subs: uniq });
      } catch (err: any) {
        console.error('[api/mysubs] Error:', err && (err.stack || err));
        return json({ error: err?.message || String(err) }, 500);
      }
    }
    if (url.pathname === "/post") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing id", { status: 400 });
      return new Response(renderPostPage(env, id), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/comments") {
      const id = url.searchParams.get("id");
      const sort = (url.searchParams.get("sort") || "confidence").toLowerCase();
      const limit = clampInt(url.searchParams.get("limit"), 5, 200, 100);
      if (!id) return json({ error: "Missing id" }, 400);
      try {
        const token = await getAccessToken(env);
        const listing = await redditGet(token, env, `/comments/${encodeURIComponent(id)}.json?limit=${limit}&sort=${encodeURIComponent(sort)}`);
        const payload = simplifyCommentsListing(listing);
        return json(payload);
      } catch (err: any) {
        console.error('[api/comments] Error:', err && (err.stack || err));
        return json({ error: err?.message || String(err) }, 500);
      }
    }
    if (url.pathname === "/api/vote") {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const body = await request.json();
        let { id, dir } = body || {};
        if (typeof dir !== 'number' || ![-1, 0, 1].includes(dir)) {
          return json({ error: 'dir must be -1, 0, or 1' }, 400);
        }
        if (!id || typeof id !== 'string') return json({ error: 'Missing id' }, 400);
        // Accept plain IDs and coerce to fullnames
        if (!/^t[13]_/.test(id)) {
          // Guess type by length (post ids are 6+ chars) — default to post (t3)
          id = 't3_' + id;
        }
        const token = await getAccessToken(env);
        const form = new URLSearchParams({ id, dir: String(dir) });
        const res = await fetch('https://oauth.reddit.com/api/vote', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': env.USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form
        });
        if (!res.ok) {
          const txt = await res.text();
          console.error('[api/vote] Reddit vote error', res.status, txt);
          // Common: 403 insufficient_scope when refresh token lacks `vote`
          return json({ error: 'Reddit error', status: res.status, detail: txt }, res.status);
        }
        return json({ ok: true });
      } catch (err: any) {
        console.error('[api/vote] Error:', err && (err.stack || err));
        return json({ error: err?.message || String(err) }, 500);
      }
    }
    if (url.pathname === "/api/comment") {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const body = await request.json();
        let { parent, text } = body || {};
        if (!parent || typeof parent !== 'string') return json({ error: 'Missing parent' }, 400);
        if (!text || typeof text !== 'string' || !text.trim()) return json({ error: 'Missing text' }, 400);
        // Accept plain IDs; coerce to fullname (posts are t3_, comments t1_)
        if (!/^t[13]_/.test(parent)) {
          parent = (parent.length > 6 ? 't3_' : 't1_') + parent;
        }
        const token = await getAccessToken(env);
        const form = new URLSearchParams({
          thing_id: parent,
          text,
          api_type: 'json'
        });
        const res = await fetch('https://oauth.reddit.com/api/comment', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': env.USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form
        });
        const txt = await res.text();
        if (!res.ok) {
          console.error('[api/comment] Reddit error', res.status, txt);
          return json({ error: 'Reddit error', status: res.status, detail: txt }, res.status);
        }
        let payload: any = {};
        try { payload = JSON.parse(txt); } catch {}
        return json({ ok: true, reddit: payload });
      } catch (err: any) {
        console.error('[api/comment] Error:', err && (err.stack || err));
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

        // High-res image (if available)
        let image: string | null = null;
        try {
          if (p.preview && p.preview.images && p.preview.images[0]?.source?.url) {
            image = p.preview.images[0].source.url.replace(/&amp;/g, '&');
          } else if (p.url && /(jpg|jpeg|png|gif|webp)$/i.test(p.url)) {
            image = p.url;
          }
        } catch {}

        // Native reddit video (if available)
        let video: string | null = null;
        try {
          if (p.secure_media?.reddit_video?.fallback_url) {
            video = p.secure_media.reddit_video.fallback_url;
          }
        } catch {}

        const isSelf = !!p.is_self;

        return {
          id: p.id,
          fullname: p.name,
          title: p.title,
          url: "url_overridden_by_dest" in p ? p.url_overridden_by_dest : p.url,
          permalink: `https://reddit.com${p.permalink}`,
          subreddit: p.subreddit,
          author: p.author,
          score: p.score,
          ups: p.ups,
          likes: p.likes,
          comments: p.num_comments,
          created_utc: p.created_utc,
          over_18: p.over_18,
          domain: p.domain,
          rank,

          // New richer fields
          is_self: isSelf,
          selftext: isSelf ? (p.selftext || "") : "",
          image,
          video,
          thumbnail: p.thumbnail && p.thumbnail.startsWith("http") ? p.thumbnail : null,
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
    :root { --bg: #0b0b0e; --card:#111217; --muted:#8b8ea1; --text:#e8eaf2; --link:#8ab4ff; }
    @media (prefers-color-scheme: light) { :root { --bg:#fff; --card:#fafafa; --muted:#667085; --text:#111; --link:#1a73e8; }}
    html, body { background: var(--bg); color: var(--text); }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji; }
    header { position: static; background:#fff; color:#000; border-bottom: 1px solid #ddd; padding: 12px 16px; }
    header .hdr { display:flex; justify-content: space-between; align-items:center; max-width: 960px; margin: 0 auto 8px; }
    header .hdr .title { font-weight: 600; font-size: 14px; color: #444; }
    #toggleFilters { background:#fff; color:#000; border:1px solid #ccc; border-radius:12px; padding:8px 12px; cursor:pointer; }
    #toggleFilters:hover { background:#f3f4f6; }
    header.collapsed .bar { display: none; }
    .bar { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; align-items:end; max-width: 960px; margin:0 auto; }
    label { font-size:12px; color: var(--muted); display:block; }
    header .bar input,
    header .bar select,
    header .bar button { background:#fff; color:#000; border:1px solid #ccc; }

    header .bar input,
    header .bar select { border-radius:12px; padding:10px 12px; }

    header .bar button { border-radius:12px; padding:10px 14px; cursor:pointer; }

    header .bar button:hover { background:#f3f4f6; }

    .wrap { max-width: 760px; margin: 16px auto 80px; padding: 0 16px; }
    .list { display:grid; gap: 14px; }
    .card { background: var(--card); border:1px solid rgba(255,255,255,.08); border-radius: 16px; overflow:hidden; }
    .head { padding: 14px 16px 6px; }
    .title { font-weight: 700; font-size: 18px; line-height:1.25; margin:0 0 4px; }
    .meta { color: var(--muted); font-size: 12px; display:flex; gap:10px; flex-wrap:wrap; }
    .media { display:block; position: relative; background:#08090c; }
    .media img, .media video { width:100%; height:auto; display:block; max-height: 75vh; object-fit: contain; background:#08090c; }
    .content { padding: 10px 16px 14px; display:grid; gap: 8px; }
    .actions { display:flex; gap: 10px; }
    .actions a { font-size: 13px; color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 10px; border:1px solid rgba(255,255,255,.1); }
    .actions a:hover { color: var(--text); border-color: rgba(255,255,255,.2); }
    .active{ border-color: rgba(0,140,255,.6) !important; color: #e8eaf2 !important }
    /* --- Mobile tweaks --- */
    @media (max-width: 680px) {
      header { padding: 10px 12px; }
      .bar { grid-template-columns: 1fr 1fr; gap:8px; }
      /* Make first two controls full-width on phones */
      .bar > div:nth-child(1), /* Subreddits */
      .bar > div:nth-child(2)  /* My subs */ { grid-column: 1 / -1; }
      .bar > div:nth-last-child(1) { grid-column: 1 / -1; } /* API key full width */
      .wrap { max-width: 100%; margin: 10px auto 64px; padding: 0 10px; }
      .card { border-radius: 12px; }
      .head { padding: 12px 12px 6px; }
      .title { font-size: 16px; }
      .media img, .media video { max-height: 60vh; }
      .content { padding: 8px 12px 12px; }
      .actions a { padding: 10px 12px; line-height: 1.2; } /* bigger tap targets */
      label { font-size: 11px; }
      input, select, button { font-size: 14px; }
    }

    /* Make taps feel nicer on mobile */
    * { -webkit-tap-highlight-color: transparent; }
  </style>
<header>
  <div class="hdr">
    <div class="title">Filters</div>
    <button id="toggleFilters" aria-expanded="true">Hide</button>
  </div>
  <div class="bar">
    <div>
      <label>Subreddits (e.g. programming+javascript or "best")</label>
      <input id="sub" value="${defaultSubs}" placeholder="best">
    </div>
    <div>
      <label>My subs</label>
      <select id="mysubs"><option value="">Loading…</option></select>
    </div>
    <div>
      <label>Limit</label>
      <input id="limit" type="number" min="10" max="100" value="${defaultLimit}">
    </div>
    <div>
      <label>Min upvotes</label>
      <input id="min" type="number" min="0" value="0">
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
      <label>Top window</label>
      <select id="t">
        <option>hour</option><option selected>day</option><option>week</option>
        <option>month</option><option>year</option><option>all</option>
      </select>
    </div>
    <div>
      <button id="go">Fetch</button>
    </div>
    <div>
      <label>API key</label>
      <input id="apiKey" type="password" placeholder="enter once" autocomplete="off">
    </div>
  </div>
</header>
<div class="wrap">
  <div id="list" class="list"></div>
</div>
<script>
// API key helpers: persist in localStorage, pick up ?key=, clean URL, and always send via header and query string
const STORAGE_KEY = 'my_reddit_api_key';
function getKey(){ return localStorage.getItem(STORAGE_KEY) || ''; }
function setKey(v){ if(v) localStorage.setItem(STORAGE_KEY, v); else localStorage.removeItem(STORAGE_KEY); }

// Pick up ?key= on first load, persist it, and clean the URL
(function(){
  const qs = new URLSearchParams(location.search);
  const urlKey = qs.get('key');
  if (urlKey) {
    setKey(urlKey);
    try { history.replaceState(null, '', location.pathname + (location.hash||'')); } catch {}
  }
})();

const apiKeyInput = document.getElementById('apiKey');
if (apiKeyInput) {
  apiKeyInput.value = getKey();
  apiKeyInput.addEventListener('change', ()=> setKey(apiKeyInput.value.trim()));
}

async function apiFetch(path, opts={}){
  const key = getKey();
  const headers = Object.assign({}, opts.headers || {}, { 'x-api-key': key });
  // Also append ?key= for good measure in case of CORS proxies or caches
  const hasQuery = path.includes('?');
  const withKey = key ? (path + (hasQuery ? '&' : '?') + 'key=' + encodeURIComponent(key)) : path;
  return fetch(withKey, Object.assign({}, opts, { headers }));
}

// Load my subs for dropdown
async function loadMySubs(){
  try{
    const res = await apiFetch('/api/mysubs');
    if(!res.ok){ throw new Error('HTTP '+res.status); }
    const data = await res.json();
    const sel = document.getElementById('mysubs');
    if(!sel) return;
    sel.innerHTML = '';
    const def = document.createElement('option'); def.value=''; def.textContent='— choose —'; sel.appendChild(def);
    (data.subs||[]).forEach((s)=>{ const o=document.createElement('option'); o.value=s; o.textContent='r/'+s; sel.appendChild(o); });
    sel.addEventListener('change', ()=>{
      const v = sel.value.trim();
      if(!v) return;
      const sub = document.getElementById('sub');
      if(sub){ sub.value = v; }
    });
  }catch(e){
    const sel = document.getElementById('mysubs');
    if(sel){ sel.innerHTML=''; const o=document.createElement('option'); o.value=''; o.textContent='(failed to load)'; sel.appendChild(o); }
  }
}

const $ = (s)=>document.querySelector(s);
const ago = (ts)=>{const d=(Date.now()/1000-ts); const h=Math.floor(d/3600); if(h<1){const m=Math.max(1,Math.floor(d/60)); return m+'m';} if(h<48){return h+'h'} return Math.floor(h/24)+'d'}

const headerEl = document.querySelector('header');
const toggleBtn = document.getElementById('toggleFilters');
function setCollapsed(collapsed){
  if(!headerEl || !toggleBtn) return;
  headerEl.classList.toggle('collapsed', collapsed);
  toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
}
if (window.innerWidth <= 680) setCollapsed(true); // start collapsed on small screens
if (toggleBtn) toggleBtn.addEventListener('click', ()=> setCollapsed(!headerEl.classList.contains('collapsed')));

async function run(){
  const sub = $('#sub').value.trim();
  const limit = $('#limit').value; const min=$('#min').value; const sort=$('#sort').value; const t=$('#t').value;
  const params=new URLSearchParams({sub,limit,min,sort,t});
  setCollapsed(true);
  const res=await apiFetch('/api/feed?'+params.toString());
  const data=await res.json();
  const list=$('#list'); list.innerHTML='';

  for(const p of data){
    const card=document.createElement('div'); card.className='card';

    // header
    const head=document.createElement('div'); head.className='head';
    const h=document.createElement('h2'); h.className='title';
    const a=document.createElement('a'); a.href=p.permalink; a.target='_blank'; a.rel='noopener'; a.textContent=p.title; h.appendChild(a);
    const meta=document.createElement('div'); meta.className='meta';
    meta.textContent = 'r/'+p.subreddit+' • u/'+p.author+' • '+p.ups+' upvotes • '+p.comments+' comments • '+ago(p.created_utc)+' ago';
    head.appendChild(h); head.appendChild(meta); card.appendChild(head);

    // media
    if(p.video){
      const media=document.createElement('div'); media.className='media';
      const v=document.createElement('video'); v.src=p.video; v.controls=true; v.playsInline=true; media.appendChild(v); card.appendChild(media);
    } else if(p.image){
      const media=document.createElement('div'); media.className='media';
      const img=document.createElement('img'); img.src=p.image; img.loading='lazy'; media.appendChild(img); card.appendChild(media);
    }

    // body
    const body=document.createElement('div'); body.className='content';
    if(p.is_self && p.selftext){
      const text=document.createElement('div');
      text.style.whiteSpace='pre-wrap'; text.style.color='var(--muted)';
      text.textContent = p.selftext.length>600 ? p.selftext.slice(0,600)+'…' : p.selftext;
      body.appendChild(text);
    }

    const actions=document.createElement('div'); actions.className='actions';
    const open=document.createElement('a'); open.href=p.url; open.target='_blank'; open.rel='noopener'; open.textContent='Open link ('+(p.domain||'')+')';
    const comments=document.createElement('a'); comments.href='/post?id='+p.id; comments.textContent='Comments';

    // Vote controls
    const up=document.createElement('a'); up.href='#'; up.textContent='▲ Upvote';
    const un=document.createElement('a'); un.href='#'; un.textContent='⟲ Unvote';
    const down=document.createElement('a'); down.href='#'; down.textContent='▼ Downvote';
    function syncVote(){
      up.classList.toggle('active', p.likes === true);
      un.classList.toggle('active', p.likes === null || p.likes === undefined);
      down.classList.toggle('active', p.likes === false);
    }
    syncVote();

    async function vote(dir){
      try{
        const fullname = p.fullname ? p.fullname : ('t3_'+p.id);
        const r = await apiFetch('/api/vote',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: fullname, dir })});
        if(!r.ok){ const t = await r.text(); alert('Vote failed: '+t); return; }
        // optimistic UI: adjust ups
        if(dir===1) p.ups += 1; else if(dir===-1) p.ups = Math.max(0, p.ups-1);
        meta.textContent = 'r/'+p.subreddit+' • u/'+p.author+' • '+p.ups+' upvotes • '+p.comments+' comments • '+ago(p.created_utc)+' ago';
        p.likes = (dir===1) ? true : (dir===-1) ? false : null; syncVote();
      }catch(e){ alert('Vote error: '+e); }
    }
    up.addEventListener('click', (e)=>{e.preventDefault(); vote(1);});
    un.addEventListener('click', (e)=>{e.preventDefault(); vote(0);});
    down.addEventListener('click', (e)=>{e.preventDefault(); vote(-1);});

    actions.appendChild(open);
    actions.appendChild(comments);
    actions.appendChild(up);
    actions.appendChild(un);
    actions.appendChild(down);
    body.appendChild(actions);

    card.appendChild(body);
    list.appendChild(card);
  }
}
$('#go').addEventListener('click', run);
loadMySubs();
run();
</script>
</html>`;
}

function simplifyCommentsListing(listing: any) {
  // listing is an array: [postListing, commentsListing]
  const postData = listing?.[0]?.data?.children?.[0]?.data || {};
  const now = Date.now() / 1000;

  // Build media similar to feed
  let image: string | null = null;
  if (postData?.preview?.images?.[0]?.source?.url) {
    image = postData.preview.images[0].source.url.replace(/&amp;/g, '&');
  } else if (postData?.url && /(jpg|jpeg|png|gif|webp)$/i.test(postData.url)) {
    image = postData.url;
  }
  let video: string | null = null;
  if (postData?.secure_media?.reddit_video?.fallback_url) {
    video = postData.secure_media.reddit_video.fallback_url;
  }

  const post = {
    id: postData.id,
    fullname: postData.name,
    title: postData.title,
    subreddit: postData.subreddit,
    author: postData.author,
    ups: postData.ups,
    likes: postData.likes,
    comments: postData.num_comments,
    created_utc: postData.created_utc,
    permalink: `https://reddit.com${postData.permalink || ''}`,
    url: 'url_overridden_by_dest' in postData ? postData.url_overridden_by_dest : postData.url,
    is_self: !!postData.is_self,
    selftext: postData.is_self ? (postData.selftext || '') : '',
    image,
    video,
  };

  const commentsRoot = listing?.[1]?.data?.children || [];
  const comments: any[] = [];

  function walk(node: any, depth: number) {
    if (!node || node.kind !== 't1') return; // comment kind
    const d = node.data || {};
    comments.push({
      id: d.id,
      fullname: d.name || ('t1_'+d.id),
      author: d.author,
      body: d.body || '',
      ups: d.ups,
      likes: d.likes,
      score: d.score,
      created_utc: d.created_utc,
      depth,
    });
    const replies = d.replies?.data?.children || [];
    for (const r of replies) walk(r, depth + 1);
  }

  for (const c of commentsRoot) walk(c, 0);

  return { post, comments };
}

function renderPostPage(env: Env, id: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Post — ${id}</title>
  <style>
    :root { --bg: #0b0b0e; --card:#111217; --muted:#8b8ea1; --text:#e8eaf2; }
    @media (prefers-color-scheme: light) { :root { --bg:#fff; --card:#fafafa; --muted:#667085; --text:#111; }}
    body{margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
    a{color:#8ab4ff;}
    header{position:sticky;top:0;background:rgba(15,15,20,.85);backdrop-filter:blur(8px);border-bottom:1px solid rgba(255,255,255,.06);padding:10px 14px}
    .wrap{max-width:760px;margin:12px auto 80px;padding:0 16px}
    .card{background:var(--card);border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden;margin-bottom:14px}
    .head{padding:14px 16px 10px}
    .title{margin:0 0 6px;font-weight:700;font-size:20px}
    .meta{color:var(--muted);font-size:12px}
    .media img,.media video{width:100%;height:auto;display:block;max-height:75vh;object-fit:contain;background:#08090c}
    .content{padding:10px 16px}
    .cmts{display:grid;gap:8px}
    .c{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px 12px;background:var(--card)}
    .btn{font-size:12px;color:var(--muted);text-decoration:none;padding:4px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.1);margin-right:6px}
    .btn.active{ border-color: rgba(0,140,255,.6); color: #e8eaf2 }
    .composer{border:1px solid #ddd;border-radius:12px;padding:10px 12px;background:var(--card);margin:12px 0}
    .composer textarea{width:100%;min-height:90px;padding:8px;border-radius:8px;border:1px solid #ccc;background:#fff;color:#000;}
    .composer .row{display:flex;gap:8px;margin-top:8px}
    .smallbtn{font-size:12px;color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.1)}
    /* --- Mobile tweaks --- */
    @media (max-width: 680px) {
      header{ padding:8px 10px; }
      .wrap{ max-width:100%; margin:8px auto 64px; padding:0 10px; }
      .card{ border-radius:12px; }
      .head{ padding:12px 12px 8px; }
      .title{ font-size:18px; }
      .media img,.media video{ max-height:60vh; }
      .content{ padding:8px 12px; }
      .btn, .smallbtn{ padding:8px 10px; } /* bigger tap targets */
      .composer{ padding:8px 10px; }
      .composer textarea{ min-height:80px; font-size:14px; }
      .c{ padding:8px 10px; }
    }
  </style>
<header><a href="/" style="text-decoration:none;color:inherit">← Back</a></header>
<div class="wrap">
  <div id="post" class="card"><div class="head"><h1 class="title">Loading…</h1><div class="meta"></div></div></div>
  <div class="composer" id="composer">
    <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Add a comment</div>
    <textarea id="composeText" placeholder="Write something thoughtful…"></textarea>
    <div class="row">
      <a href="#" class="smallbtn" id="composeSubmit">Comment</a>
    </div>
  </div>
  <div class="cmts" id="cmts"></div>
</div>
<script>
(async function(){
  // API key helpers: persist in localStorage, pick up ?key=, clean URL, and always send via header and query string
  const STORAGE_KEY = 'my_reddit_api_key';
  function getKey(){ return localStorage.getItem(STORAGE_KEY) || ''; }
  function setKey(v){ if(v) localStorage.setItem(STORAGE_KEY, v); else localStorage.removeItem(STORAGE_KEY); }
  // Pick up ?key= on first load
  (function(){
    const qs = new URLSearchParams(location.search);
    const urlKey = qs.get('key');
    if (urlKey) {
      setKey(urlKey);
      try { history.replaceState(null, '', location.pathname + (location.hash||'')); } catch {}
    }
  })();
  async function apiFetch(path, opts={}){
    const key = getKey();
    const headers = Object.assign({}, opts.headers || {}, { 'x-api-key': key });
    const hasQuery = path.includes('?');
    const withKey = key ? (path + (hasQuery ? '&' : '?') + 'key=' + encodeURIComponent(key)) : path;
    return fetch(withKey, Object.assign({}, opts, { headers }));
  }

  const id = ${JSON.stringify(id)};
  const res = await apiFetch('/api/comments?id='+encodeURIComponent(id));
  const {post, comments} = await res.json();

  const postEl = document.getElementById('post');
  const head = postEl.querySelector('.head');
  head.querySelector('.title').textContent = post.title;
  head.querySelector('.meta').textContent = 'r/'+post.subreddit+' • u/'+post.author+' • '+post.ups+' upvotes • '+post.comments+' comments';

  if (post.video) {
    const media=document.createElement('div'); media.className='media';
    const v=document.createElement('video'); v.src=post.video; v.controls=true; v.playsInline=true; media.appendChild(v); postEl.appendChild(media);
  } else if (post.image) {
    const media=document.createElement('div'); media.className='media';
    const img=document.createElement('img'); img.src=post.image; img.loading='lazy'; media.appendChild(img); postEl.appendChild(media);
  }

  if (post.is_self && post.selftext) {
    const body=document.createElement('div'); body.className='content';
    const t=document.createElement('div'); t.style.whiteSpace='pre-wrap'; t.textContent=post.selftext; body.appendChild(t); postEl.appendChild(body);
  }

  // Post vote actions
  const actions=document.createElement('div'); actions.className='content';
  const aUp=document.createElement('a'); aUp.className='btn'; aUp.href='#'; aUp.textContent='▲ Upvote';
  const aUn=document.createElement('a'); aUn.className='btn'; aUn.href='#'; aUn.textContent='⟲ Unvote';
  const aDown=document.createElement('a'); aDown.className='btn'; aDown.href='#'; aDown.textContent='▼ Downvote';
  actions.appendChild(aUp); actions.appendChild(aUn); actions.appendChild(aDown); postEl.appendChild(actions);
  function syncPostVote(){
    aUp.classList.toggle('active', post.likes === true);
    aUn.classList.toggle('active', post.likes === null || post.likes === undefined);
    aDown.classList.toggle('active', post.likes === false);
  }
  syncPostVote();
  async function votePost(dir){
    const fullname = post.fullname ? post.fullname : ('t3_'+post.id);
    const r = await apiFetch('/api/vote',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: fullname, dir })});
    if(!r.ok){ alert('Vote failed'); return; }
    post.likes = (dir===1) ? true : (dir===-1) ? false : null; syncPostVote();
  }
  aUp.addEventListener('click', (e)=>{e.preventDefault(); votePost(1)});
  aUn.addEventListener('click', (e)=>{e.preventDefault(); votePost(0)});
  aDown.addEventListener('click', (e)=>{e.preventDefault(); votePost(-1)});

  // Top-level composer submit
  const composeBtn = document.getElementById('composeSubmit');
  const composeText = document.getElementById('composeText');
  composeBtn.addEventListener('click', async (e)=>{
    e.preventDefault();
    const text = (composeText.value||'').trim();
    if(!text) return;
    const r = await apiFetch('/api/comment', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ parent: post.fullname || ('t3_'+post.id), text }) });
    if(!r.ok){ alert('Comment failed'); return; }
    composeText.value='';
    // Optimistically add to UI as depth 0
    addComment({ id: 'temp_'+Date.now(), fullname: null, author: 'you', body: text, ups: 1, likes: true, score: 1, created_utc: Math.floor(Date.now()/1000), depth: 0 });
  });

  const cmts = document.getElementById('cmts');
  function addComment(c){
    const div = document.createElement('div');
    div.className = 'c';
    div.style.marginLeft = (c.depth * 14) + 'px';

    const who = document.createElement('div'); who.style.color = '#8b8ea1'; who.style.fontSize='12px';
    who.textContent = 'u/'+c.author+' • '+c.ups+' upvotes';
    const body = document.createElement('div'); body.style.whiteSpace='pre-wrap'; body.textContent = c.body;
    div.appendChild(who); div.appendChild(body);

    // Vote controls (reuse existing pattern)
    const controls = document.createElement('div');
    controls.style.marginTop = '6px';
    const cUp=document.createElement('a'); cUp.className='btn'; cUp.href='#'; cUp.textContent='▲ Upvote';
    const cUn=document.createElement('a'); cUn.className='btn'; cUn.href='#'; cUn.textContent='⟲ Unvote';
    const cDown=document.createElement('a'); cDown.className='btn'; cDown.href='#'; cDown.textContent='▼ Downvote';
    controls.appendChild(cUp); controls.appendChild(cUn); controls.appendChild(cDown);

    function syncC(){
      cUp.classList.toggle('active', c.likes === true);
      cUn.classList.toggle('active', c.likes === null || c.likes === undefined);
      cDown.classList.toggle('active', c.likes === false);
    }
    syncC();
    async function voteC(dir){
      const r = await apiFetch('/api/vote',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: c.fullname || ('t1_'+c.id), dir })});
      if(!r.ok){ alert('Vote failed'); return; }
      c.likes = (dir===1) ? true : (dir===-1) ? false : null; syncC();
    }
    cUp.addEventListener('click', (e)=>{e.preventDefault(); voteC(1)});
    cUn.addEventListener('click', (e)=>{e.preventDefault(); voteC(0)});
    cDown.addEventListener('click', (e)=>{e.preventDefault(); voteC(-1)});

    // Inline reply composer
    const replyBar = document.createElement('div');
    replyBar.style.marginTop = '6px';
    const replyBtn = document.createElement('a'); replyBtn.className='smallbtn'; replyBtn.href='#'; replyBtn.textContent='Reply';
    replyBar.appendChild(replyBtn);

    const replyBox = document.createElement('div'); replyBox.className='composer'; replyBox.style.display='none';
    const ta = document.createElement('textarea'); ta.placeholder = 'Write a reply…';
    const row = document.createElement('div'); row.className='row';
    const send = document.createElement('a'); send.className='smallbtn'; send.href='#'; send.textContent='Send';
    row.appendChild(send);
    replyBox.appendChild(ta); replyBox.appendChild(row);

    replyBtn.addEventListener('click', (e)=>{ e.preventDefault(); replyBox.style.display = (replyBox.style.display==='none'?'block':'none'); });
    send.addEventListener('click', async (e)=>{
      e.preventDefault();
      const text = (ta.value||'').trim(); if(!text) return;
      const r = await apiFetch('/api/comment', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ parent: c.fullname || ('t1_'+c.id), text }) });
      if(!r.ok){ alert('Reply failed'); return; }
      ta.value=''; replyBox.style.display='none';
      // Optimistically add child comment (depth + 1)
      addComment({ id: 'temp_'+Date.now(), fullname: null, author: 'you', body: text, ups: 1, likes: true, score: 1, created_utc: Math.floor(Date.now()/1000), depth: (c.depth||0)+1 });
    });

    div.appendChild(controls);
    div.appendChild(replyBar);
    div.appendChild(replyBox);
    cmts.appendChild(div);
  }
  for (const c of comments) addComment(c);
})();
</script>
</html>`;
}
