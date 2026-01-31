/**
 * BOSWORTH v3 - Spotify Playlist Sorter
 * A listening party experience for organizing your music
 * 
 * Features:
 * - Drag & drop songs from Liked to playlists
 * - Auto-remove from Liked Songs after adding to playlist
 * - Listening party mode with timer and auto-play
 * - Session summary with stats
 * - Analytics dashboard with AI insights
 * - Blueprint design aesthetic
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const SCOPES = [
  'user-read-private',
  'user-read-email', 
  'user-library-read',
  'user-library-modify',      // Required for removing liked songs
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-top-read',
  'user-read-recently-played'
].join(' ');

// ============================================================================
// MAIN ROUTER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Static pages
      if (path === '/') return servePage(getHomePage());
      if (path === '/analytics') return servePage(getAnalyticsPage());
      if (path === '/party') return servePage(getPartyPage());
      
      // Auth endpoints
      if (path === '/auth') return handleAuth(env);
      if (path === '/callback') return handleCallback(request, env);
      if (path === '/logout') return handleLogout();
      
      // API endpoints
      if (path.startsWith('/api/')) {
        return handleAPI(request, env, path);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Request error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// ============================================================================
// AUTHENTICATION
// ============================================================================

function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    show_dialog: 'false'
  });
  
  return Response.redirect(`${SPOTIFY_AUTH_URL}?${params}`);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return servePage(getErrorPage('Authorization denied: ' + error));
  }

  if (!code) {
    return servePage(getErrorPage('No authorization code received'));
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI
    })
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    console.error('Token exchange failed:', errorData);
    return servePage(getErrorPage('Failed to exchange authorization code'));
  }

  const tokens = await tokenResponse.json();
  
  // Create session
  const sessionId = crypto.randomUUID();
  await env.SPOTIFY_TOKENS.put(sessionId, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in * 1000)
  }), { expirationTtl: 86400 }); // 24 hour session

  // Redirect to party mode
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/party',
      'Set-Cookie': `bosworth_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
    }
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'bosworth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    }
  });
}

// ============================================================================
// API HANDLER
// ============================================================================

async function handleAPI(request, env, path) {
  // Get session
  const sessionId = getSessionFromCookie(request);
  if (!sessionId) {
    return jsonResponse({ error: 'Not authenticated' }, 401);
  }

  // Get tokens
  const tokenData = await env.SPOTIFY_TOKENS.get(sessionId);
  if (!tokenData) {
    return jsonResponse({ error: 'Session expired' }, 401);
  }

  let tokens = JSON.parse(tokenData);

  // Refresh token if expired
  if (Date.now() >= tokens.expires_at - 60000) {
    tokens = await refreshAccessToken(tokens.refresh_token, env);
    if (tokens) {
      await env.SPOTIFY_TOKENS.put(sessionId, JSON.stringify(tokens), { expirationTtl: 86400 });
    } else {
      return jsonResponse({ error: 'Failed to refresh token' }, 401);
    }
  }

  // Handle internal API endpoints
  if (path === '/api/ai-insights') {
    return handleAIInsights(request, env, tokens.access_token);
  }

  if (path === '/api/session/save') {
    return handleSaveSession(request, env, tokens.access_token);
  }

  if (path === '/api/session/history') {
    return handleGetSessionHistory(request, env, tokens.access_token);
  }

  // Proxy to Spotify API
  const spotifyPath = path.replace('/api', '');
  return proxyToSpotify(request, tokens.access_token, spotifyPath);
}

async function refreshAccessToken(refreshToken, env) {
  try {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (data.expires_in * 1000)
    };
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}

async function proxyToSpotify(request, accessToken, path) {
  const url = new URL(request.url);
  const spotifyUrl = `${SPOTIFY_API_BASE}${path}${url.search}`;

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const options = {
    method: request.method,
    headers: headers
  };

  // Include body for POST, PUT, DELETE with body
  if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
    const body = await request.text();
    if (body) {
      options.body = body;
    }
  }

  const response = await fetch(spotifyUrl, options);
  const responseText = await response.text();

  return new Response(responseText, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================================================
// AI INSIGHTS
// ============================================================================

async function handleAIInsights(request, env, accessToken) {
  try {
    // Fetch user's top data
    const [topArtists, topTracks] = await Promise.all([
      fetch(`${SPOTIFY_API_BASE}/me/top/artists?time_range=short_term&limit=10`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }).then(r => r.json()),
      fetch(`${SPOTIFY_API_BASE}/me/top/tracks?time_range=short_term&limit=10`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }).then(r => r.json())
    ]);

    // Extract data for the prompt
    const artistNames = (topArtists.items || []).map(a => a.name).join(', ');
    const trackNames = (topTracks.items || []).map(t => `${t.name} by ${t.artists[0]?.name}`).join(', ');
    
    // Collect genres
    const genreCounts = {};
    (topArtists.items || []).forEach(artist => {
      (artist.genres || []).forEach(genre => {
        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      });
    });
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genre]) => genre)
      .join(', ');

    // Generate AI insights
    const prompt = `You are a fun, Gen-Z music analyst. Based on this person's recent Spotify listening data, write a short, engaging 2-3 paragraph analysis of their music taste. Be specific about what their choices say about them. Use a casual, friendly tone.

Top Artists: ${artistNames || 'Not enough data'}
Top Tracks: ${trackNames || 'Not enough data'}  
Top Genres: ${topGenres || 'Various'}

Keep it under 150 words. Be playful and insightful.`;

    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300
    });

    return jsonResponse({ 
      insights: aiResponse.response,
      data: {
        topArtists: topArtists.items || [],
        topTracks: topTracks.items || [],
        topGenres: Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      }
    });
  } catch (error) {
    console.error('AI insights error:', error);
    return jsonResponse({ 
      insights: 'Unable to generate insights at this time. Keep vibing! 🎵',
      error: error.message 
    });
  }
}

// ============================================================================
// SESSION STORAGE (D1)
// ============================================================================

async function handleSaveSession(request, env, accessToken) {
  try {
    const sessionData = await request.json();
    
    // Get user ID from Spotify
    const userResponse = await fetch(`${SPOTIFY_API_BASE}/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const user = await userResponse.json();

    // Initialize database if needed
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        duration_seconds INTEGER,
        songs_sorted INTEGER,
        playlists_used TEXT,
        genres TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Save session
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO sessions (id, user_id, duration_seconds, songs_sorted, playlists_used, genres)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      user.id,
      sessionData.duration,
      sessionData.songsSorted,
      JSON.stringify(sessionData.playlists),
      JSON.stringify(sessionData.genres)
    ).run();

    return jsonResponse({ success: true, sessionId });
  } catch (error) {
    console.error('Save session error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

async function handleGetSessionHistory(request, env, accessToken) {
  try {
    // Get user ID
    const userResponse = await fetch(`${SPOTIFY_API_BASE}/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const user = await userResponse.json();

    // Get sessions
    const result = await env.DB.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `).bind(user.id).all();

    return jsonResponse({ sessions: result.results || [] });
  } catch (error) {
    console.error('Get history error:', error);
    return jsonResponse({ sessions: [] });
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function getSessionFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  
  const match = cookieHeader.match(/bosworth_session=([^;]+)/);
  return match ? match[1] : null;
}

function servePage(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function getErrorPage(message) {
  return `<!DOCTYPE html>
<html><head><title>Error - Bosworth</title></head>
<body style="font-family: monospace; padding: 40px; text-align: center;">
  <h1>Something went wrong</h1>
  <p>${message}</p>
  <a href="/">Go back</a>
</body></html>`;
}

// ============================================================================
// PAGE: HOME / LANDING
// ============================================================================

function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bosworth - Spotify Playlist Sorter</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${getBaseStyles()}
    
    .landing {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 40px 20px;
    }
    
    .logo {
      font-size: 64px;
      font-weight: 700;
      letter-spacing: -2px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .tagline {
      font-size: 18px;
      color: var(--text-secondary);
      margin-bottom: 48px;
      max-width: 400px;
    }
    
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      max-width: 800px;
      margin-bottom: 48px;
    }
    
    .feature-card {
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 8px;
      padding: 24px;
      text-align: left;
    }
    
    .feature-card::before {
      content: attr(data-label);
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .feature-card h3 {
      margin: 12px 0 8px;
      font-size: 16px;
    }
    
    .feature-card p {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    
    .cta-button {
      background: var(--accent-green);
      color: var(--bg);
      border: none;
      padding: 16px 48px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 50px;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(29, 185, 84, 0.3);
    }
    
    .blueprint-decoration {
      position: fixed;
      font-size: 10px;
      color: var(--text-muted);
      opacity: 0.5;
    }
    
    .blueprint-decoration.top-left { top: 20px; left: 20px; }
    .blueprint-decoration.top-right { top: 20px; right: 20px; }
    .blueprint-decoration.bottom-left { bottom: 20px; left: 20px; }
    .blueprint-decoration.bottom-right { bottom: 20px; right: 20px; }
  </style>
</head>
<body>
  <div class="blueprint-decoration top-left">BOSWORTH.v3</div>
  <div class="blueprint-decoration top-right">SCALE: 1:1</div>
  <div class="blueprint-decoration bottom-left">REV. 03</div>
  <div class="blueprint-decoration bottom-right">2025.01</div>
  
  <div class="landing">
    <div class="logo">BOSWORTH</div>
    <p class="tagline">Transform your liked songs into organized playlists. A listening party for your music library.</p>
    
    <div class="feature-grid">
      <div class="feature-card" data-label="Feature 01">
        <h3>🎧 Listening Party</h3>
        <p>Preview tracks and drag them to playlists with auto-play</p>
      </div>
      <div class="feature-card" data-label="Feature 02">
        <h3>⚡ Auto-Remove</h3>
        <p>Songs automatically leave your Liked playlist when sorted</p>
      </div>
      <div class="feature-card" data-label="Feature 03">
        <h3>📊 AI Insights</h3>
        <p>Get personalized analysis of your listening habits</p>
      </div>
    </div>
    
    <a href="/auth">
      <button class="cta-button">Connect with Spotify</button>
    </a>
  </div>
</body>
</html>`;
}

// ============================================================================
// PAGE: LISTENING PARTY
// ============================================================================

function getPartyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Listening Party - Bosworth</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${getBaseStyles()}
    ${getPartyStyles()}
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <a href="/" class="logo-link">BOSWORTH</a>
        <span class="version-tag">v3</span>
      </div>
      
      <div class="header-center">
        <div class="timer-display" id="timer">
          <span class="timer-icon">⏱</span>
          <span class="timer-value" id="timerValue">00:00</span>
        </div>
        <div class="session-stats" id="sessionStats">
          <span id="sortedCount">0</span> songs sorted
        </div>
      </div>
      
      <div class="header-right">
        <a href="/analytics" class="nav-btn">📊 Analytics</a>
        <a href="spotify:" class="nav-btn accent">Open Spotify</a>
        <button class="nav-btn end-session" id="endSessionBtn">End Session</button>
      </div>
    </header>

    <!-- Main Content -->
    <main class="main-content">
      <!-- Song Queue -->
      <section class="panel songs-panel">
        <div class="panel-header">
          <div class="panel-title">
            <span class="panel-label">SOURCE</span>
            <h2>Liked Songs</h2>
          </div>
          <div class="panel-actions">
            <label class="select-all">
              <input type="checkbox" id="selectAll">
              <span>Select All</span>
            </label>
            <button class="btn-secondary" id="bulkMoveBtn" disabled>Move Selected</button>
            <button class="btn-icon" id="refreshBtn" title="Refresh">↻</button>
          </div>
        </div>
        
        <div class="songs-list" id="songsList">
          <div class="loading-state">Loading your liked songs...</div>
        </div>
        
        <div class="panel-footer">
          <button class="btn-secondary" id="loadMoreBtn" style="display: none;">Load More</button>
        </div>
      </section>

      <!-- Now Playing -->
      <section class="panel nowplaying-panel">
        <div class="panel-header">
          <span class="panel-label">NOW PLAYING</span>
        </div>
        
        <div class="nowplaying-content" id="nowPlaying">
          <div class="nowplaying-empty">
            <div class="empty-icon">🎵</div>
            <p>Click a song to preview</p>
          </div>
        </div>
        
        <div class="audio-controls" id="audioControls" style="display: none;">
          <div class="progress-bar">
            <div class="progress-fill" id="progressFill"></div>
          </div>
          <div class="control-buttons">
            <button class="control-btn" id="prevBtn">⏮</button>
            <button class="control-btn play-btn" id="playPauseBtn">▶</button>
            <button class="control-btn" id="nextBtn">⏭</button>
          </div>
        </div>
      </section>

      <!-- Playlists -->
      <section class="panel playlists-panel">
        <div class="panel-header">
          <div class="panel-title">
            <span class="panel-label">DESTINATION</span>
            <h2>Your Playlists</h2>
          </div>
          <input type="text" class="search-input" id="playlistSearch" placeholder="Search playlists...">
        </div>
        
        <div class="playlists-list" id="playlistsList">
          <div class="loading-state">Loading playlists...</div>
        </div>
      </section>
    </main>

    <!-- Session Summary Modal -->
    <div class="modal-overlay" id="summaryModal" style="display: none;">
      <div class="modal">
        <div class="modal-header">
          <span class="panel-label">SESSION COMPLETE</span>
          <h2>🎉 Nice Session!</h2>
        </div>
        <div class="modal-body" id="summaryContent">
          <!-- Filled by JS -->
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="newSessionBtn">New Session</button>
          <a href="/analytics" class="btn-primary">View Analytics</a>
        </div>
      </div>
    </div>

    <!-- Bulk Move Modal -->
    <div class="modal-overlay" id="bulkMoveModal" style="display: none;">
      <div class="modal">
        <div class="modal-header">
          <span class="panel-label">BULK MOVE</span>
          <h2>Select Destination</h2>
        </div>
        <div class="modal-body">
          <div class="modal-playlists" id="modalPlaylistsList"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="cancelBulkBtn">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <audio id="audioPlayer"></audio>

  <script>
    ${getPartyScript()}
  </script>
</body>
</html>`;
}

// ============================================================================
// PAGE: ANALYTICS
// ============================================================================

function getAnalyticsPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analytics - Bosworth</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${getBaseStyles()}
    ${getAnalyticsStyles()}
  </style>
</head>
<body>
  <div class="app-container">
    <header class="header">
      <div class="header-left">
        <a href="/" class="logo-link">BOSWORTH</a>
        <span class="version-tag">v3</span>
      </div>
      
      <div class="header-right">
        <a href="/party" class="nav-btn accent">🎧 Start Party</a>
        <a href="spotify:" class="nav-btn">Open Spotify</a>
      </div>
    </header>

    <main class="analytics-main">
      <!-- Time Range Selector -->
      <div class="time-selector">
        <button class="time-btn active" data-range="short_term">Last 4 Weeks</button>
        <button class="time-btn" data-range="medium_term">Last 6 Months</button>
        <button class="time-btn" data-range="long_term">All Time</button>
      </div>

      <!-- Stats Grid -->
      <div class="stats-grid">
        <section class="stat-card" data-label="TOP ARTISTS">
          <div class="stat-list" id="topArtists">
            <div class="loading-state">Loading...</div>
          </div>
        </section>

        <section class="stat-card" data-label="TOP TRACKS">
          <div class="stat-list" id="topTracks">
            <div class="loading-state">Loading...</div>
          </div>
        </section>

        <section class="stat-card" data-label="TOP GENRES">
          <div class="stat-list" id="topGenres">
            <div class="loading-state">Loading...</div>
          </div>
        </section>

        <section class="stat-card wide" data-label="AI INSIGHTS">
          <div class="ai-insights" id="aiInsights">
            <div class="loading-state">Analyzing your music taste...</div>
          </div>
          <button class="btn-secondary" id="regenerateBtn" style="margin-top: 16px;">✨ Regenerate</button>
        </section>

        <section class="stat-card" data-label="SESSION HISTORY">
          <div class="session-history" id="sessionHistory">
            <div class="loading-state">Loading sessions...</div>
          </div>
        </section>

        <section class="stat-card" data-label="PLAYLIST STATS">
          <div class="playlist-stats" id="playlistStats">
            <div class="loading-state">Loading...</div>
          </div>
        </section>
      </div>
    </main>
  </div>

  <script>
    ${getAnalyticsScript()}
  </script>
</body>
</html>`;
}

// ============================================================================
// STYLES
// ============================================================================

function getBaseStyles() {
  return `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --bg: #0a0a0f;
      --surface: #12121a;
      --surface-elevated: #1a1a24;
      --border: #2a2a3a;
      --text: #e8e8ed;
      --text-secondary: #a0a0b0;
      --text-muted: #606070;
      --accent-blue: #4a9eff;
      --accent-green: #1DB954;
      --accent-purple: #a855f7;
      --accent-orange: #f97316;
      --danger: #ef4444;
    }
    
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      background-image: 
        linear-gradient(rgba(74, 158, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(74, 158, 255, 0.03) 1px, transparent 1px);
      background-size: 20px 20px;
      min-height: 100vh;
    }
    
    a {
      color: inherit;
      text-decoration: none;
    }
    
    button {
      font-family: inherit;
      cursor: pointer;
    }
    
    .loading-state {
      padding: 40px;
      text-align: center;
      color: var(--text-muted);
    }
  `;
}

function getPartyStyles() {
  return `
    .app-container {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .logo-link {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -1px;
      color: var(--accent-blue);
    }
    
    .version-tag {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--surface-elevated);
      border: 1px dashed var(--border);
      border-radius: 4px;
      color: var(--text-muted);
    }
    
    .header-center {
      display: flex;
      align-items: center;
      gap: 24px;
    }
    
    .timer-display {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 24px;
      font-weight: 600;
      color: var(--accent-green);
    }
    
    .timer-icon {
      font-size: 20px;
    }
    
    .session-stats {
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .nav-btn {
      padding: 8px 16px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text);
      transition: all 0.2s;
    }
    
    .nav-btn:hover {
      border-color: var(--accent-blue);
      background: var(--surface);
    }
    
    .nav-btn.accent {
      background: var(--accent-green);
      border-color: var(--accent-green);
      color: var(--bg);
    }
    
    .nav-btn.accent:hover {
      opacity: 0.9;
    }
    
    .nav-btn.end-session {
      background: transparent;
      border-color: var(--danger);
      color: var(--danger);
    }
    
    .nav-btn.end-session:hover {
      background: var(--danger);
      color: white;
    }
    
    /* Main Content */
    .main-content {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 300px 320px;
      gap: 1px;
      background: var(--border);
      padding: 1px;
    }
    
    .panel {
      background: var(--surface);
      display: flex;
      flex-direction: column;
    }
    
    .panel-header {
      padding: 16px 20px;
      border-bottom: 1px dashed var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }
    
    .panel-title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    .panel-label {
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    
    .panel-title h2 {
      font-size: 16px;
      font-weight: 600;
    }
    
    .panel-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .select-all {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
    }
    
    .select-all input {
      accent-color: var(--accent-blue);
    }
    
    .btn-secondary {
      padding: 6px 12px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text);
      transition: all 0.2s;
    }
    
    .btn-secondary:hover:not(:disabled) {
      border-color: var(--accent-blue);
    }
    
    .btn-secondary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .btn-primary {
      padding: 8px 16px;
      background: var(--accent-green);
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      color: var(--bg);
      transition: all 0.2s;
    }
    
    .btn-primary:hover {
      opacity: 0.9;
    }
    
    .btn-icon {
      width: 32px;
      height: 32px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 14px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .btn-icon:hover {
      border-color: var(--accent-blue);
    }
    
    /* Songs List */
    .songs-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    
    .song-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--surface-elevated);
      border: 1px solid transparent;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: grab;
      transition: all 0.2s;
    }
    
    .song-item:hover {
      border-color: var(--border);
    }
    
    .song-item.selected {
      border-color: var(--accent-blue);
      background: rgba(74, 158, 255, 0.1);
    }
    
    .song-item.playing {
      border-color: var(--accent-green);
      background: rgba(29, 185, 84, 0.1);
    }
    
    .song-item.dragging {
      opacity: 0.5;
      transform: scale(0.98);
    }
    
    .song-checkbox {
      accent-color: var(--accent-blue);
    }
    
    .song-cover {
      width: 48px;
      height: 48px;
      border-radius: 4px;
      object-fit: cover;
      background: var(--surface);
    }
    
    .song-info {
      flex: 1;
      min-width: 0;
    }
    
    .song-name {
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .song-artist {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .song-duration {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    .panel-footer {
      padding: 12px;
      border-top: 1px dashed var(--border);
      text-align: center;
    }
    
    /* Now Playing */
    .nowplaying-panel {
      border-left: 1px dashed var(--border);
      border-right: 1px dashed var(--border);
    }
    
    .nowplaying-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    
    .nowplaying-empty {
      text-align: center;
      color: var(--text-muted);
    }
    
    .empty-icon {
      font-size: 48px;
      margin-bottom: 12px;
      opacity: 0.5;
    }
    
    .nowplaying-active {
      text-align: center;
      width: 100%;
    }
    
    .nowplaying-cover {
      width: 200px;
      height: 200px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    
    .nowplaying-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    
    .nowplaying-artist {
      font-size: 14px;
      color: var(--text-secondary);
    }
    
    .audio-controls {
      padding: 20px;
      border-top: 1px dashed var(--border);
    }
    
    .progress-bar {
      height: 4px;
      background: var(--surface-elevated);
      border-radius: 2px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    
    .progress-fill {
      height: 100%;
      background: var(--accent-green);
      width: 0%;
      transition: width 0.1s linear;
    }
    
    .control-buttons {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }
    
    .control-btn {
      width: 40px;
      height: 40px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 50%;
      font-size: 14px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .control-btn:hover {
      border-color: var(--accent-green);
    }
    
    .control-btn.play-btn {
      width: 56px;
      height: 56px;
      font-size: 18px;
      background: var(--accent-green);
      border-color: var(--accent-green);
      color: var(--bg);
    }
    
    /* Playlists */
    .search-input {
      padding: 8px 12px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      color: var(--text);
      width: 100%;
      max-width: 200px;
    }
    
    .search-input::placeholder {
      color: var(--text-muted);
    }
    
    .search-input:focus {
      outline: none;
      border-color: var(--accent-blue);
    }
    
    .playlists-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    
    .playlist-item {
      padding: 16px;
      background: var(--surface-elevated);
      border: 2px dashed transparent;
      border-radius: 8px;
      margin-bottom: 8px;
      transition: all 0.2s;
      cursor: pointer;
    }
    
    .playlist-item:hover {
      border-color: var(--border);
    }
    
    .playlist-item.drag-over {
      border-color: var(--accent-green);
      background: rgba(29, 185, 84, 0.1);
      transform: scale(1.02);
    }
    
    .playlist-name {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    
    .playlist-count {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    
    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 500px;
      width: 100%;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }
    
    .modal-header {
      padding: 20px 24px;
      border-bottom: 1px dashed var(--border);
    }
    
    .modal-header h2 {
      font-size: 20px;
      margin-top: 8px;
    }
    
    .modal-body {
      padding: 24px;
      overflow-y: auto;
      flex: 1;
    }
    
    .modal-footer {
      padding: 16px 24px;
      border-top: 1px dashed var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
    
    /* Summary Stats */
    .summary-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .summary-stat {
      background: var(--surface-elevated);
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    
    .summary-stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent-green);
    }
    
    .summary-stat-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    
    .summary-section {
      margin-bottom: 20px;
    }
    
    .summary-section h3 {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
    }
    
    .summary-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .summary-tag {
      padding: 6px 12px;
      background: var(--surface-elevated);
      border-radius: 4px;
      font-size: 12px;
    }
    
    .modal-playlists {
      max-height: 300px;
      overflow-y: auto;
    }
    
    .modal-playlist-item {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .modal-playlist-item:hover {
      border-color: var(--accent-green);
      background: rgba(29, 185, 84, 0.1);
    }
  `;
}

function getAnalyticsStyles() {
  return `
    .app-container {
      min-height: 100vh;
    }
    
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .logo-link {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -1px;
      color: var(--accent-blue);
    }
    
    .version-tag {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--surface-elevated);
      border: 1px dashed var(--border);
      border-radius: 4px;
      color: var(--text-muted);
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .nav-btn {
      padding: 8px 16px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text);
      transition: all 0.2s;
    }
    
    .nav-btn:hover {
      border-color: var(--accent-blue);
    }
    
    .nav-btn.accent {
      background: var(--accent-green);
      border-color: var(--accent-green);
      color: var(--bg);
    }
    
    .analytics-main {
      padding: 24px;
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .time-selector {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: 32px;
    }
    
    .time-btn {
      padding: 10px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-secondary);
      transition: all 0.2s;
    }
    
    .time-btn:hover {
      border-color: var(--accent-blue);
      color: var(--text);
    }
    
    .time-btn.active {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
      color: white;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    
    .stat-card {
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    
    .stat-card::before {
      content: attr(data-label);
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    
    .stat-card.wide {
      grid-column: span 2;
    }
    
    .stat-list {
      margin-top: 16px;
    }
    
    .stat-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    
    .stat-item:last-child {
      border-bottom: none;
    }
    
    .stat-rank {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent-blue);
      width: 30px;
    }
    
    .stat-cover {
      width: 48px;
      height: 48px;
      border-radius: 4px;
      object-fit: cover;
    }
    
    .stat-info {
      flex: 1;
    }
    
    .stat-name {
      font-size: 14px;
      font-weight: 500;
    }
    
    .stat-detail {
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    .ai-insights {
      margin-top: 16px;
      font-size: 14px;
      line-height: 1.7;
      color: var(--text-secondary);
    }
    
    .btn-secondary {
      padding: 8px 16px;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text);
      transition: all 0.2s;
    }
    
    .btn-secondary:hover {
      border-color: var(--accent-blue);
    }
    
    .session-history {
      margin-top: 16px;
    }
    
    .session-item {
      padding: 12px;
      background: var(--surface-elevated);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    
    .session-date {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    .session-stats {
      display: flex;
      gap: 16px;
      margin-top: 8px;
      font-size: 14px;
    }
    
    .playlist-stats {
      margin-top: 16px;
    }
    
    .playlist-stat-item {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    
    .playlist-stat-item:last-child {
      border-bottom: none;
    }
    
    .playlist-stat-value {
      font-weight: 600;
      color: var(--accent-green);
    }
    
    .genre-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
    }
    
    .genre-name {
      width: 120px;
      font-size: 13px;
    }
    
    .genre-fill {
      flex: 1;
      height: 8px;
      background: var(--surface-elevated);
      border-radius: 4px;
      overflow: hidden;
    }
    
    .genre-fill-inner {
      height: 100%;
      background: var(--accent-purple);
      border-radius: 4px;
    }
    
    .genre-count {
      width: 30px;
      text-align: right;
      font-size: 12px;
      color: var(--text-muted);
    }
  `;
}

// ============================================================================
// SCRIPTS
// ============================================================================

function getPartyScript() {
  return `
    // ========== STATE ==========
    let songs = [];
    let playlists = [];
    let selectedSongs = new Set();
    let currentSongIndex = -1;
    let isPlaying = false;
    let sessionStartTime = Date.now();
    let songsSorted = 0;
    let playlistsUsed = {};
    let genresSorted = {};
    let timerInterval;
    let audio = document.getElementById('audioPlayer');

    // ========== INIT ==========
    async function init() {
      const authCheck = await fetch('/api/me');
      if (!authCheck.ok) {
        window.location.href = '/';
        return;
      }
      
      startTimer();
      await Promise.all([loadSongs(), loadPlaylists()]);
      setupEventListeners();
    }

    // ========== TIMER ==========
    function startTimer() {
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        document.getElementById('timerValue').textContent = mins + ':' + secs;
      }, 1000);
    }

    // ========== DATA LOADING ==========
    async function loadSongs() {
      try {
        const res = await fetch('/api/me/tracks?limit=50');
        const data = await res.json();
        songs = data.items || [];
        renderSongs();
      } catch (err) {
        console.error('Failed to load songs:', err);
        document.getElementById('songsList').innerHTML = '<div class="loading-state">Failed to load songs</div>';
      }
    }

    async function loadPlaylists() {
      try {
        const res = await fetch('/api/me/playlists?limit=50');
        const data = await res.json();
        playlists = (data.items || []).filter(p => p.owner.id !== 'spotify'); // Filter out Spotify's playlists
        renderPlaylists();
      } catch (err) {
        console.error('Failed to load playlists:', err);
        document.getElementById('playlistsList').innerHTML = '<div class="loading-state">Failed to load playlists</div>';
      }
    }

    // ========== RENDERING ==========
    function renderSongs() {
      const container = document.getElementById('songsList');
      
      if (songs.length === 0) {
        container.innerHTML = '<div class="loading-state">No liked songs found</div>';
        return;
      }
      
      container.innerHTML = songs.map((item, i) => {
        const track = item.track;
        const isSelected = selectedSongs.has(i);
        const isCurrentlyPlaying = i === currentSongIndex;
        
        return \`
          <div class="song-item \${isSelected ? 'selected' : ''} \${isCurrentlyPlaying ? 'playing' : ''}" 
               data-index="\${i}" 
               data-uri="\${track.uri}"
               data-id="\${track.id}"
               draggable="true">
            <input type="checkbox" class="song-checkbox" \${isSelected ? 'checked' : ''}>
            <img src="\${track.album.images[2]?.url || ''}" alt="" class="song-cover">
            <div class="song-info">
              <div class="song-name">\${escapeHtml(track.name)}</div>
              <div class="song-artist">\${escapeHtml(track.artists.map(a => a.name).join(', '))}</div>
            </div>
            <div class="song-duration">\${formatDuration(track.duration_ms)}</div>
          </div>
        \`;
      }).join('');
      
      // Add drag event listeners
      container.querySelectorAll('.song-item').forEach(el => {
        el.addEventListener('dragstart', handleDragStart);
        el.addEventListener('dragend', handleDragEnd);
        el.addEventListener('click', handleSongClick);
      });
      
      updateBulkButton();
    }

    function renderPlaylists(filter = '') {
      const container = document.getElementById('playlistsList');
      const filtered = filter 
        ? playlists.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
        : playlists;
      
      if (filtered.length === 0) {
        container.innerHTML = '<div class="loading-state">No playlists found</div>';
        return;
      }
      
      container.innerHTML = filtered.map(p => \`
        <div class="playlist-item" data-id="\${p.id}" data-name="\${escapeHtml(p.name)}">
          <div class="playlist-name">\${escapeHtml(p.name)}</div>
          <div class="playlist-count">\${p.tracks.total} tracks</div>
        </div>
      \`).join('');
      
      // Add drop event listeners
      container.querySelectorAll('.playlist-item').forEach(el => {
        el.addEventListener('dragover', handleDragOver);
        el.addEventListener('dragleave', handleDragLeave);
        el.addEventListener('drop', handleDrop);
      });
    }

    // ========== DRAG & DROP ==========
    let draggedIndex = null;

    function handleDragStart(e) {
      draggedIndex = parseInt(e.currentTarget.dataset.index);
      e.currentTarget.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedIndex);
    }

    function handleDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      draggedIndex = null;
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.currentTarget.classList.add('drag-over');
    }

    function handleDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
    }

    async function handleDrop(e) {
      e.preventDefault();
      e.currentTarget.classList.remove('drag-over');
      
      const playlistId = e.currentTarget.dataset.id;
      const playlistName = e.currentTarget.dataset.name;
      
      // Check if we're dragging a single song or multiple selected
      let indicesToMove = [];
      
      if (selectedSongs.size > 0 && selectedSongs.has(draggedIndex)) {
        // Move all selected songs
        indicesToMove = Array.from(selectedSongs);
      } else {
        // Move just the dragged song
        indicesToMove = [draggedIndex];
      }
      
      await moveSongsToPlaylist(indicesToMove, playlistId, playlistName);
    }

    // ========== MOVE SONGS ==========
    async function moveSongsToPlaylist(indices, playlistId, playlistName) {
      const tracksToMove = indices.map(i => songs[i]).filter(Boolean);
      if (tracksToMove.length === 0) return;
      
      const trackUris = tracksToMove.map(item => item.track.uri);
      const trackIds = tracksToMove.map(item => item.track.id);
      
      try {
        // 1. Add to playlist
        const addRes = await fetch('/api/playlists/' + playlistId + '/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: trackUris })
        });
        
        if (!addRes.ok) {
          throw new Error('Failed to add to playlist');
        }
        
        // 2. Remove from Liked Songs
        const removeRes = await fetch('/api/me/tracks?ids=' + trackIds.join(','), {
          method: 'DELETE'
        });
        
        if (!removeRes.ok) {
          console.warn('Failed to remove from Liked Songs, but added to playlist');
        }
        
        // 3. Update session stats
        songsSorted += tracksToMove.length;
        playlistsUsed[playlistName] = (playlistsUsed[playlistName] || 0) + tracksToMove.length;
        
        // Track genres
        tracksToMove.forEach(item => {
          const artistGenres = item.track.artists[0]?.genres || [];
          artistGenres.forEach(g => {
            genresSorted[g] = (genresSorted[g] || 0) + 1;
          });
        });
        
        document.getElementById('sortedCount').textContent = songsSorted;
        
        // 4. Remove from local array (sort descending to avoid index shifting issues)
        indices.sort((a, b) => b - a).forEach(i => {
          songs.splice(i, 1);
        });
        
        // 5. Clear selection and re-render
        selectedSongs.clear();
        
        // 6. Auto-play next song if we were playing one that got moved
        if (indices.includes(currentSongIndex)) {
          currentSongIndex = Math.min(currentSongIndex, songs.length - 1);
          if (currentSongIndex >= 0 && songs[currentSongIndex]) {
            playSong(currentSongIndex);
          }
        } else if (currentSongIndex > Math.min(...indices)) {
          // Adjust current index if songs before it were removed
          currentSongIndex -= indices.filter(i => i < currentSongIndex).length;
        }
        
        renderSongs();
        
      } catch (err) {
        console.error('Move failed:', err);
        alert('Failed to move song(s). Please try again.');
      }
    }

    // ========== AUDIO PLAYBACK ==========
    function handleSongClick(e) {
      // Ignore if clicking checkbox
      if (e.target.classList.contains('song-checkbox')) {
        const index = parseInt(e.currentTarget.dataset.index);
        if (e.target.checked) {
          selectedSongs.add(index);
        } else {
          selectedSongs.delete(index);
        }
        e.currentTarget.classList.toggle('selected', e.target.checked);
        updateBulkButton();
        return;
      }
      
      const index = parseInt(e.currentTarget.dataset.index);
      playSong(index);
    }

    function playSong(index) {
      if (index < 0 || index >= songs.length) return;
      
      const track = songs[index].track;
      currentSongIndex = index;
      
      // Update now playing UI
      const nowPlaying = document.getElementById('nowPlaying');
      nowPlaying.innerHTML = \`
        <div class="nowplaying-active">
          <img src="\${track.album.images[0]?.url || ''}" alt="" class="nowplaying-cover">
          <div class="nowplaying-title">\${escapeHtml(track.name)}</div>
          <div class="nowplaying-artist">\${escapeHtml(track.artists.map(a => a.name).join(', '))}</div>
        </div>
      \`;
      
      document.getElementById('audioControls').style.display = 'block';
      
      // Play audio
      if (track.preview_url) {
        audio.src = track.preview_url;
        audio.play();
        isPlaying = true;
        document.getElementById('playPauseBtn').textContent = '⏸';
      } else {
        audio.pause();
        isPlaying = false;
        document.getElementById('playPauseBtn').textContent = '▶';
        document.getElementById('progressFill').style.width = '0%';
      }
      
      renderSongs(); // Update playing state
    }

    function playPause() {
      if (isPlaying) {
        audio.pause();
        document.getElementById('playPauseBtn').textContent = '▶';
      } else {
        audio.play();
        document.getElementById('playPauseBtn').textContent = '⏸';
      }
      isPlaying = !isPlaying;
    }

    function playNext() {
      if (currentSongIndex < songs.length - 1) {
        playSong(currentSongIndex + 1);
      }
    }

    function playPrev() {
      if (currentSongIndex > 0) {
        playSong(currentSongIndex - 1);
      }
    }

    // Audio events
    audio.addEventListener('timeupdate', () => {
      const progress = (audio.currentTime / audio.duration) * 100;
      document.getElementById('progressFill').style.width = progress + '%';
    });

    audio.addEventListener('ended', () => {
      playNext();
    });

    // ========== BULK ACTIONS ==========
    function updateBulkButton() {
      const btn = document.getElementById('bulkMoveBtn');
      btn.disabled = selectedSongs.size === 0;
      btn.textContent = 'Move Selected' + (selectedSongs.size > 0 ? ' (' + selectedSongs.size + ')' : '');
    }

    function showBulkMoveModal() {
      if (selectedSongs.size === 0) return;
      
      const modal = document.getElementById('bulkMoveModal');
      const list = document.getElementById('modalPlaylistsList');
      
      list.innerHTML = playlists.map(p => \`
        <div class="modal-playlist-item" data-id="\${p.id}" data-name="\${escapeHtml(p.name)}">
          \${escapeHtml(p.name)}
        </div>
      \`).join('');
      
      list.querySelectorAll('.modal-playlist-item').forEach(el => {
        el.addEventListener('click', async () => {
          const indices = Array.from(selectedSongs);
          await moveSongsToPlaylist(indices, el.dataset.id, el.dataset.name);
          modal.style.display = 'none';
        });
      });
      
      modal.style.display = 'flex';
    }

    // ========== SESSION MANAGEMENT ==========
    async function endSession() {
      clearInterval(timerInterval);
      
      const duration = Math.floor((Date.now() - sessionStartTime) / 1000);
      
      // Save session to D1
      try {
        await fetch('/api/session/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            duration,
            songsSorted,
            playlists: playlistsUsed,
            genres: genresSorted
          })
        });
      } catch (err) {
        console.error('Failed to save session:', err);
      }
      
      // Show summary
      showSessionSummary(duration);
    }

    function showSessionSummary(duration) {
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      
      const playlistList = Object.entries(playlistsUsed)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => \`<span class="summary-tag">\${escapeHtml(name)} (\${count})</span>\`)
        .join('');
      
      const genreList = Object.entries(genresSorted)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => \`<span class="summary-tag">\${escapeHtml(name)}</span>\`)
        .join('');
      
      document.getElementById('summaryContent').innerHTML = \`
        <div class="summary-stats">
          <div class="summary-stat">
            <div class="summary-stat-value">\${mins}:\${secs.toString().padStart(2, '0')}</div>
            <div class="summary-stat-label">Duration</div>
          </div>
          <div class="summary-stat">
            <div class="summary-stat-value">\${songsSorted}</div>
            <div class="summary-stat-label">Songs Sorted</div>
          </div>
        </div>
        
        \${playlistList ? \`
        <div class="summary-section">
          <h3>Playlists Updated</h3>
          <div class="summary-list">\${playlistList}</div>
        </div>
        \` : ''}
        
        \${genreList ? \`
        <div class="summary-section">
          <h3>Genres</h3>
          <div class="summary-list">\${genreList}</div>
        </div>
        \` : ''}
      \`;
      
      document.getElementById('summaryModal').style.display = 'flex';
    }

    // ========== EVENT LISTENERS ==========
    function setupEventListeners() {
      // Header controls
      document.getElementById('endSessionBtn').addEventListener('click', endSession);
      document.getElementById('refreshBtn').addEventListener('click', loadSongs);
      
      // Selection
      document.getElementById('selectAll').addEventListener('change', (e) => {
        if (e.target.checked) {
          songs.forEach((_, i) => selectedSongs.add(i));
        } else {
          selectedSongs.clear();
        }
        renderSongs();
      });
      
      // Bulk move
      document.getElementById('bulkMoveBtn').addEventListener('click', showBulkMoveModal);
      document.getElementById('cancelBulkBtn').addEventListener('click', () => {
        document.getElementById('bulkMoveModal').style.display = 'none';
      });
      
      // Audio controls
      document.getElementById('playPauseBtn').addEventListener('click', playPause);
      document.getElementById('nextBtn').addEventListener('click', playNext);
      document.getElementById('prevBtn').addEventListener('click', playPrev);
      
      // Playlist search
      document.getElementById('playlistSearch').addEventListener('input', (e) => {
        renderPlaylists(e.target.value);
      });
      
      // Session summary
      document.getElementById('newSessionBtn').addEventListener('click', () => {
        window.location.reload();
      });
      
      // Close modals on overlay click
      document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) {
            overlay.style.display = 'none';
          }
        });
      });
    }

    // ========== UTILITIES ==========
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatDuration(ms) {
      const mins = Math.floor(ms / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      return mins + ':' + secs.toString().padStart(2, '0');
    }

    // ========== START ==========
    init();
  `;
}

function getAnalyticsScript() {
  return `
    let currentTimeRange = 'short_term';

    async function init() {
      const authCheck = await fetch('/api/me');
      if (!authCheck.ok) {
        window.location.href = '/';
        return;
      }
      
      setupEventListeners();
      await loadAllData();
    }

    function setupEventListeners() {
      document.querySelectorAll('.time-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          currentTimeRange = e.target.dataset.range;
          await loadTopData();
        });
      });
      
      document.getElementById('regenerateBtn').addEventListener('click', loadAIInsights);
    }

    async function loadAllData() {
      await Promise.all([
        loadTopData(),
        loadAIInsights(),
        loadSessionHistory(),
        loadPlaylistStats()
      ]);
    }

    async function loadTopData() {
      try {
        const [artistsRes, tracksRes] = await Promise.all([
          fetch('/api/me/top/artists?time_range=' + currentTimeRange + '&limit=10'),
          fetch('/api/me/top/tracks?time_range=' + currentTimeRange + '&limit=10')
        ]);
        
        const artists = await artistsRes.json();
        const tracks = await tracksRes.json();
        
        renderTopArtists(artists.items || []);
        renderTopTracks(tracks.items || []);
        renderTopGenres(artists.items || []);
      } catch (err) {
        console.error('Failed to load top data:', err);
      }
    }

    function renderTopArtists(artists) {
      const container = document.getElementById('topArtists');
      
      if (artists.length === 0) {
        container.innerHTML = '<div class="loading-state">No data available</div>';
        return;
      }
      
      container.innerHTML = artists.slice(0, 5).map((artist, i) => \`
        <div class="stat-item">
          <div class="stat-rank">\${i + 1}</div>
          <img src="\${artist.images[2]?.url || ''}" alt="" class="stat-cover">
          <div class="stat-info">
            <div class="stat-name">\${escapeHtml(artist.name)}</div>
            <div class="stat-detail">\${(artist.genres || []).slice(0, 2).join(', ') || 'Unknown genre'}</div>
          </div>
        </div>
      \`).join('');
    }

    function renderTopTracks(tracks) {
      const container = document.getElementById('topTracks');
      
      if (tracks.length === 0) {
        container.innerHTML = '<div class="loading-state">No data available</div>';
        return;
      }
      
      container.innerHTML = tracks.slice(0, 5).map((track, i) => \`
        <div class="stat-item">
          <div class="stat-rank">\${i + 1}</div>
          <img src="\${track.album.images[2]?.url || ''}" alt="" class="stat-cover">
          <div class="stat-info">
            <div class="stat-name">\${escapeHtml(track.name)}</div>
            <div class="stat-detail">\${escapeHtml(track.artists[0]?.name || 'Unknown')}</div>
          </div>
        </div>
      \`).join('');
    }

    function renderTopGenres(artists) {
      const container = document.getElementById('topGenres');
      
      // Count genres
      const genreCounts = {};
      artists.forEach(artist => {
        (artist.genres || []).forEach(genre => {
          genreCounts[genre] = (genreCounts[genre] || 0) + 1;
        });
      });
      
      const sortedGenres = Object.entries(genreCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      if (sortedGenres.length === 0) {
        container.innerHTML = '<div class="loading-state">No genre data</div>';
        return;
      }
      
      const maxCount = sortedGenres[0][1];
      
      container.innerHTML = sortedGenres.map(([genre, count]) => \`
        <div class="genre-bar">
          <div class="genre-name">\${escapeHtml(genre)}</div>
          <div class="genre-fill">
            <div class="genre-fill-inner" style="width: \${(count / maxCount) * 100}%"></div>
          </div>
          <div class="genre-count">\${count}</div>
        </div>
      \`).join('');
    }

    async function loadAIInsights() {
      const container = document.getElementById('aiInsights');
      container.innerHTML = '<div class="loading-state">✨ Generating insights...</div>';
      
      try {
        const res = await fetch('/api/ai-insights');
        const data = await res.json();
        container.innerHTML = '<p>' + (data.insights || 'Unable to generate insights').replace(/\\n/g, '</p><p>') + '</p>';
      } catch (err) {
        console.error('AI insights error:', err);
        container.innerHTML = '<div class="loading-state">Failed to generate insights</div>';
      }
    }

    async function loadSessionHistory() {
      const container = document.getElementById('sessionHistory');
      
      try {
        const res = await fetch('/api/session/history');
        const data = await res.json();
        
        if (!data.sessions || data.sessions.length === 0) {
          container.innerHTML = '<div class="loading-state">No sessions yet. Start a listening party!</div>';
          return;
        }
        
        container.innerHTML = data.sessions.slice(0, 5).map(session => {
          const date = new Date(session.created_at).toLocaleDateString();
          const mins = Math.floor(session.duration_seconds / 60);
          return \`
            <div class="session-item">
              <div class="session-date">\${date}</div>
              <div class="session-stats">
                <span>\${mins} min</span>
                <span>\${session.songs_sorted} songs</span>
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Session history error:', err);
        container.innerHTML = '<div class="loading-state">Failed to load history</div>';
      }
    }

    async function loadPlaylistStats() {
      const container = document.getElementById('playlistStats');
      
      try {
        const res = await fetch('/api/me/playlists?limit=50');
        const data = await res.json();
        const playlists = (data.items || []).filter(p => p.owner.id !== 'spotify');
        
        const totalPlaylists = playlists.length;
        const totalTracks = playlists.reduce((sum, p) => sum + p.tracks.total, 0);
        const avgTracks = totalPlaylists > 0 ? Math.round(totalTracks / totalPlaylists) : 0;
        
        container.innerHTML = \`
          <div class="playlist-stat-item">
            <span>Total Playlists</span>
            <span class="playlist-stat-value">\${totalPlaylists}</span>
          </div>
          <div class="playlist-stat-item">
            <span>Total Tracks</span>
            <span class="playlist-stat-value">\${totalTracks}</span>
          </div>
          <div class="playlist-stat-item">
            <span>Avg Tracks/Playlist</span>
            <span class="playlist-stat-value">\${avgTracks}</span>
          </div>
        \`;
      } catch (err) {
        console.error('Playlist stats error:', err);
        container.innerHTML = '<div class="loading-state">Failed to load stats</div>';
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    init();
  `;
}
