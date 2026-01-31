# Bosworth v3 - Spotify Playlist Sorter

A listening party experience for organizing your Spotify music library. Built with Cloudflare Workers.

![Blueprint Design](https://img.shields.io/badge/Design-Blueprint-blue)
![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange)

## Features

- **🎧 Listening Party Mode** - Preview tracks and sort them with auto-play
- **⚡ Auto-Remove** - Songs automatically leave your Liked playlist when sorted
- **📊 AI Insights** - Get personalized analysis of your listening habits
- **⏱ Session Tracking** - Count-up timer with session summaries
- **🎨 Blueprint UI** - Technical drawing aesthetic with IBM Plex Mono

## Tech Stack

- **Cloudflare Workers** - Serverless compute
- **Cloudflare KV** - OAuth token storage
- **Cloudflare D1** - Session history database
- **Cloudflare Workers AI** - Listening insights generation
- **Spotify Web API** - Music data and playlist management

## Prerequisites

1. [Node.js](https://nodejs.org) installed
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
3. A [Spotify Developer](https://developer.spotify.com/dashboard) account with an app created

## Setup

### 1. Clone and Install

```bash
cd bosworth-v3
npm install -g wrangler  # If not already installed
wrangler login           # Authenticate with Cloudflare
```

### 2. Configure Spotify App

In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard):

1. Select your app (or create one)
2. Go to **Settings** → **Edit Settings**
3. Add a **Redirect URI**:
   ```
   https://spotify-playlist-sorter.YOUR_SUBDOMAIN.workers.dev/callback
   ```
4. Save your changes
5. Copy your **Client ID** and **Client Secret**

### 3. Set Secrets

```bash
wrangler secret put SPOTIFY_CLIENT_ID
# Paste your Client ID when prompted

wrangler secret put SPOTIFY_CLIENT_SECRET
# Paste your Client Secret when prompted

wrangler secret put SPOTIFY_REDIRECT_URI
# Enter: https://spotify-playlist-sorter.YOUR_SUBDOMAIN.workers.dev/callback
```

### 4. Deploy

```bash
wrangler deploy
```

Your app will be live at: `https://spotify-playlist-sorter.YOUR_SUBDOMAIN.workers.dev`

## Usage

### Listening Party

1. Visit your deployed URL
2. Click **Connect with Spotify**
3. Authorize the app
4. Start dragging songs from **Liked Songs** to your playlists
5. Songs auto-play on click for preview
6. Click **End Session** to see your summary

### Analytics

- View your top artists, tracks, and genres
- Filter by time period (4 weeks, 6 months, all time)
- Get AI-generated insights about your music taste
- See your session history

## Troubleshooting

### "Failed to remove from Liked Songs"

Make sure your Spotify app has the `user-library-modify` scope. You may need to re-authenticate.

### "Session expired"

Sessions last 24 hours. Simply log in again.

### Songs not appearing

The app loads 50 liked songs at a time. Click "Load More" to fetch additional songs.

## Local Development

```bash
wrangler dev
```

Note: OAuth won't work locally without a tunnel. Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or deploy to test authentication.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Cloudflare Worker                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐    │
│  │  OAuth  │   │  Proxy  │   │   AI    │   │ Session │    │
│  │  Flow   │   │ Spotify │   │Insights │   │ Storage │    │
│  └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘    │
│       │             │             │             │          │
│       ▼             ▼             ▼             ▼          │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐    │
│  │   KV    │   │ Spotify │   │ Workers │   │   D1    │    │
│  │ Storage │   │   API   │   │   AI    │   │Database │    │
│  └─────────┘   └─────────┘   └─────────┘   └─────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT
