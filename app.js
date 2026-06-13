// ============================================
// PRODUCTION JUKEBOX - FRONTEND (API-Connected)
// ============================================

// Configuration
const API_URL = window.location.origin;
const WS_URL = `ws://${window.location.host}`;

// Application State
let queue = [];
let nowPlaying = null;
let searchTimeout = null;
let audioManager = null;
let ws = null;
let rateLimit = { allowed: true, timeRemaining: 0 };
let countdownInterval = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const nowPlayingSection = document.getElementById('nowPlayingSection');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingArtist = document.getElementById('nowPlayingArtist');
const nowPlayingAlbum = document.getElementById('nowPlayingAlbum');
const nowPlayingArt = document.getElementById('nowPlayingArt');
const progressFill = document.getElementById('progressFill');
const progressBarContainer = document.getElementById('progressBarContainer');
const currentTimeDisplay = document.getElementById('currentTime');
const durationDisplay = document.getElementById('duration');
const playPauseBtn = document.getElementById('playPauseBtn');
const skipBtn = document.getElementById('skipBtn');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const audioPlayer = document.getElementById('audioPlayer');

// ============================================
// WEBSOCKET CONNECTION
// ============================================

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('✅ WebSocket connected');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, attempting reconnect...');
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWebSocketMessage(message) {
  switch (message.type) {
    case 'init':
      queue = message.queue || [];
      nowPlaying = message.nowPlaying;
      updateQueueDisplay();
      if (nowPlaying) {
        updateNowPlayingDisplay();
      }
      break;

    case 'queue_updated':
      queue = message.data.queue || [];
      updateQueueDisplay();
      break;

    case 'now_playing':
      nowPlaying = message.data;
      if (nowPlaying) {
        updateNowPlayingDisplay();
        audioManager.loadAndPlay(nowPlaying);
      } else {
        nowPlayingSection.classList.add('hidden');
      }
      break;
  }
}

// ============================================
// AUDIO MANAGER
// ============================================

class AudioManager {
  constructor(audioElement) {
    this.audio = audioElement;
    this.isPlaying = false;
    this.currentSong = null;

    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', (e) => this.onError(e));
    this.audio.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
    this.audio.addEventListener('play', () => this.onPlay());
    this.audio.addEventListener('pause', () => this.onPause());
  }

  async loadAndPlay(song) {
    try {
      this.currentSong = song;
      if (song.preview_url) {
        this.audio.src = song.preview_url;
        this.audio.load();
        await this.audio.play();
        this.isPlaying = true;
        return true;
      }
      return false;
    } catch (error) {
      console.error('Playback error:', error);
      return false;
    }
  }

  play() {
    if (this.audio.src) {
      this.audio.play().catch(e => console.error('Play error:', e));
    }
  }

  pause() {
    this.audio.pause();
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  setVolume(volume) {
    this.audio.volume = volume / 100;
  }

  seek(percentage) {
    if (this.audio.duration) {
      this.audio.currentTime = (percentage / 100) * this.audio.duration;
    }
  }

  onTimeUpdate() {
    const current = this.audio.currentTime || 0;
    const duration = this.audio.duration || 0;

    if (duration > 0) {
      const percentage = (current / duration) * 100;
      progressFill.style.width = `${percentage}%`;
      currentTimeDisplay.textContent = formatTime(current);
    }
  }

  async onEnded() {
    // Auto-play next song
    try {
      const response = await fetch(`${API_URL}/api/play-next`, { method: 'POST' });
      const data = await response.json();
      // WebSocket will handle the update
    } catch (error) {
      console.error('Failed to play next:', error);
    }
  }

  onError(error) {
    console.error('Audio error:', error);
  }

  onMetadataLoaded() {
    const duration = this.audio.duration || 0;
    durationDisplay.textContent = formatTime(duration);
  }

  onPlay() {
    this.isPlaying = true;
    playPauseBtn.textContent = '⏸️';
    playPauseBtn.title = 'Pause';
  }

  onPause() {
    this.isPlaying = false;
    playPauseBtn.textContent = '▶️';
    playPauseBtn.title = 'Play';
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showNotification(message, type = 'info') {
  console.log(`🎵 ${message}`);

  // Create toast notification (simple version)
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: ${type === 'error' ? 'var(--accent)' : 'var(--primary)'};
    color: white;
    padding: 1rem 1.5rem;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 1000;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================
// RATE LIMIT UI
// ============================================

async function checkRateLimit() {
  try {
    const response = await fetch(`${API_URL}/api/rate-limit`);
    const data = await response.json();
    rateLimit = data;
    updateRateLimitUI();
    return data;
  } catch (error) {
    console.error('Rate limit check error:', error);
    return { allowed: true, timeRemaining: 0 };
  }
}

function updateRateLimitUI() {
  if (!rateLimit.allowed && rateLimit.timeRemaining > 0) {
    startCountdown(rateLimit.timeRemaining);
  } else {
    clearInterval(countdownInterval);
  }
}

function startCountdown(seconds) {
  let remaining = seconds;

  clearInterval(countdownInterval);
  countdownInterval = setInterval(async () => {
    remaining--;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      await checkRateLimit();
    }
  }, 1000);
}

// ============================================
// SEARCH FUNCTIONALITY
// ============================================

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();

  if (query.length === 0) {
    searchResults.innerHTML = '';
    return;
  }

  searchTimeout = setTimeout(async () => {
    await performSearch(query);
  }, 300);
});

async function performSearch(query) {
  try {
    const response = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }

    const data = await response.json();
    displaySearchResults(data.results);
  } catch (error) {
    console.error('Search error:', error);
    searchResults.innerHTML = `
      <div class="text-center" style="padding: 2rem; color: var(--text-muted);">
        <p style="font-size: 1.2rem;">❌ ${error.message}</p>
        <p style="font-size: 0.9rem; margin-top: 0.5rem;">Check server logs or SETUP.md</p>
      </div>
    `;
  }
}

