# Spotify Playlist Sorter

A Cloudflare Worker application that helps you organize your Spotify Liked Songs into playlists with a drag-and-drop interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)

## Features

- 🎵 **Drag & Drop**: Easily drag songs from Your Liked playlist to any of your playlists
- ✅ **Bulk Operations**: Select multiple songs and move them all at once
- 🎧 **Song Previews**: Listen to 10-second previews before sorting
- 📊 **Analytics Dashboard**: View your top artists, tracks, genres, and listening statistics

## Prerequisites

To deploy your own instance of this application, you'll need:

1. A [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. A [Spotify Developer account](https://developer.spotify.com/dashboard)
3. Node.js installed on your computer
4. Wrangler CLI (`npm install -g wrangler`)

## Setup Instructions

### 1. Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create app"
3. Fill in the app details:
   - **App name**: Spotify Playlist Sorter (or your choice)
   - **App description**: Personal playlist organization tool
   - **Website**: Leave blank
   - **Redirect URI**: Will be added after deployment
4. Click "Save"
5. Note your **Client ID** and **Client Secret**

### 2. Clone this Repository

```bash
git clone https://github.com/abelinkinbio/spotify-playlist-sorter.git
cd spotify-playlist-sorter
```

### 3. Configure Wrangler

1. Login to Cloudflare:
   ```bash
   wrangler login
   ```

2. Create a KV namespace:
   ```bash
   wrangler kv namespace create SPOTIFY_TOKENS
   ```

3. Update `wrangler.toml` with:
   - Your KV namespace ID
   - Your worker subdomain (after first deployment)

### 4. Deploy the Worker

1. Deploy to get your Worker URL:
   ```bash
   wrangler deploy
   ```

2. Update `wrangler.toml` with your Worker URL:
   ```toml
   [vars]
   SPOTIFY_REDIRECT_URI = "https://spotify-playlist-sorter.YOUR-SUBDOMAIN.workers.dev/callback"
   ```

3. Add this same URL to your Spotify app's redirect URIs

### 5. Add Secrets

```bash
# Add your Spotify Client ID
wrangler secret put SPOTIFY_CLIENT_ID

# Add your Spotify Client Secret
wrangler secret put SPOTIFY_CLIENT_SECRET
```

### 6. Final Deployment

```bash
wrangler deploy
```

Visit your Worker URL and start organizing your music

## Project Structure

```
spotify-playlist-sorter/
├── index.js        # Main Worker code
├── wrangler.toml   # Cloudflare Worker configuration
└── README.md       # This file
```

## Configuration

The `wrangler.toml` file contains:
- Worker name and entry point
- KV namespace binding for session storage
- Environment variables for the redirect URI

## How It Works

1. **OAuth Flow**: Users authenticate with Spotify
2. **Session Management**: Tokens stored in Cloudflare KV
3. **API Proxy**: Worker proxies all Spotify API requests
4. **Frontend**: Single-page application served by the Worker
5. **Access**: (Optional) Secured by Cloudflare Access

## Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Uses [Spotify Web API](https://developer.spotify.com/documentation/web-api/)