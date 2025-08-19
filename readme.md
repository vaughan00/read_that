

# My Reddit Reader

A minimal personal Reddit client running on a Cloudflare Worker.  
It lets you browse your subscribed subreddits or any subreddit with your own filters and ranking logic, without Reddit’s built‑in algorithm.

## Features

- Authenticate via Reddit API (OAuth2)
- Fetch posts from your feed or specific subreddits
- Custom filtering and ranking of posts
- View comments inline (no need to go to reddit.com)
- Vote on posts and comments
- Post new comments
- Mobile‑friendly UI with collapsible filter bar
- “My subs” dropdown auto‑loads your subscribed subreddits
- API key protection for deployed Worker

## Getting Started

### Prerequisites
- Node.js and npm installed
- A Reddit app (created at [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps))
- Cloudflare account with `wrangler` CLI installed

### Setup

1. Clone this repo:
   ```bash
   git clone https://github.com/<your-username>/my-reddit-reader.git
   cd my-reddit-reader
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Add your Reddit app credentials to `.dev.vars` for local dev:
   ```
   CLIENT_ID=your_client_id
   CLIENT_SECRET=your_client_secret
   REDIRECT_URI=http://127.0.0.1:53123/callback
   USER_AGENT=my-reddit-worker/0.1 by u/your_username
   REFRESH_TOKEN=your_refresh_token
   API_KEY=your_api_key   # optional for local, required for prod
   ```

4. Run locally:
   ```bash
   npm run dev
   ```
   Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

5. Deploy to Cloudflare:
   ```bash
   npx wrangler deploy
   ```
   Then set your API key on Cloudflare:
   ```bash
   npx wrangler secret put API_KEY
   ```

6. First load (remote):
   ```
   https://<your-worker>.workers.dev/?key=<API_KEY>
   ```

## Notes

- Ensure your Reddit app is of type “Installed app” with redirect URI set to `http://127.0.0.1:53123/callback`.
- You may need to regenerate a new `refresh_token` when deploying to a fresh environment.