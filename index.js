// =============================================================================
// BOSWORTH v4 — Spotify Playlist Sorter
// =============================================================================
// A focused tool: listen to your Liked Songs and sort them into playlists.
// Built on Cloudflare Workers with Spotify Web Playback SDK.
//
// Cloudflare Products Used:
//   - Workers: Runs this code at the edge (closest data center to the user)
//   - KV: Stores Spotify OAuth tokens (access + refresh) per session
//
// How it works:
//   1. User logs in via Spotify OAuth
//   2. Worker stores tokens in KV, sets a session cookie
//   3. The party page loads the Spotify Web Playback SDK
//   4. SDK turns the browser into a Spotify Connect device
//   5. Songs from Liked Songs play one at a time
//   6. User taps a playlist to sort the song, skip it, or keep it
//   7. Next song auto-plays. Repeat until inbox zero.
// =============================================================================

// --- Spotify OAuth URLs ---
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// --- OAuth Scopes ---
// Each scope grants permission to do something with the user's Spotify account.
// We only request what we need:
//   streaming              → Required for Web Playback SDK (play music in browser)
//   user-read-playback-state → Read what's currently playing
//   user-modify-playback-state → Transfer playback to our device, play tracks
//   user-read-private      → Get the user's profile info
//   user-library-read      → Read their Liked Songs
//   user-library-modify    → Remove songs from Liked Songs after sorting
//   playlist-read-private  → See their private playlists
//   playlist-modify-public → Add songs to public playlists
//   playlist-modify-private → Add songs to private playlists
const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-private',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');


// =============================================================================
// MAIN REQUEST HANDLER
// =============================================================================
// This is the entry point. Every request to the Worker hits this function.
// Cloudflare Workers use a "fetch" handler — think of it as a smart router
// that looks at the URL and decides what to do.
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- Page Routes ---
      if (path === '/')          return servePage(getHomePage());
      if (path === '/party')     return servePage(getPartyPage());

      // --- Auth Routes ---
      if (path === '/auth')      return handleAuth(env);
      if (path === '/callback')  return handleCallback(request, env);
      if (path === '/logout')    return handleLogout();

      // --- API Routes ---
      if (path.startsWith('/api/')) return handleAPI(request, env, path);

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Request error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};


// =============================================================================
// AUTHENTICATION
// =============================================================================
// Spotify uses OAuth 2.0 — a standardized way for apps to get permission to
// act on behalf of a user without ever seeing their password.
//
// The flow:
//   1. /auth → Redirect user to Spotify's login page
//   2. User approves → Spotify redirects to /callback with a code
//   3. /callback → Exchange code for access_token + refresh_token
//   4. Store tokens in KV, set a session cookie in the browser
//   5. User is now logged in. Cookie identifies their session.
// =============================================================================