function displaySearchResults(results) {
  if (results.length === 0) {
    searchResults.innerHTML = `
      <div class="text-center" style="padding: 2rem; color: var(--text-muted);">
        <p style="font-size: 1.2rem;">No songs found</p>
        <p style="font-size: 0.9rem; margin-top: 0.5rem;">Try a different search term</p>
      </div>
    `;
    return;
  }

  searchResults.innerHTML = results.map(song => {
    const albumArt = song.albumArt || 'https://via.placeholder.com/60';
    return `
      <div class="song-card" data-song-id="${song.id}">
        <img src="${albumArt}" alt="${song.title}" class="album-art-small" style="border-radius: var(--radius-sm);">
        <div class="song-info">
          <div class="song-title">${song.title}</div>
          <div class="song-artist">${song.artist}</div>
          <div class="song-album">${song.album}</div>
        </div>
        <button class="btn btn-primary add-to-queue-btn" data-song-id="${song.id}" ${!rateLimit.allowed ? 'disabled' : ''}>
          ${rateLimit.allowed ? 'Add to Queue' : `Wait ${Math.ceil(rateLimit.timeRemaining / 60)}min`}
        </button>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.add-to-queue-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const songId = btn.dataset.songId;
      await addToQueue(songId);
    });
  });
}

// ============================================
// QUEUE MANAGEMENT
// ============================================

async function addToQueue(songId) {
  try {
    const response = await fetch(`${API_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId })
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        showNotification(data.message, 'error');
        rateLimit = { allowed: false, timeRemaining: data.timeRemaining };
        updateRateLimitUI();
        return;
      }
      throw new Error(data.error);
    }

    showNotification(`✅ Added to queue (position ${data.position})`);
    rateLimit = { allowed: false, timeRemaining: data.nextRequestIn };
    updateRateLimitUI();
    searchInput.value = '';
    searchResults.innerHTML = '';
  } catch (error) {
    console.error('Add to queue error:', error);
    showNotification(error.message, 'error');
  }
}

function updateQueueDisplay() {
  queueCount.textContent = `${queue.length} song${queue.length !== 1 ? 's' : ''}`;

  if (queue.length === 0) {
    queueList.innerHTML = `
      <div class="queue-empty">
        <div class="queue-empty-icon">📭</div>
        <p>No songs in queue</p>
        <p style="font-size: 0.9rem; margin-top: 0.5rem;">Search and add songs to get started!</p>
      </div>
    `;
    return;
  }

  queueList.innerHTML = queue.map((song, index) => {
    const albumArt = song.album_art || 'https://via.placeholder.com/60';
    return `
      <div class="queue-item">
        <div class="queue-position">${index + 1}</div>
        <img src="${albumArt}" alt="${song.title}" class="album-art-small" style="border-radius: var(--radius-sm);">
        <div class="song-info">
          <div class="song-title">${song.title}</div>
          <div class="song-artist">${song.artist}</div>
        </div>
      </div>
    `;
  }).join('');
}

function updateNowPlayingDisplay() {
  if (!nowPlaying) return;

  nowPlayingSection.classList.remove('hidden');
  nowPlayingTitle.textContent = nowPlaying.title;
  nowPlayingArtist.textContent = nowPlaying.artist;
  nowPlayingAlbum.textContent = nowPlaying.album || '';

  const albumArt = nowPlaying.album_art || 'https://via.placeholder.com/180';
  nowPlayingArt.innerHTML = `<img src="${albumArt}" alt="${nowPlaying.title}" style="width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-lg);">`;

  progressFill.style.width = '0%';
  currentTimeDisplay.textContent = '0:00';
  durationDisplay.textContent = '0:00';
}

// ============================================
// PLAYBACK CONTROLS
// ============================================

playPauseBtn.addEventListener('click', () => {
  audioManager.togglePlayPause();
});

skipBtn.addEventListener('click', async () => {
  try {
    await fetch(`${API_URL}/api/play-next`, { method: 'POST' });
  } catch (error) {
    console.error('Skip error:', error);
  }
});

volumeSlider.addEventListener('input', (e) => {
  const volume = parseInt(e.target.value);
  audioManager.setVolume(volume);
  volumeValue.textContent = `${volume}%`;
});

progressBarContainer.addEventListener('click', (e) => {
  const rect = progressBarContainer.getBoundingClientRect();
  const percentage = ((e.clientX - rect.left) / rect.width) * 100;
  audioManager.seek(percentage);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    audioManager.togglePlayPause();
  } else if (e.code === 'ArrowRight') {
    skipBtn.click();
  }
});

// ============================================
// INITIALIZATION
// ============================================

async function initialize() {
  audioManager = new AudioManager(audioPlayer);
  audioManager.setVolume(70);

  connectWebSocket();
  await checkRateLimit();

  searchInput.focus();

  console.log('🎵 Jukebox initialized');
  console.log('📡 WebSocket:', WS_URL);
  console.log('🌐 API:', API_URL);
}

window.addEventListener('load', initialize);

// Clean up
window.addEventListener('beforeunload', () => {
  clearTimeout(searchTimeout);
  clearInterval(countdownInterval);
  if (audioManager) audioManager.pause();
  if (ws) ws.close();
});
