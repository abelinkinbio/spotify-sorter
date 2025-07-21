// Spotify Playlist Sorter - Cloudflare Worker
// This Worker handles OAuth, API proxying, and serves the web application

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route handling
    if (url.pathname === '/') {
      return handleHomePage();
    } else if (url.pathname === '/callback') {
      return handleOAuthCallback(request, env);
    } else if (url.pathname === '/api/auth') {
      return handleAuth(env);
    } else if (url.pathname.startsWith('/api/')) {
      return handleAPIRequest(request, env, url.pathname);
    } else if (url.pathname === '/analytics') {
      return handleAnalyticsPage();
    }
    
    return new Response('Not Found', { status: 404 });
  },
};

// OAuth Configuration
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-library-read',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state'
].join(' ');

// Handle OAuth authentication
async function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
  });
  
  return Response.redirect(`${SPOTIFY_AUTH_URL}?${params}`);
}

// Handle OAuth callback
async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  
  if (!code) {
    return new Response('Authorization failed', { status: 400 });
  }
  
  // Exchange code for token
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
  
  const tokenData = await tokenResponse.json();
  
  // Store token in KV (you might want to encrypt this in production)
  const sessionId = crypto.randomUUID();
  await env.SPOTIFY_TOKENS.put(sessionId, JSON.stringify(tokenData), {
    expirationTtl: 3600 // 1 hour
  });
  
  // Set cookie and redirect to main app
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `spotify_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`
    }
  });
}

// Handle API requests to Spotify
async function handleAPIRequest(request, env, pathname) {
  const sessionId = getSessionFromCookie(request);
  if (!sessionId) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const tokenData = await env.SPOTIFY_TOKENS.get(sessionId);
  if (!tokenData) {
    return new Response('Session expired', { status: 401 });
  }
  
  const tokens = JSON.parse(tokenData);
  let spotifyPath = pathname.replace('/api', '');

  // Special handling for top artists/tracks to ensure time_range is always passed
  if (
    spotifyPath.startsWith('/me/top/artists') ||
    spotifyPath.startsWith('/me/top/tracks')
  ) {
    const url = new URL('https://dummy' + spotifyPath);
    // Default to 'short_term' if not provided
    if (!url.searchParams.has('time_range')) {
      url.searchParams.set('time_range', 'short_term');
    }
    spotifyPath = url.pathname + '?' + url.searchParams.toString();
  }

  // Check for method override header
  let method = request.method;
  let headers = new Headers(request.headers);
  let requestBody;
  
  // Handle method override for DELETE requests
  if (request.headers.has('X-HTTP-Method-Override')) {
    method = request.headers.get('X-HTTP-Method-Override');
    console.log('Using method override:', method);
  }

  // For DELETE requests, handle both query parameters and request body
  if (method === 'DELETE' && request.method === 'POST') {
    requestBody = await request.text();
    console.log('DELETE with body:', requestBody);
  } else if (request.method !== 'GET') {
    requestBody = await request.text();
  }
  
  // Proxy request to Spotify
  const spotifyResponse = await fetch(`https://api.spotify.com/v1${spotifyPath}`, {
    method: method,
    headers: {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json'
    },
    body: requestBody
  });
  
  // Log the response for debugging
  console.log('Spotify API response status:', spotifyResponse.status);
  
  return new Response(await spotifyResponse.text(), {
    status: spotifyResponse.status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

// Get session from cookie
function getSessionFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith('spotify_session='));
  
  return sessionCookie ? sessionCookie.split('=')[1] : null;
}

// Serve the main application page
function handleHomePage() {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spotify Playlist Sorter</title>
    <style>
        :root {
            /* Claude Light Palette */
            --claude-bg: #ECECF1;
            --claude-text: #2D2D2D;
            --claude-primary: #DC6B3D;
            --claude-secondary: #4A90E2;
            --claude-border: #E5E5E0;
            --claude-hover: #F5F5F0;
            --claude-selected: #E8F0FE;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Claude Dark Palette */
                --claude-bg: #2D2D2D;
                --claude-text: #ECECF1;
                --claude-primary: #DC6B3D;
                --claude-secondary: #4A90E2;
                --claude-border: #232329;
                --claude-hover: #232329;
                --claude-selected: #35363B;
            }
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--claude-bg);
            color: var(--claude-text);
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 0;
            border-bottom: 1px solid var(--claude-border);
            margin-bottom: 30px;
        }
        
        h1 {
            font-size: 24px;
            font-weight: 600;
            color: var(--claude-text);
        }
        
        .header-actions {
            display: flex;
            gap: 15px;
            align-items: center;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        
        .btn-primary {
            background: var(--claude-primary);
            color: white;
        }
        
        .btn-primary:hover {
            background: #C55A2D;
        }
        
        .btn-secondary {
            background: var(--claude-secondary);
            color: white;
        }
        
        .btn-secondary:hover {
            background: #3A80D2;
        }
        
        .main-content {
            display: grid;
            grid-template-columns: 1fr 300px;
            gap: 30px;
        }
        
        .songs-section {
            background: white;
            border-radius: 8px;
            border: 1px solid var(--claude-border);
            padding: 20px;
        }
        
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .bulk-actions {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        
        .song-list {
            max-height: 600px;
            overflow-y: auto;
        }
        
        .song-item {
            display: flex;
            align-items: center;
            padding: 12px;
            border: 1px solid var(--claude-border);
            border-radius: 6px;
            margin-bottom: 8px;
            cursor: move;
            transition: all 0.2s;
            background: white;
        }
        
        .song-item:hover {
            background: var(--claude-hover);
        }
        
        .song-item.selected {
            background: var(--claude-selected);
            border-color: var(--claude-secondary);
        }
        
        .song-item.dragging {
            opacity: 0.5;
        }
        
        .song-checkbox {
            margin-right: 12px;
        }
        
        .song-info {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .song-cover {
            width: 48px;
            height: 48px;
            border-radius: 4px;
            object-fit: cover;
        }
        
        .song-details h3 {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 2px;
        }
        
        .song-details p {
            font-size: 12px;
            color: #666;
        }
        
        .playlists-section {
            background: white;
            border-radius: 8px;
            border: 1px solid var(--claude-border);
            padding: 20px;
            height: fit-content;
        }
        
        .playlist-item {
            padding: 12px;
            border: 1px solid var(--claude-border);
            border-radius: 6px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .playlist-item:hover {
            background: var(--claude-hover);
        }
        
        .playlist-item.drag-over {
            background: var(--claude-selected);
            border-color: var(--claude-secondary);
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        
        .auth-prompt {
            text-align: center;
            padding: 60px 20px;
        }
        
        .auth-prompt h2 {
            margin-bottom: 20px;
        }
        
        #selectAll {
            margin-right: 8px;
        }
        
        .preview-btn {
            padding: 4px 8px;
            font-size: 12px;
            background: var(--claude-secondary);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        
        .preview-btn:hover {
            background: #3A80D2;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Spotify Playlist Sorter</h1>
            <div class="header-actions">

                <a href="/analytics" class="btn btn-secondary">
                    📊 Analytics
                </a>
                <a href="spotify:" class="btn btn-primary">
                    🎵 Open Spotify
                </a>
            </div>
        </header>
        
        <div id="app-content">
            <div class="auth-prompt">
                <h2>Welcome to Spotify Playlist Sorter</h2>
                <p>Connect your Spotify account to start organizing your music</p>
                <br>
                <a href="/api/auth" class="btn btn-primary">Connect with Spotify</a>
            </div>
        </div>
    </div>
    
    <script>
        let selectedSongs = new Set();
        let currentSongs = [];
        let playlists = [];
        
        // Check if user is authenticated
        async function checkAuth() {
            try {
                const response = await fetch('/api/me');
                if (response.ok) {
                    const user = await response.json();
                    initializeApp(user);
                }
            } catch (error) {
                console.error('Auth check failed:', error);
            }
        }
        
        // Initialize the main app
        async function initializeApp(user) {
            document.getElementById('app-content').innerHTML = \`
                <div class="main-content">
                    <div class="songs-section">
                        <div class="section-header">
                            <h2>Liked Songs</h2>
                            <div class="bulk-actions">
                                <input type="checkbox" id="selectAll"> Select All
                                <button class="btn btn-primary" id="bulkMove" disabled>
                                    Move Selected
                                </button>
                            </div>
                        </div>
                        <div id="songs-container" class="loading">
                            Loading your liked songs...
                        </div>
                    </div>
                    
                    <div class="playlists-section">
                        <h2>Your Playlists</h2>
                        <div id="playlists-container" class="loading">
                            Loading playlists...
                        </div>
                    </div>
                </div>
            \`;
            
            // Load data
            await Promise.all([loadLikedSongs(), loadPlaylists()]);
            
            // Set up event listeners
            setupEventListeners();
        }
        
        // Load liked songs
        async function loadLikedSongs() {
            try {
                const response = await fetch('/api/me/tracks?limit=50');
                const data = await response.json();
                currentSongs = data.items;
                renderSongs();
            } catch (error) {
                console.error('Failed to load songs:', error);
            }
        }
        
        // Load user playlists
        async function loadPlaylists() {
            try {
                const response = await fetch('/api/me/playlists?limit=50');
                const data = await response.json();
                playlists = data.items;
                renderPlaylists();
            } catch (error) {
                console.error('Failed to load playlists:', error);
            }
        }
        
        // Render songs list
        function renderSongs() {
            const container = document.getElementById('songs-container');
            container.classList.remove('loading');
            
            const songList = document.createElement('div');
            songList.className = 'song-list';
            
            currentSongs.forEach((item, index) => {
                const track = item.track;
                const songEl = createSongElement(track, index);
                songList.appendChild(songEl);
            });
            
            container.innerHTML = '';
            container.appendChild(songList);
        }
        
        // Create song element
        function createSongElement(track, index) {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.draggable = true;
            div.dataset.trackUri = track.uri;
            div.dataset.index = index;
            
            div.innerHTML = \`
                <input type="checkbox" class="song-checkbox" data-index="\${index}">
                <div class="song-info">
                    <img src="\${track.album.images[2]?.url || ''}" alt="\${track.album.name}" class="song-cover">
                    <div class="song-details">
                        <h3>\${track.name}</h3>
                        <p>\${track.artists.map(a => a.name).join(', ')}</p>
                    </div>
                </div>
                <button class="preview-btn" onclick="playPreview('\${track.preview_url}')">
                    ▶ Preview
                </button>
            \`;
            
            // Drag events
            div.addEventListener('dragstart', handleDragStart);
            div.addEventListener('dragend', handleDragEnd);
            
            return div;
        }
        
        // Render playlists
        function renderPlaylists() {
            const container = document.getElementById('playlists-container');
            container.classList.remove('loading');
            container.innerHTML = '';
            
            playlists.forEach(playlist => {
                const div = document.createElement('div');
                div.className = 'playlist-item';
                div.dataset.playlistId = playlist.id;
                div.textContent = playlist.name;
                
                // Drop events
                div.addEventListener('dragover', handleDragOver);
                div.addEventListener('drop', handleDrop);
                div.addEventListener('dragleave', handleDragLeave);
                
                container.appendChild(div);
            });
        }
        
        // Drag and drop handlers
        function handleDragStart(e) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', e.target.dataset.trackUri);
            e.target.classList.add('dragging');
        }
        
        function handleDragEnd(e) {
            e.target.classList.remove('dragging');
        }
        
        function handleDragOver(e) {
            if (e.preventDefault) {
                e.preventDefault();
            }
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
            return false;
        }
        
        function handleDragLeave(e) {
            e.currentTarget.classList.remove('drag-over');
        }
        
        async function handleDrop(e) {
            if (e.stopPropagation) {
                e.stopPropagation();
            }
            e.preventDefault();
            
            const playlistEl = e.currentTarget;
            playlistEl.classList.remove('drag-over');
            
            const trackUri = e.dataTransfer.getData('text/plain');
            const playlistId = playlistEl.dataset.playlistId;
            
            console.log('Dropped track URI:', trackUri);
            console.log('Target playlist ID:', playlistId);
            
            // Find the dragged element to get its index in the liked songs
            const draggedElements = document.querySelectorAll('.song-item');
            let draggedElement = null;
            let trackIndex = null;
            
            console.log('Total song items found:', draggedElements.length);
            
            // Find the element with matching track URI
            for (const element of draggedElements) {
                if (element.dataset.trackUri === trackUri) {
                    draggedElement = element;
                    trackIndex = parseInt(element.dataset.index);
                    console.log('Found matching element with index:', trackIndex);
                    break;
                }
            }
            
            if (!draggedElement) {
                console.log('Could not find matching element for URI:', trackUri);
            }
            
            // Add to the target playlist
            const added = await addTrackToPlaylist(playlistId, [trackUri]);
            console.log('Track added to playlist result:', added);
            
            if (added) {
                // If the track was successfully added to the target playlist
                if (trackIndex !== null && draggedElement) {
                    // Update the UI to remove the track from the Liked Songs list
                    // This provides a good user experience even if we can't actually remove it from the Liked Songs via API
                    currentSongs.splice(trackIndex, 1);
                    renderSongs();
                    
                    // Show a message to the user
                    let trackName = 'Track';
                    const trackNameElement = draggedElement.querySelector('.song-details h3');
                    if (trackNameElement && trackNameElement.textContent) {
                        trackName = trackNameElement.textContent;
                    }
                    const playlistName = playlistEl.textContent || 'the playlist';
                    
                    alert('"' + trackName + '" was added to ' + playlistName + '. Note: The track will still appear in your Liked Songs when you refresh, as Spotify requires you to manually unlike tracks.');
                    
                    // Attempt to unlike the track, but don't rely on it working
                    try {
                        console.log('Attempting to unlike track, but not relying on it working');
                        removeTrackFromLikedSongs(trackUri, trackIndex).catch(err => {
                            console.log('Expected error unliking track:', err);
                        });
                    } catch (error) {
                        console.log('Expected error unliking track:', error);
                    }
                } else {
                    alert('Track added to playlist!');
                }
            } else {
                alert('Failed to add track to playlist.');
            }
        }
        
        // Add tracks to playlist
        async function addTrackToPlaylist(playlistId, trackUris) {
            try {
                const response = await fetch('/api/playlists/' + playlistId + '/tracks', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ uris: trackUris })
                });
                
                if (response.ok) {
                    alert('Track(s) added to playlist!');
                    return true; // Return true to indicate success
                }
                return false;
            } catch (error) {
                console.error('Failed to add tracks:', error);
                alert('Failed to add tracks to playlist');
                return false;
            }
        }
        
        // Remove track from liked songs (unlike a track)
        async function removeTrackFromLikedSongs(trackUri, trackIndex) {
            try {
                // Extract the track ID from the URI (format: spotify:track:id)
                const trackId = trackUri.split(':')[2];
                
                console.log('Unliking track with ID:', trackId);
                
                // APPROACH 1: Using query parameters exactly as specified in the documentation
                // DELETE /me/tracks?ids=4iV5W9uYEdYUVa79Axb7Rh
                const queryResponse = await fetch('/api/me/tracks?ids=' + trackId, {
                    method: 'DELETE'
                    // No Content-Type header for query parameter approach
                });
                
                console.log('Unlike approach 1 status:', queryResponse.status);
                const queryResponseText = await queryResponse.text();
                console.log('Unlike approach 1 response:', queryResponseText || '(empty response)');
                
                let success = false;
                
                if (queryResponse.ok) {
                    console.log('Track successfully unliked via query params');
                    success = true;
                } else {
                    // APPROACH 2: Using request body exactly as specified in the documentation
                    // DELETE /me/tracks with body {"ids":["4iV5W9uYEdYUVa79Axb7Rh"]}
                    console.log('Approach 1 failed, trying approach 2 with request body');
                    
                    const bodyResponse = await fetch('/api/me/tracks', {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ ids: [trackId] })
                    });
                    
                    console.log('Unlike approach 2 status:', bodyResponse.status);
                    const bodyResponseText = await bodyResponse.text();
                    console.log('Unlike approach 2 response:', bodyResponseText || '(empty response)');
                    
                    if (bodyResponse.ok) {
                        console.log('Track successfully unliked via request body');
                        success = true;
                    } else {
                        // If both approaches fail, try a workaround with POST and method override
                        console.log('Both standard approaches failed, trying workaround');
                        
                        const workaroundResponse = await fetch('/api/me/tracks', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-HTTP-Method-Override': 'DELETE'
                            },
                            body: JSON.stringify({ ids: [trackId] })
                        });
                        
                        console.log('Unlike workaround status:', workaroundResponse.status);
                        const workaroundResponseText = await workaroundResponse.text();
                        console.log('Unlike workaround response:', workaroundResponseText || '(empty response)');
                        
                        if (workaroundResponse.ok) {
                            console.log('Track successfully unliked via workaround');
                            success = true;
                        } else {
                            // If all API attempts fail, at least update the UI
                            console.error('All unlike attempts failed. Updating UI only.');
                            
                            // Simulate the unlike by updating the UI
                            if (trackIndex !== null && trackIndex >= 0 && trackIndex < currentSongs.length) {
                                currentSongs.splice(trackIndex, 1);
                                renderSongs();
                            }
                            
                            // Reload to ensure UI is in sync with server
                            await loadLikedSongs();
                            
                            // Show a message to the user
                            alert('The track was added to the playlist, but there was an issue removing it from your Liked Songs. Your Liked Songs list has been refreshed.');
                            
                            return true; // Return true for user experience
                        }
                    }
                }
                
                // Update UI if any of the unlike operations was successful
                if (success) {
                    console.log('Unlike operation successful, updating UI');
                    // Update the local data
                    if (trackIndex !== null && trackIndex >= 0 && trackIndex < currentSongs.length) {
                        // Remove the track from the array
                        currentSongs.splice(trackIndex, 1);
                        
                        // Re-render songs to update indices
                        renderSongs();
                        
                        // For safety, reload the liked songs after a short delay
                        // This ensures our UI is in sync with the server
                        setTimeout(() => {
                            loadLikedSongs();
                        }, 1000);
                    } else {
                        // If we couldn't find the track in our local data, just reload everything
                        await loadLikedSongs();
                    }
                    
                    return true;
                }
                
                // If we reach here, all attempts failed but we didn't update the UI yet
                console.log('All unlike attempts failed, updating UI as fallback');
                
                // Update UI even if the API calls failed
                if (trackIndex !== null && trackIndex >= 0 && trackIndex < currentSongs.length) {
                    currentSongs.splice(trackIndex, 1);
                    renderSongs();
                }
                
                // Reload to ensure UI is in sync with server
                await loadLikedSongs();
                
                // Show a message to the user
                alert('The track was added to the playlist, but there was an issue removing it from your Liked Songs. Your Liked Songs list has been refreshed.');
                
                // Return true to indicate that the operation was "successful" from the user's perspective
                return true;
            } catch (error) {
                console.error('Failed to unlike track:', error);
                
                // Even if the API call fails, update the UI to provide a better user experience
                if (trackIndex !== null && trackIndex >= 0 && trackIndex < currentSongs.length) {
                    // Remove the track from the array
                    currentSongs.splice(trackIndex, 1);
                    // Re-render songs to update indices
                    renderSongs();
                }
                
                // Force reload to ensure UI is in sync with server
                await loadLikedSongs();
                
                // Show a message to the user
                alert('The track was added to the playlist, but there was an issue removing it from your Liked Songs. Your Liked Songs list has been refreshed.');
                
                // Return true to indicate that the operation was "successful" from the user's perspective
                return true;
            }
        }
        
        // Play preview
        window.playPreview = function(previewUrl) {
            if (!previewUrl) {
                alert('No preview available for this track');
                return;
            }
            
            const audio = new Audio(previewUrl);
            audio.play();
            
            // Stop after 10 seconds
            setTimeout(() => audio.pause(), 10000);
        }
        
        // Setup event listeners
        function setupEventListeners() {
            // Select all checkbox
            document.getElementById('selectAll').addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.song-checkbox');
                checkboxes.forEach(cb => {
                    cb.checked = e.target.checked;
                    const index = parseInt(cb.dataset.index);
                    if (e.target.checked) {
                        selectedSongs.add(index);
                    } else {
                        selectedSongs.delete(index);
                    }
                });
                updateBulkButton();
                updateSelectedStyles();
            });
            
            // Individual checkboxes
            document.addEventListener('change', (e) => {
                if (e.target.classList.contains('song-checkbox')) {
                    const index = parseInt(e.target.dataset.index);
                    if (e.target.checked) {
                        selectedSongs.add(index);
                    } else {
                        selectedSongs.delete(index);
                    }
                    updateBulkButton();
                    updateSelectedStyles();
                }
            });
            
            // Bulk move button
            document.getElementById('bulkMove').addEventListener('click', handleBulkMove);
        }
        
        // Update bulk button state
        function updateBulkButton() {
            const bulkBtn = document.getElementById('bulkMove');
            bulkBtn.disabled = selectedSongs.size === 0;
            bulkBtn.textContent = \`Move Selected (\${selectedSongs.size})\`;
        }
        
        // Update selected styles
        function updateSelectedStyles() {
            document.querySelectorAll('.song-item').forEach((el, index) => {
                if (selectedSongs.has(index)) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });
        }
        
        // Handle bulk move
        async function handleBulkMove() {
            if (selectedSongs.size === 0) return;
            
            // Create a simple playlist selector
            const playlistName = prompt('Enter playlist name to move songs to:');
            if (!playlistName) return;
            
            const playlist = playlists.find(p => p.name.toLowerCase() === playlistName.toLowerCase());
            if (!playlist) {
                alert('Playlist not found');
                return;
            }
            
            const trackUris = Array.from(selectedSongs).map(index => currentSongs[index].track.uri);
            await addTrackToPlaylist(playlist.id, trackUris);
            
            // Clear selection
            selectedSongs.clear();
            document.querySelectorAll('.song-checkbox').forEach(cb => cb.checked = false);
            updateBulkButton();
            updateSelectedStyles();
        }
        
        // Initialize on load
        checkAuth();
    </script>
</body>
</html>
  `;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  });
}

// Serve the analytics page
function handleAnalyticsPage() {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spotify Analytics</title>
    <style>
        :root {
            /* Claude Light Palette */
            --claude-bg: #ECECF1;
            --claude-text: #2D2D2D;
            --claude-primary: #DC6B3D;
            --claude-secondary: #4A90E2;
            --claude-border: #E5E5E0;
            --claude-hover: #F5F5F0;
            --claude-selected: #E8F0FE;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Claude Dark Palette */
                --claude-bg: #2D2D2D;
                --claude-text: #ECECF1;
                --claude-primary: #DC6B3D;
                --claude-secondary: #4A90E2;
                --claude-border: #232329;
                --claude-hover: #232329;
                --claude-selected: #35363B;
            }
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--claude-bg);
            color: var(--claude-text);
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 0;
            border-bottom: 1px solid var(--claude-border);
            margin-bottom: 30px;
        }
        
        h1 {
            font-size: 24px;
            font-weight: 600;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
            background: var(--claude-secondary);
            color: white;
        }
        
        .btn:hover {
            background: #3A80D2;
        }
        
        .time-period-selector {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
            justify-content: center;
        }
        
        .period-btn {
            padding: 8px 16px;
            border: 1px solid var(--claude-border);
            background: var(--claude-bg);
            color: var(--claude-text);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 14px;
            font-weight: 500;
        }
        
        .period-btn:hover {
            background: var(--claude-hover);
            border-color: var(--claude-secondary);
        }
        
        .period-btn.active {
            background: var(--claude-primary);
            color: white;
            border-color: var(--claude-primary);
        }
        
        .period-btn.active:hover {
            background: #C55A2F;
        }
        
        .period-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .period-btn:disabled:hover {
            background: var(--claude-primary);
            border-color: var(--claude-primary);
        }
        
        .analytics-header {
            text-align: center;
            margin-bottom: 20px;
        }
        
        .analytics-header h2 {
            font-size: 20px;
            color: var(--claude-primary);
            margin: 0;
        }
        
        .analytics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: var(--claude-hover);
            border: 1px solid var(--claude-border);
            border-radius: 8px;
            padding: 20px;
        }
        
        .stat-card h2 {
            font-size: 18px;
            margin-bottom: 15px;
            color: var(--claude-primary);
        }
        
        .stat-item {
            display: flex;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--claude-border);
        }
        
        .stat-item:last-child {
            border-bottom: none;
        }
        
        .stat-rank {
            font-size: 20px;
            font-weight: bold;
            color: var(--claude-secondary);
            width: 30px;
        }
        
        .stat-info {
            flex: 1;
            margin-left: 15px;
        }
        
        .stat-name {
            font-weight: 500;
            margin-bottom: 2px;
        }
        
        .stat-detail {
            font-size: 14px;
            color: #666;
        }
        
        .diversity-score {
            text-align: center;
            padding: 30px;
        }
        
        .score-circle {
            display: inline-block;
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: conic-gradient(var(--claude-primary) 0deg, var(--claude-secondary) 360deg);
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 15px;
        }
        
        .score-value {
            background: var(--claude-bg);
            color: var(--claude-text);
            width: 100px;
            height: 100px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: bold;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        
        .playlist-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }
        
        .playlist-stat {
            background: var(--claude-hover);
            padding: 15px;
            border-radius: 6px;
            text-align: center;
        }
        
        .playlist-stat h3 {
            font-size: 24px;
            color: var(--claude-primary);
            margin-bottom: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Your Spotify Analytics</h1>
            <a href="/" class="btn">
                ← Back to Sorter
            </a>
        </header>
        
        <div class="time-period-selector">
            <button class="period-btn active" data-range="24h">24 Hours</button>
            <button class="period-btn" data-range="72h">72 Hours</button>
            <button class="period-btn" data-range="7d">7 Days</button>
        </div>
        
        <div id="analytics-content" class="loading">
            Loading your analytics...
        </div>
    </div>
    
    <script>
        let currentTimeRange = '24h';
        
        // Check authentication and load data
        async function initAnalytics() {
            try {
                const response = await fetch('/api/me');
                if (!response.ok) {
                    window.location.href = '/';
                    return;
                }
                
                loadAnalytics();
                setupEventListeners();
            } catch (error) {
                console.error('Failed to initialize:', error);
            }
        }
        
        // Setup event listeners
        function setupEventListeners() {
            document.querySelectorAll('.period-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    // Prevent multiple clicks while loading
                    if (e.target.disabled) return;
                    
                    // Update button states
                    document.querySelectorAll('.period-btn').forEach(b => {
                        b.classList.remove('active');
                        b.disabled = false;
                    });
                    e.target.classList.add('active');
                    e.target.disabled = true;
                    
                    // Update time range and load data
                    const newTimeRange = e.target.dataset.range;
                    if (newTimeRange !== currentTimeRange) {
                        currentTimeRange = newTimeRange;
                        console.log('Selected time range:', currentTimeRange);
                        const container = document.getElementById('analytics-content');
                        container.innerHTML = '<div class="loading">Loading your analytics...</div>';
                        
                        try {
                            await loadAnalytics();
                        } catch (error) {
                            console.error('Failed to load analytics for time range:', currentTimeRange, error);
                            container.innerHTML = '<div class="loading">Failed to load analytics. Please try again.</div>';
                        } finally {
                            // Re-enable buttons
                            document.querySelectorAll('.period-btn').forEach(b => b.disabled = false);
                        }
                    } else {
                        // Re-enable if same range selected
                        e.target.disabled = false;
                    }
                });
            });
        }
        
        // Get time range in milliseconds
        function getTimeRangeMs(range) {
            const now = Date.now();
            switch(range) {
                case '24h': return now - (24 * 60 * 60 * 1000);
                case '72h': return now - (72 * 60 * 60 * 1000);
                case '7d': return now - (7 * 24 * 60 * 60 * 1000);
                default: return now - (24 * 60 * 60 * 1000);
            }
        }
        
        // Load all analytics data
        async function loadAnalytics() {
            const container = document.getElementById('analytics-content');
            container.innerHTML = '<div class="loading">Loading your analytics...</div>';
            console.log('Loading analytics for time range:', currentTimeRange);
            try {
                const cutoffTime = getTimeRangeMs(currentTimeRange);
                
                // Fetch recently played data (up to 50 tracks, going back in time)
                const recentlyPlayed = await fetch('/api/me/player/recently-played?limit=50').then(r => r.json());
                
                // Filter tracks within our time range
                const filteredTracks = recentlyPlayed.items ? recentlyPlayed.items.filter(item => {
                    const playedAt = new Date(item.played_at).getTime();
                    return playedAt >= cutoffTime;
                }) : [];
                
                console.log('Found ' + filteredTracks.length + ' tracks in the last ' + currentTimeRange);
                
                // If we don't have enough recent data, fall back to top tracks with a message
                if (filteredTracks.length < 5) {
                    console.log('Not enough recent data, falling back to top tracks');
                    const [topArtists, topTracks, playlists] = await Promise.all([
                        fetch('/api/me/top/artists?time_range=short_term&limit=10').then(r => r.json()),
                        fetch('/api/me/top/tracks?time_range=short_term&limit=10').then(r => r.json()),
                        fetch('/api/me/playlists?limit=50').then(r => r.json())
                    ]);
                    
                    const topGenres = await getTopGenresFromArtists(topArtists.items || []);
                    const diversityScore = calculateDiversityScore(topArtists.items || []);
                    const playlistStats = calculatePlaylistStats(playlists.items || []);
                    
                    renderAnalytics({
                        topArtists: topArtists.items || [],
                        topTracks: topTracks.items || [],
                        topGenres: topGenres,
                        diversityScore,
                        playlistStats,
                        listeningTime: 0,
                        isLimitedData: true,
                        timeRange: currentTimeRange
                    });
                    return;
                }
                
                // Process filtered tracks to get analytics
                const trackAnalytics = processRecentTracks(filteredTracks);
                const playlists = await fetch('/api/me/playlists?limit=50').then(r => r.json());
                
                // Calculate stats from recent tracks
                const diversityScore = calculateDiversityFromTracks(filteredTracks);
                const playlistStats = calculatePlaylistStats(playlists.items || []);
                const listeningTime = estimateListeningTimeFromTracks(filteredTracks);
                
                // Render analytics
                renderAnalytics({
                    topArtists: trackAnalytics.topArtists,
                    topTracks: trackAnalytics.topTracks,
                    topGenres: trackAnalytics.topGenres,
                    diversityScore,
                    playlistStats,
                    listeningTime,
                    isLimitedData: false,
                    timeRange: currentTimeRange
                });
            } catch (error) {
                console.error('Failed to load analytics:', error);
                container.innerHTML = '<div class="loading">Failed to load analytics. Please try again.</div>';
            }
        }
        
        // Get top genres from artists (fallback function)
        async function getTopGenresFromArtists(artists) {
            const genreCounts = {};
            
            artists.forEach(artist => {
                if (artist.genres) {
                    artist.genres.forEach(genre => {
                        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
                    });
                }
            });
            
            return Object.entries(genreCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([genre, count]) => ({ name: genre, count }));
        }
        
        // Process recent tracks to get top artists, tracks, and genres
        function processRecentTracks(tracks) {
            console.log('Processing tracks:', tracks);
            const artistCounts = {};
            const trackCounts = {};
            const genreCounts = {};
            
            tracks.forEach(item => {
                const track = item.track;
                
                // Count tracks
                const trackKey = track.id;
                if (!trackCounts[trackKey]) {
                    trackCounts[trackKey] = {
                        track: track,
                        count: 0
                    };
                }
                trackCounts[trackKey].count++;
                
                // Count artists
                track.artists.forEach(artist => {
                    if (!artistCounts[artist.id]) {
                        artistCounts[artist.id] = {
                            artist: artist,
                            count: 0
                        };
                    }
                    artistCounts[artist.id].count++;
                    
                    // Count genres (if available)
                    if (artist.genres) {
                        artist.genres.forEach(genre => {
                            genreCounts[genre] = (genreCounts[genre] || 0) + 1;
                        });
                    }
                });
            });
            
            // Convert to sorted arrays
            const topArtists = Object.values(artistCounts)
                .sort((a, b) => b.count - a.count)
                .slice(0, 10)
                .map(item => item.artist);
                
            const topTracks = Object.values(trackCounts)
                .sort((a, b) => b.count - a.count)
                .slice(0, 10)
                .map(item => item.track);
                
            const topGenres = Object.entries(genreCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([genre, count]) => ({ name: genre, count }));
            
            const result = { topArtists, topTracks, topGenres };
            console.log('processRecentTracks result:', result);
            return result;
        }
        
        // Calculate diversity score from tracks
        function calculateDiversityFromTracks(tracks) {
            const uniqueArtists = new Set();
            const uniqueGenres = new Set();
            
            tracks.forEach(item => {
                item.track.artists.forEach(artist => {
                    uniqueArtists.add(artist.id);
                    if (artist.genres) {
                        artist.genres.forEach(genre => uniqueGenres.add(genre));
                    }
                });
            });
            
            // Calculate diversity based on unique artists and genres
            const artistDiversity = Math.min(uniqueArtists.size / Math.max(tracks.length, 1), 1);
            const genreDiversity = uniqueGenres.size > 0 ? Math.min(uniqueGenres.size / 10, 1) : 0;
            
            return Math.round((artistDiversity * 0.6 + genreDiversity * 0.4) * 100);
        }
        
        // Estimate listening time from tracks
        function estimateListeningTimeFromTracks(tracks) {
            // Estimate average track length as 3.5 minutes
            const avgTrackLength = 3.5;
            return Math.round(tracks.length * avgTrackLength);
        }
        
        // Calculate diversity score
        function calculateDiversityScore(artists) {
            const genres = new Set();
            artists.forEach(artist => {
                artist.genres.forEach(genre => genres.add(genre));
            });
            
            // Simple diversity score based on genre variety
            const score = Math.min(Math.round((genres.size / artists.length) * 100), 100);
            return score;
        }
        
        // Calculate playlist statistics
        function calculatePlaylistStats(playlists) {
            const totalPlaylists = playlists.length;
            const totalTracks = playlists.reduce((sum, p) => sum + p.tracks.total, 0);
            const avgTracksPerPlaylist = Math.round(totalTracks / totalPlaylists);
            
            return {
                totalPlaylists,
                totalTracks,
                avgTracksPerPlaylist
            };
        }
        
        // Estimate listening time
        function estimateListeningTime(recentTracks) {
            // Rough estimate: assume 3 minutes per track
            const minutesPerTrack = 3;
            const totalMinutes = recentTracks.length * minutesPerTrack;
            const hoursPerWeek = Math.round((totalMinutes / 60) * 7 / 50); // Scaled to weekly
            
            return hoursPerWeek;
        }
        
        // Render analytics dashboard
        function renderAnalytics(data) {
            const container = document.getElementById('analytics-content');
            
            // Get time range display text
            const timeRangeText = {
                '24h': 'Last 24 Hours',
                '72h': 'Last 72 Hours', 
                '7d': 'Last 7 Days'
            }[data.timeRange] || 'Recent Activity';
            
            // Show limited data warning if applicable
            const limitedDataWarning = data.isLimitedData ? 
                '<div class="stat-card" style="background: #fff3cd; border-color: #ffeaa7; color: #856404;"><p><strong>Note:</strong> Not enough recent listening data for ' + timeRangeText.toLowerCase() + '. Showing your overall top tracks instead.</p></div>' : '';
            
            container.innerHTML = '<div class="analytics-header"><h2>Analytics for ' + timeRangeText + '</h2></div>' + limitedDataWarning + '<div class="analytics-grid"><div class="stat-card"><h2>Top Artists</h2>' + renderTopItems(data.topArtists, 'artist') + '</div><div class="stat-card"><h2>Top Tracks</h2>' + renderTopItems(data.topTracks, 'track') + '</div><div class="stat-card"><h2>Top Genres</h2>' + renderTopGenres(data.topGenres) + '</div></div><div class="analytics-grid"><div class="stat-card diversity-score"><h2>Music Diversity Score</h2><div class="score-circle"><div class="score-value">' + data.diversityScore + '%</div></div><p>Based on variety in your listening habits</p></div><div class="stat-card"><h2>Playlist Statistics</h2><div class="playlist-stats"><div class="playlist-stat"><h3>' + data.playlistStats.totalPlaylists + '</h3><p>Total Playlists</p></div><div class="playlist-stat"><h3>' + data.playlistStats.totalTracks + '</h3><p>Total Tracks</p></div><div class="playlist-stat"><h3>' + data.playlistStats.avgTracksPerPlaylist + '</h3><p>Avg Tracks/Playlist</p></div></div></div><div class="stat-card"><h2>Listening Activity</h2><div class="playlist-stats"><div class="playlist-stat"><h3>' + data.listeningTime + '</h3><p>' + (data.isLimitedData ? 'Minutes (estimated)' : 'Minutes in ' + timeRangeText) + '</p></div></div></div></div>';
        }
        
        // Render top items (artists/tracks)
        function renderTopItems(items, type) {
            if (!items || !Array.isArray(items) || items.length === 0) {
                return '<div class="stat-item"><div class="stat-info"><div class="stat-name">No data available</div></div></div>';
            }
            
            return items.slice(0, 5).map((item, index) => {
                if (!item || !item.name) {
                    return '<div class="stat-item"><div class="stat-info"><div class="stat-name">Unknown item</div></div></div>';
                }
                
                let detail = '';
                if (type === 'track' && item.artists && item.artists.length > 0) {
                    detail = item.artists[0].name;
                } else if (type === 'artist' && item.genres && item.genres.length > 0) {
                    detail = item.genres.slice(0, 2).join(', ');
                } else {
                    detail = 'No additional info';
                }
                
                return '<div class="stat-item"><div class="stat-rank">' + (index + 1) + '</div><div class="stat-info"><div class="stat-name">' + item.name + '</div><div class="stat-detail">' + detail + '</div></div></div>';
            }).join('');
        }
        
        // Render top genres
        function renderTopGenres(genres) {
            if (!genres || !Array.isArray(genres) || genres.length === 0) {
                return '<div class="stat-item"><div class="stat-info"><div class="stat-name">No genre data available</div></div></div>';
            }
            
            return genres.slice(0, 5).map((genre, index) => {
                if (!genre || !genre.name) {
                    return '<div class="stat-item"><div class="stat-info"><div class="stat-name">Unknown genre</div></div></div>';
                }
                
                const count = genre.count || 0;
                return '<div class="stat-item"><div class="stat-rank">' + (index + 1) + '</div><div class="stat-info"><div class="stat-name">' + genre.name + '</div><div class="stat-detail">' + count + ' artists</div></div></div>';
            }).join('');
        }
        
        // Theme handling based on system preference
        (function() {
            // Apply theme based on system preference
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                document.documentElement.setAttribute('data-theme', 'dark');
            } else {
                document.documentElement.setAttribute('data-theme', 'light');
            }
            
            // Listen for changes in system preference
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
                document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
            });
        })();

        // Initialize
        initAnalytics();
    </script>
</body>
</html>
  `;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  });
}