function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    show_dialog: 'false',
  });
  return Response.redirect(`${SPOTIFY_AUTH_URL}?${params}`);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) return servePage(getErrorPage('Authorization denied: ' + error));
  if (!code)  return servePage(getErrorPage('No authorization code received'));

  // Exchange the authorization code for tokens
  const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Token exchange failed:', await tokenResponse.text());
    return servePage(getErrorPage('Failed to exchange authorization code'));
  }

  const tokens = await tokenResponse.json();

  // Generate a unique session ID and store tokens in KV
  // KV = Key-Value store. Think of it as a global dictionary.
  // Key: session ID → Value: JSON with tokens
  // expirationTtl: auto-delete after 24 hours (86400 seconds)
  const sessionId = crypto.randomUUID();
  await env.SPOTIFY_TOKENS.put(sessionId, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
  }), { expirationTtl: 86400 });

  // Set a cookie so the browser remembers which session it belongs to
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/party',
      'Set-Cookie': `bosworth_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'bosworth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}


// =============================================================================
// API HANDLER
// =============================================================================
// All /api/* requests come here. We validate the session, refresh tokens if
// needed, then either handle special endpoints or proxy to Spotify's API.
//
// Special endpoints:
//   /api/token → Returns the access token (needed by Web Playback SDK)
//
// Everything else:
//   /api/me/tracks → proxied to api.spotify.com/v1/me/tracks
//   /api/me/playlists → proxied to api.spotify.com/v1/me/playlists
//   etc.
// =============================================================================

async function handleAPI(request, env, path) {
  const sessionId = getSessionFromCookie(request);
  if (!sessionId) return jsonResponse({ error: 'Not authenticated' }, 401);

  const tokenData = await env.SPOTIFY_TOKENS.get(sessionId);
  if (!tokenData) return jsonResponse({ error: 'Session expired' }, 401);

  let tokens = JSON.parse(tokenData);

  // Refresh the access token if it's about to expire (within 60 seconds)
  if (Date.now() >= tokens.expires_at - 60000) {
    tokens = await refreshAccessToken(tokens.refresh_token, env);
    if (tokens) {
      await env.SPOTIFY_TOKENS.put(sessionId, JSON.stringify(tokens), { expirationTtl: 86400 });
    } else {
      return jsonResponse({ error: 'Failed to refresh token' }, 401);
    }
  }

  // Special endpoint: return the access token for the Web Playback SDK
  if (path === '/api/token') {
    return jsonResponse({ access_token: tokens.access_token });
  }

  // Everything else gets proxied to Spotify
  const spotifyPath = path.replace('/api', '');
  return proxyToSpotify(request, tokens.access_token, spotifyPath);
}

async function refreshAccessToken(refreshToken, env) {
  try {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (data.expires_in * 1000),
    };
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}

async function proxyToSpotify(request, accessToken, path) {
  const url = new URL(request.url);
  const spotifyUrl = `${SPOTIFY_API_BASE}${path}${url.search}`;
  const options = {
    method: request.method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };

  if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
    const body = await request.text();
    if (body) options.body = body;
  }

  const response = await fetch(spotifyUrl, options);
  const responseText = await response.text();
  return new Response(responseText, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}


// =============================================================================
// UTILITIES
// =============================================================================

function getSessionFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/bosworth_session=([^;]+)/);
  return match ? match[1] : null;
}

function servePage(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getErrorPage(message) {
  return `<!DOCTYPE html>
<html><head><title>Error — Bosworth</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  body { font-family: 'JetBrains Mono', monospace; background: #F5F0E8; color: #1A1A2E; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .box { border: 1px solid #C5D5E4; padding: 2rem; max-width: 400px; text-align: center; }
  a { color: #3B82F6; }
</style></head>
<body><div class="box"><h2>ERROR</h2><p>${message}</p><a href="/">← Back</a></div></body></html>`;
}


// =============================================================================
// LANDING PAGE
// =============================================================================

function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bosworth — Spotify Playlist Sorter</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #F5F0E8;
      --grid: #C5D5E4;
      --text: #1A1A2E;
      --muted: #6B7280;
      --accent-green: #1DB954;
      --accent-purple: #9B59FF;
      --accent-red: #FF3366;
    }

    body {
      font-family: 'JetBrains Mono', monospace;
      background-color: var(--bg);
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 20px 20px;
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      position: relative;
    }

    /* Blueprint margin annotations */
    .annotation {
      position: fixed;
      font-size: 0.6rem;
      color: var(--muted);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .annotation.tl { top: 1rem; left: 1rem; }
    .annotation.tr { top: 1rem; right: 1rem; }
    .annotation.bl { bottom: 1rem; left: 1rem; }
    .annotation.br { bottom: 1rem; right: 1rem; }

    .landing {
      text-align: center;
      max-width: 520px;
    }

    .logo {
      font-family: 'Press Start 2P', monospace;
      font-size: 2.5rem;
      letter-spacing: 4px;
      color: var(--text);
      margin-bottom: 0.75rem;
    }

    .version {
      display: inline-block;
      font-size: 0.6rem;
      padding: 0.15rem 0.5rem;
      border: 1px solid var(--grid);
      color: var(--muted);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 2rem;
    }

    .tagline {
      font-size: 0.85rem;
      color: var(--muted);
      line-height: 1.7;
      margin-bottom: 2.5rem;
    }

    .how-it-works {
      border: 1px solid var(--grid);
      padding: 1.5rem 1.25rem 1.25rem;
      margin-bottom: 2.5rem;
      position: relative;
      text-align: left;
    }

    .how-it-works .panel-label {
      position: absolute;
      top: -0.6em;
      left: 0.75rem;
      background: var(--bg);
      padding: 0 0.5rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }

    .step {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .step:last-child { margin-bottom: 0; }

    .step-num {
      font-size: 0.65rem;
      color: var(--accent-purple);
      flex-shrink: 0;
      width: 1.5rem;
      text-align: right;
    }

    .cta {
      display: inline-block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0.75rem 2rem;
      border: 1px solid var(--accent-green);
      background: var(--accent-green);
      color: white;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .cta:hover {
      background: transparent;
      color: var(--accent-green);
    }

    .req {
      margin-top: 1.5rem;
      font-size: 0.65rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="annotation tl">BOSWORTH.v4</div>
  <div class="annotation tr">SCALE 1:1</div>
  <div class="annotation bl">REV.04 / 2025</div>
  <div class="annotation br">SPOTIFY PLAYLIST SORTER</div>

  <div class="landing">
    <div class="logo">BOSWORTH</div>
    <div class="version">v4.0 — playlist sorter</div>
    <p class="tagline">
      Your liked songs are piling up. Bosworth plays them one by one
      and lets you sort each into the right playlist. Like a listening
      party for your music library.
    </p>

    <div class="how-it-works">
      <span class="panel-label">HOW IT WORKS</span>
      <div class="step"><span class="step-num">01</span> Connect your Spotify Premium account</div>
      <div class="step"><span class="step-num">02</span> Songs from your Liked library play automatically</div>
      <div class="step"><span class="step-num">03</span> Tap a playlist to sort — or skip to move on</div>
      <div class="step"><span class="step-num">04</span> Sorted songs are removed from Liked Songs</div>
    </div>

    <a href="/auth" class="cta">Connect Spotify</a>
    <p class="req">Requires Spotify Premium</p>
  </div>
</body>
</html>`;
}


// =============================================================================
// PARTY PAGE — The Main Interface
// =============================================================================

function getPartyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Listening Party — Bosworth</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>${getPartyStyles()}</style>
</head>
<body>

  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <a href="/" class="logo">BOSWORTH</a>
      <span class="tag">v4</span>
    </div>
    <div class="header-center" id="headerStats">
      <span class="stat-item" id="sortedStat">0 sorted</span>
      <span class="stat-divider">·</span>
      <span class="stat-item" id="skippedStat">0 skipped</span>
      <span class="stat-divider">·</span>
      <span class="stat-item" id="remainingStat">— remaining</span>
    </div>
    <div class="header-right">
      <a href="/logout" class="header-btn">LOGOUT</a>
    </div>
  </header>

  <!-- Main Content -->
  <main class="main">

    <!-- Status Bar -->
    <div class="status-bar" id="statusBar">
      <span class="status-dot"></span>
      <span class="status-text" id="statusText">Initializing...</span>
    </div>

    <!-- Song Card -->
    <div class="card-area">
      <div class="song-card" id="songCard">
        <span class="card-label">NOW PLAYING</span>

        <!-- Loading State -->
        <div class="card-loading" id="cardLoading">
          <div class="loading-text">Loading your music...</div>
        </div>

        <!-- Active State -->
        <div class="card-active" id="cardActive" style="display: none;">
          <div class="album-art-wrap">
            <img id="albumArt" class="album-art" src="" alt="Album art">
            <div class="art-border"></div>
          </div>
          <div class="song-details">
            <div class="song-name" id="songName">—</div>
            <div class="song-artist" id="songArtist">—</div>
            <div class="song-album" id="songAlbum">—</div>
          </div>

          <!-- Progress -->
          <div class="progress-wrap">
            <div class="progress-bar" id="progressBar">
              <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="progress-times">
              <span id="progressCurrent">0:00</span>
              <span id="progressTotal">0:00</span>
            </div>
          </div>

          <!-- Controls -->
          <div class="controls">
            <button class="ctrl-btn" id="prevBtn" title="Previous">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h2v12H3V2zm4 6l7-6v12L7 8z"/></svg>
            </button>
            <button class="ctrl-btn ctrl-play" id="playPauseBtn" title="Play / Pause">
              <svg id="playIcon" width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>
              <svg id="pauseIcon" width="20" height="20" viewBox="0 0 16 16" fill="currentColor" style="display:none;"><path d="M3 2h4v12H3V2zm6 0h4v12H9V2z"/></svg>
            </button>
            <button class="ctrl-btn" id="nextBtn" title="Skip">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11 2h2v12h-2V2zM2 2l7 6-7 6V2z"/></svg>
            </button>
          </div>
        </div>

        <!-- Empty State -->
        <div class="card-empty" id="cardEmpty" style="display: none;">
          <div class="empty-icon">✓</div>
          <div class="empty-title">All caught up</div>
          <div class="empty-text">No more liked songs to sort</div>
        </div>
      </div>

      <!-- Action Buttons (below card) -->
      <div class="action-buttons" id="actionButtons" style="display: none;">
        <button class="action-btn action-skip" id="skipBtn">
          SKIP
          <span class="action-hint">leave in liked, move on</span>
        </button>
        <button class="action-btn action-keep" id="keepBtn">
          KEEP & REMOVE
          <span class="action-hint">remove from liked, don't sort</span>
        </button>
      </div>
    </div>

    <!-- Playlists Panel -->
    <div class="playlists-panel" id="playlistsPanel">
      <div class="panel-header">
        <span class="panel-label-inline">SORT TO PLAYLIST</span>
        <input type="text" class="search-input" id="playlistSearch" placeholder="> search playlists...">
      </div>
      <div class="playlists-grid" id="playlistsGrid">
        <div class="loading-text">Loading playlists...</div>
      </div>
    </div>

  </main>

  <!-- Spotify Web Playback SDK -->
  <script src="https://sdk.scdn.co/spotify-player.js"></script>
  <script>${getPartyScript()}</script>
</body>
</html>`;
}


// =============================================================================
// PARTY PAGE STYLES
// =============================================================================

function getPartyStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #F5F0E8;
      --grid: #C5D5E4;
      --text: #1A1A2E;
      --muted: #6B7280;
      --accent-green: #1DB954;
      --accent-purple: #9B59FF;
      --accent-red: #FF3366;
      --accent-blue: #3B82F6;
      --accent-yellow: #FFE033;
    }

    body {
      font-family: 'JetBrains Mono', monospace;
      background-color: var(--bg);
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 20px 20px;
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ---- HEADER ---- */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--grid);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-left { display: flex; align-items: center; gap: 0.5rem; }
    .logo {
      font-family: 'Press Start 2P', monospace;
      font-size: 0.75rem;
      color: var(--text);
      text-decoration: none;
      letter-spacing: 2px;
    }
    .tag {
      font-size: 0.55rem;
      padding: 0.1rem 0.35rem;
      border: 1px solid var(--grid);
      color: var(--muted);
      letter-spacing: 0.1em;
    }
    .header-center {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.7rem;
      color: var(--muted);
    }
    .stat-divider { opacity: 0.4; }
    .header-btn {
      font-family: inherit;
      font-size: 0.65rem;
      padding: 0.35rem 0.75rem;
      border: 1px solid var(--grid);
      background: transparent;
      color: var(--muted);
      text-decoration: none;
      letter-spacing: 0.08em;
      transition: all 0.15s ease;
    }
    .header-btn:hover { border-color: var(--accent-red); color: var(--accent-red); }

    /* ---- STATUS BAR ---- */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1.25rem;
      font-size: 0.65rem;
      color: var(--muted);
      border-bottom: 1px solid var(--grid);
    }
    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent-yellow);
      animation: pulse 2s infinite;
    }
    .status-bar.connected .status-dot { background: var(--accent-green); animation: none; }
    .status-bar.error .status-dot { background: var(--accent-red); animation: none; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* ---- MAIN LAYOUT ---- */
    /* Side-by-side: card on left, playlists on right.
       Everything visible without scrolling. */
    .main {
      flex: 1;
      display: grid;
      grid-template-columns: 380px 1fr;
      grid-template-rows: auto 1fr;
      gap: 0;
      padding: 0;
      width: 100%;
      overflow: hidden; /* prevent page scroll — everything fits in viewport */
    }

    /* Status bar spans full width */
    .status-bar { grid-column: 1 / -1; }

    /* ---- SONG CARD ---- */
    .card-area {
      padding: 1rem 1.25rem;
      overflow-y: auto;
      border-right: 1px solid var(--grid);
    }

    .song-card {
      border: 1px solid var(--grid);
      padding: 1.25rem 1rem 1rem;
      position: relative;
      background: var(--bg);
    }
    .card-label {
      position: absolute;
      top: -0.6em;
      left: 0.75rem;
      background: var(--bg);
      padding: 0 0.5rem;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }

    .card-loading, .card-empty {
      text-align: center;
      padding: 3rem 1rem;
    }
    .loading-text {
      font-size: 0.75rem;
      color: var(--muted);
    }
    .empty-icon {
      font-size: 2rem;
      color: var(--accent-green);
      margin-bottom: 0.75rem;
    }
    .empty-title {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .empty-text {
      font-size: 0.75rem;
      color: var(--muted);
    }

    /* Album Art */
    .album-art-wrap {
      position: relative;
      width: 100%;
      max-width: 280px;
      aspect-ratio: 1;
      margin: 0 auto 1rem;
      overflow: hidden;
    }
    .album-art {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .art-border {
      position: absolute;
      inset: 0;
      border: 1px solid var(--grid);
      pointer-events: none;
    }

    /* Song Details */
    .song-details { margin-bottom: 0.75rem; }
    .song-name {
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 0.2rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .song-artist {
      font-size: 0.8rem;
      color: var(--accent-purple);
      margin-bottom: 0.15rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .song-album {
      font-size: 0.7rem;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Progress */
    .progress-wrap { margin-bottom: 0.75rem; }
    .progress-bar {
      height: 3px;
      background: var(--grid);
      cursor: pointer;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent-green);
      width: 0%;
      transition: width 0.3s linear;
    }
    .progress-times {
      display: flex;
      justify-content: space-between;
      font-size: 0.6rem;
      color: var(--muted);
      margin-top: 0.35rem;
    }

    /* Controls */
    .controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }
    .ctrl-btn {
      width: 36px; height: 36px;
      border: 1px solid var(--grid);
      background: transparent;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ctrl-btn:hover {
      border-color: var(--text);
    }
    .ctrl-play {
      width: 48px; height: 48px;
      border-color: var(--accent-green);
      color: var(--accent-green);
    }
    .ctrl-play:hover {
      background: var(--accent-green);
      color: white;
    }

    /* ---- ACTION BUTTONS ---- */
    .action-buttons {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.6rem;
    }
    .action-btn {
      flex: 1;
      font-family: inherit;
      font-size: 0.7rem;
      font-weight: 500;
      padding: 0.6rem 0.5rem;
      border: 1px solid var(--grid);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      transition: all 0.15s ease;
      text-align: center;
    }
    .action-hint {
      display: block;
      font-size: 0.55rem;
      font-weight: 300;
      color: var(--muted);
      margin-top: 0.2rem;
      text-transform: none;
      letter-spacing: 0;
    }
    .action-skip:hover {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
    }
    .action-keep:hover {
      border-color: var(--accent-red);
      color: var(--accent-red);
    }

    /* ---- PLAYLISTS PANEL ---- */
    .playlists-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--grid);
      gap: 0.75rem;
      flex-shrink: 0;
    }
    .panel-label-inline {
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      flex-shrink: 0;
    }
    .search-input {
      font-family: inherit;
      font-size: 0.7rem;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--grid);
      background: transparent;
      color: var(--text);
      flex: 1;
      max-width: 220px;
    }
    .search-input::placeholder { color: var(--muted); }
    .search-input:focus { outline: none; border-color: var(--accent-purple); }

    .playlists-grid {
      padding: 0.75rem;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 0.5rem;
      flex: 1;
      overflow-y: auto;
      align-content: start;
    }

    .playlist-btn {
      font-family: inherit;
      font-size: 0.7rem;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--grid);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .playlist-btn:hover {
      border-color: var(--accent-green);
      color: var(--accent-green);
    }
    .playlist-btn.sorting {
      background: var(--accent-green);
      border-color: var(--accent-green);
      color: white;
      pointer-events: none;
    }
    .playlist-btn .track-count {
      font-size: 0.55rem;
      color: var(--muted);
      margin-left: 0.25rem;
    }
    .playlist-btn:hover .track-count {
      color: var(--accent-green);
      opacity: 0.7;
    }

    /* ---- SCROLLBAR ---- */
    .playlists-grid::-webkit-scrollbar { width: 4px; }
    .playlists-grid::-webkit-scrollbar-track { background: transparent; }
    .playlists-grid::-webkit-scrollbar-thumb { background: var(--grid); }

    /* ---- ANIMATIONS ---- */
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .card-active { animation: cardIn 0.25s ease; }

    /* ---- RESPONSIVE ---- */
    @media (max-width: 768px) {
      .header-center { display: none; }
      .main {
        grid-template-columns: 1fr;
        grid-template-rows: auto auto 1fr;
        overflow-y: auto;
      }
      .card-area {
        border-right: none;
        border-bottom: 1px solid var(--grid);
      }
      .playlists-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
    }
  `;
}


// =============================================================================
// PARTY PAGE SCRIPT
// =============================================================================

function getPartyScript() {
  return `
    // =====================================================================
    // STATE
    // =====================================================================
    let songs = [];              // Array of liked song items from Spotify
    let playlists = [];          // Array of user playlists
    let currentIndex = 0;        // Which song we're showing
    let songsSorted = 0;
    let songsSkipped = 0;
    let totalLoaded = 0;
    let player = null;           // Spotify Web Playback SDK player instance
    let deviceId = null;         // The device ID for our browser player
    let isPlaying = false;
    let isSorting = false;       // Lock to prevent double-taps
    let accessToken = null;
    let progressInterval = null;

    // =====================================================================
    // INIT
    // =====================================================================
    async function init() {
      setStatus('Checking authentication...');

      // Verify we're logged in
      const authCheck = await fetch('/api/me');
      if (!authCheck.ok) {
        window.location.href = '/';
        return;
      }

      // Get the access token (needed for the Web Playback SDK)
      const tokenRes = await fetch('/api/token');
      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;

      setStatus('Loading your music...');
      await Promise.all([loadSongs(), loadPlaylists()]);

      // The SDK script tag loads asynchronously. When it's ready,
      // it calls window.onSpotifyWebPlaybackSDKReady automatically.
      // If the SDK already loaded before our init ran, we call it ourselves.
      if (window.Spotify) {
        initPlayer();
      }
    }

    // =====================================================================
    // SPOTIFY WEB PLAYBACK SDK
    // =====================================================================
    // The Web Playback SDK turns your browser tab into a "Spotify Connect"
    // device — the same way Spotify sees your phone, desktop app, or smart
    // speaker. Once connected, we can play full tracks right here.
    //
    // Key concepts:
    //   - getOAuthToken: SDK calls this when it needs a fresh token
    //   - ready event: fires when the device is registered with Spotify
    //   - player_state_changed: fires on play/pause/track change
    //   - deviceId: unique ID for this browser player
    // =====================================================================

    window.onSpotifyWebPlaybackSDKReady = () => {
      if (accessToken) initPlayer();
    };

    function initPlayer() {
      setStatus('Connecting to Spotify...');

      player = new Spotify.Player({
        name: 'Bosworth',
        getOAuthToken: async (cb) => {
          // Fetch a fresh token from our Worker each time the SDK asks
          const res = await fetch('/api/token');
          const data = await res.json();
          accessToken = data.access_token;
          cb(data.access_token);
        },
        volume: 0.8,
      });

      // Device is ready — Spotify now sees "Bosworth" as a speaker
      player.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        setStatus('Connected — transferring playback...', 'connected');
        transferAndPlay();
      });

      player.addListener('not_ready', () => {
        setStatus('Device went offline', 'error');
      });

      // Track state changes (play/pause/track end)
      player.addListener('player_state_changed', (state) => {
        if (!state) return;
        isPlaying = !state.paused;
        updatePlayPauseIcon();
        updateProgress(state);
      });

      // Error handlers
      player.addListener('initialization_error', ({ message }) => {
        console.error('Init error:', message);
        setStatus('SDK initialization failed: ' + message, 'error');
      });
      player.addListener('authentication_error', ({ message }) => {
        console.error('Auth error:', message);
        setStatus('Authentication failed — try logging in again', 'error');
      });
      player.addListener('account_error', ({ message }) => {
        console.error('Account error:', message);
        setStatus('Premium required for playback', 'error');
      });

      player.connect();
    }

    // Transfer Spotify playback to our browser device and start playing
    async function transferAndPlay() {
      try {
        // Tell Spotify: "send all audio to this device now"
        await fetch('/api/me/player', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_ids: [deviceId], play: false }),
        });

        setStatus('Ready — playing your liked songs', 'connected');

        // Play the first song
        if (songs.length > 0) {
          await playCurrentSong();
        }
      } catch (err) {
        console.error('Transfer failed:', err);
        setStatus('Failed to transfer playback', 'error');
      }
    }

    // =====================================================================
    // DATA LOADING
    // =====================================================================

    async function loadSongs() {
      try {
        const res = await fetch('/api/me/tracks?limit=50');
        const data = await res.json();
        songs = data.items || [];
        totalLoaded = songs.length;
        currentIndex = 0;
        updateStats();
        showCurrentSong();
      } catch (err) {
        console.error('Failed to load songs:', err);
      }
    }

    async function loadPlaylists() {
      try {
        // Load all playlists (Spotify paginates at 50)
        let allPlaylists = [];
        let url = '/api/me/playlists?limit=50';

        while (url) {
          const res = await fetch(url);
          const data = await res.json();
          const items = (data.items || []).filter(p => p && p.owner && p.owner.id !== 'spotify');
          allPlaylists = allPlaylists.concat(items);

          // Check for next page
          if (data.next) {
            // data.next is a full Spotify URL — convert to our proxy path
            const nextUrl = new URL(data.next);
            url = '/api' + nextUrl.pathname + nextUrl.search;
          } else {
            url = null;
          }
        }

        playlists = allPlaylists;
        renderPlaylists();
      } catch (err) {
        console.error('Failed to load playlists:', err);
      }
    }

    // =====================================================================
    // RENDERING
    // =====================================================================

    function showCurrentSong() {
      const loading = document.getElementById('cardLoading');
      const active = document.getElementById('cardActive');
      const empty = document.getElementById('cardEmpty');
      const actions = document.getElementById('actionButtons');

      if (songs.length === 0 || currentIndex >= songs.length) {
        loading.style.display = 'none';
        active.style.display = 'none';
        empty.style.display = 'block';
        actions.style.display = 'none';
        if (player) player.pause();
        return;
      }

      const item = songs[currentIndex];
      const track = item.track;

      // Update card content
      document.getElementById('albumArt').src = track.album.images[0]?.url || '';
      document.getElementById('songName').textContent = track.name;
      document.getElementById('songArtist').textContent = track.artists.map(a => a.name).join(', ');
      document.getElementById('songAlbum').textContent = track.album.name;
      document.getElementById('progressTotal').textContent = formatMs(track.duration_ms);

      // Show active state
      loading.style.display = 'none';
      active.style.display = 'block';
      empty.style.display = 'none';
      actions.style.display = 'flex';

      // Re-trigger animation
      active.style.animation = 'none';
      active.offsetHeight; // force reflow
      active.style.animation = 'cardIn 0.25s ease';
    }

    function renderPlaylists(filter = '') {
      const grid = document.getElementById('playlistsGrid');
      const filtered = filter
        ? playlists.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
        : playlists;

      if (filtered.length === 0) {
        grid.innerHTML = '<div class="loading-text">No playlists found</div>';
        return;
      }

      grid.innerHTML = filtered.map(p =>
        '<button class="playlist-btn" data-id="' + p.id + '" data-name="' + escapeAttr(p.name) + '">'
        + escapeHtml(p.name)
        + '<span class="track-count">(' + p.tracks.total + ')</span>'
        + '</button>'
      ).join('');

      // Attach click handlers
      grid.querySelectorAll('.playlist-btn').forEach(btn => {
        btn.addEventListener('click', () => sortToPlaylist(btn.dataset.id, btn.dataset.name, btn));
      });
    }

    // =====================================================================
    // PLAYBACK
    // =====================================================================

    async function playCurrentSong() {
      if (!deviceId || currentIndex >= songs.length) return;

      const track = songs[currentIndex].track;

      try {
        await fetch('/api/me/player/play?device_id=' + deviceId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: [track.uri] }),
        });
        isPlaying = true;
        updatePlayPauseIcon();
        startProgressTracking();
      } catch (err) {
        console.error('Play failed:', err);
      }
    }

    async function togglePlayPause() {
      if (!player) return;
      await player.togglePlay();
    }

    function updatePlayPauseIcon() {
      document.getElementById('playIcon').style.display = isPlaying ? 'none' : 'block';
      document.getElementById('pauseIcon').style.display = isPlaying ? 'block' : 'none';
    }

    function startProgressTracking() {
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(async () => {
        if (!player) return;
        const state = await player.getCurrentState();
        if (state) updateProgress(state);
      }, 500);
    }

    function updateProgress(state) {
      if (!state || !state.track_window?.current_track) return;
      const { position, duration } = state;
      const pct = duration > 0 ? (position / duration) * 100 : 0;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressCurrent').textContent = formatMs(position);
    }

    // =====================================================================
    // SORTING — The Core Action
    // =====================================================================

    async function sortToPlaylist(playlistId, playlistName, btnElement) {
      if (isSorting || currentIndex >= songs.length) return;
      isSorting = true;

      const item = songs[currentIndex];
      const track = item.track;

      // Visual feedback
      if (btnElement) btnElement.classList.add('sorting');

      try {
        // 1. Add song to the chosen playlist
        const addRes = await fetch('/api/playlists/' + playlistId + '/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: [track.uri] }),
        });

        if (!addRes.ok) throw new Error('Failed to add to playlist');

        // 2. Remove from Liked Songs
        await fetch('/api/me/tracks?ids=' + track.id, { method: 'DELETE' });

        // 3. Update stats
        songsSorted++;

        // 4. Remove from local array and advance
        songs.splice(currentIndex, 1);
        // currentIndex stays the same since array shifted

        // 5. Update the playlist button's track count
        const playlist = playlists.find(p => p.id === playlistId);
        if (playlist) playlist.tracks.total++;

        updateStats();
        setStatus('Sorted to ' + playlistName, 'connected');

        // 6. Show next song and auto-play
        showCurrentSong();
        if (currentIndex < songs.length) {
          await playCurrentSong();
        }

        // Load more songs if running low
        if (songs.length - currentIndex < 5 && songs.length > 0) {
          loadMoreSongs();
        }

      } catch (err) {
        console.error('Sort failed:', err);
        setStatus('Failed to sort — try again', 'error');
      } finally {
        if (btnElement) {
          setTimeout(() => btnElement.classList.remove('sorting'), 300);
        }
        isSorting = false;
      }
    }

    function skip() {
      if (currentIndex >= songs.length) return;
      songsSkipped++;
      currentIndex++;
      updateStats();
      showCurrentSong();
      if (currentIndex < songs.length) playCurrentSong();
    }

    async function keepAndRemove() {
      if (isSorting || currentIndex >= songs.length) return;
      isSorting = true;

      const track = songs[currentIndex].track;

      try {
        // Remove from Liked Songs (but don't add to any playlist)
        await fetch('/api/me/tracks?ids=' + track.id, { method: 'DELETE' });

        songs.splice(currentIndex, 1);
        songsSorted++;
        updateStats();
        setStatus('Removed from liked songs', 'connected');

        showCurrentSong();
        if (currentIndex < songs.length) await playCurrentSong();

        if (songs.length - currentIndex < 5 && songs.length > 0) {
          loadMoreSongs();
        }
      } catch (err) {
        console.error('Remove failed:', err);
        setStatus('Failed to remove — try again', 'error');
      } finally {
        isSorting = false;
      }
    }

    async function loadMoreSongs() {
      try {
        const offset = totalLoaded;
        const res = await fetch('/api/me/tracks?limit=50&offset=' + offset);
        const data = await res.json();
        const newItems = data.items || [];
        if (newItems.length > 0) {
          songs = songs.concat(newItems);
          totalLoaded += newItems.length;
          updateStats();
        }
      } catch (err) {
        console.error('Failed to load more songs:', err);
      }
    }

    // =====================================================================
    // UI HELPERS
    // =====================================================================

    function updateStats() {
      const remaining = songs.length - currentIndex;
      document.getElementById('sortedStat').textContent = songsSorted + ' sorted';
      document.getElementById('skippedStat').textContent = songsSkipped + ' skipped';
      document.getElementById('remainingStat').textContent = remaining + ' remaining';
    }

    function setStatus(text, state = '') {
      const bar = document.getElementById('statusBar');
      const el = document.getElementById('statusText');
      el.textContent = text;
      bar.className = 'status-bar' + (state ? ' ' + state : '');
    }

    function formatMs(ms) {
      if (!ms || ms < 0) return '0:00';
      const mins = Math.floor(ms / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      return mins + ':' + secs.toString().padStart(2, '0');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    function escapeAttr(text) {
      return (text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // =====================================================================
    // EVENT LISTENERS
    // =====================================================================

    document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
    document.getElementById('nextBtn').addEventListener('click', skip);
    document.getElementById('prevBtn').addEventListener('click', () => {
      // Go back one song (if we skipped past it)
      if (currentIndex > 0) {
        currentIndex--;
        songsSkipped = Math.max(0, songsSkipped - 1);
        updateStats();
        showCurrentSong();
        playCurrentSong();
      }
    });
    document.getElementById('skipBtn').addEventListener('click', skip);
    document.getElementById('keepBtn').addEventListener('click', keepAndRemove);
    document.getElementById('playlistSearch').addEventListener('input', (e) => {
      renderPlaylists(e.target.value);
    });

    // =====================================================================
    // START
    // =====================================================================
    init();
  `;
}
