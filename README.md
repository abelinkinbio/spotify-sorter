# 🎧 bosworth

Your Liked Songs playlist feels like a giant to-do list. You know you should sort them, but actually doing it feels like a chore. This tool lets you play them directly in the browser via Spotify's Web Playback SDK. You hear each song one by one and sort them into the right playlist with a single click. Like a productive jam session.

## How It Works

1. Connect your Spotify Premium account
2. Songs from your Liked library auto-play in the browser
3. Tap a playlist to sort — or skip to move on
4. Sorted songs are removed from Liked Songs

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser                                    │
│  ┌────────────────┐  ┌───────────────────┐  │
│  │ Bosworth UI    │  │ Spotify Web       │  │
│  │ (card sorter)  │  │ Playback SDK      │  │
│  └───────┬────────┘  └───────┬───────────┘  │
│          │                   │              │
└──────────┼───────────────────┼──────────────┘
           │ /api/*            │ streaming
           ▼                   ▼
┌──────────────────┐  ┌─────────────────┐
│ Cloudflare       │  │ Spotify         │
│ Worker           │  │ Connect         │
│ (OAuth + proxy)  │  │ (audio)         │
│      │           │  └─────────────────┘
│      ▼           │
│ ┌──────────┐     │
│ │ KV Store │     │
│ │ (tokens) │     │
│ └──────────┘     │
└──────────────────┘
```

**Cloudflare Worker** — Runs at the edge (nearest data center to the user). Handles OAuth login, proxies Spotify API calls, and serves the UI. One file, no build step.

**Cloudflare KV** — A globally distributed key-value store. Stores OAuth session tokens so your browser stays logged in. Tokens auto-expire after 24 hours.

**Spotify Web Playback SDK** — Turns the browser tab into a Spotify Connect device. Full track playback, not 30-second previews. Requires Spotify Premium.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) installed
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Spotify Developer](https://developer.spotify.com/dashboard) app with **Web API** and **Web Playback SDK** enabled
- Spotify Premium subscription

### 1. Clone and install

```bash
git clone https://github.com/abelinkinbio/spotify-sorter.git
cd spotify-sorter
npm install -g wrangler    # if not already installed
npx wrangler login         # authenticate with Cloudflare
```

### 2. Create a KV namespace

```bash
npx wrangler kv namespace create SPOTIFY_TOKENS
```

This outputs a namespace ID. Copy `wrangler.toml.example` to `wrangler.toml` and paste in your ID:

```bash
cp wrangler.toml.example wrangler.toml
```

```toml
[[kv_namespaces]]
binding = "SPOTIFY_TOKENS"
id = "<paste your namespace ID here>"
```

Your `wrangler.toml` is gitignored so your resource IDs stay local.

### 3. Set secrets

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REDIRECT_URI
```

Your redirect URI should match what's registered in your Spotify Developer Dashboard, e.g. `https://your-worker.workers.dev/callback` or `https://your-custom-domain.com/callback`.

### 4. Configure Spotify

In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

- Add your redirect URI under **Redirect URIs**
- Ensure both **Web API** and **Web Playback SDK** are checked under **APIs used**

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. (Optional) Custom domain

If you want to serve from a custom domain instead of `*.workers.dev`, add a Custom Domain in the Cloudflare dashboard under **Workers & Pages → your worker → Settings → Domains & Routes**.

Remember to update your `SPOTIFY_REDIRECT_URI` secret and Spotify Dashboard to match the new domain.

## Updating

```bash
git add .
git commit -m "your message"
git push
npx wrangler deploy
```

## License

MIT
