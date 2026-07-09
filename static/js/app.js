/* ── Tunino App ── */

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function playlistDuration(pl) {
  const total = (pl.items || []).reduce((sum, item) => sum + (item.track?.duration || 0), 0);
  if (!total) return '0m';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tunino() {
  return {
    /* ── Auth state ── */
    currentUser: null,
    authenticated: false,
    authChecked: false,
    loginForm: { username: '', password: '' },
    loginError: '',
    loginLoading: false,

    /* ── State ── */
    playlists: [],
    activePlaylist: null,
    showCreateModal: false,
    showEditModal: false,
    showShareModal: false,
    newPlaylist: { name: '', bg_color: '#1a1a2e' },
    editForm: { name: '', bg_color: '#1a1a2e' },
    collaborators: [],
    allUsers: [],
    shareUsername: '',
    addUrl: '',
    addLoading: false,

    // Player
    audio: null,
    currentTrack: null,      // track object
    currentItemIndex: null,  // index in activePlaylist.items
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    seeking: false,

    sidebarOpen: false,
    dragSrcIndex: null,
    recommendations: [],
    seenRecUrls: [],
    recsLoading: false,
    recsLoaded: false,
    previewingUrl: null,
    recDropdownOpen: null,

    /* ── Init ── */
    async init() {
      try {
        this.currentUser = await this.api('GET', '/auth/me');
        this.authenticated = true;
      } catch (e) {
        this.authenticated = false;
      }
      this.authChecked = true;
      if (this.authenticated) await this._initApp();
    },

    async _initApp() {
      this.audio = new Audio();
      this.audio.volume = this.volume;
      this.audio.addEventListener('timeupdate', () => {
        if (!this.seeking) {
          this.currentTime = this.audio.currentTime;
          this.duration = this.audio.duration || 0;
          this._updateProgressBar();
        }
      });
      this.audio.addEventListener('ended', () => this.next());
      this.audio.addEventListener('play', () => { this.playing = true; });
      this.audio.addEventListener('pause', () => { this.playing = false; });
      this.audio.addEventListener('error', () => {
        this.showToast('Playback error — the audio URL may have expired. Try clicking play again.', true);
        this.playing = false;
      });
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) {
          e.preventDefault();
          this.togglePlay();
        }
      });
      await this.loadPlaylists();
    },

    /* ── Auth ── */
    async login() {
      if (!this.loginForm.username.trim() || !this.loginForm.password) return;
      this.loginLoading = true;
      this.loginError = '';
      try {
        this.currentUser = await this.api('POST', '/auth/login', this.loginForm);
        this.authenticated = true;
        this.loginForm = { username: '', password: '' };
        await this._initApp();
      } catch (e) {
        this.loginError = e.message || 'Login failed';
      } finally {
        this.loginLoading = false;
      }
    },

    async logout() {
      try {
        await this.api('POST', '/auth/logout');
      } catch (e) { /* ignore */ }
      this.currentUser = null;
      this.authenticated = false;
      this.playlists = [];
      this.activePlaylist = null;
      if (this.audio) this.audio.pause();
      this.currentTrack = null;
      this.currentItemIndex = null;
    },

    /* ── API helpers ── */
    async api(method, path, body) {
      const opts = { method, headers: {} };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const r = await fetch('/api' + path, opts);
      if (r.status === 401) {
        this.authenticated = false;
        this.currentUser = null;
        throw new Error('Not authenticated');
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || r.statusText);
      }
      if (r.status === 204) return null;
      return r.json();
    },

    /* ── Playlists ── */
    async loadPlaylists() {
      this.playlists = await this.api('GET', '/playlists');
    },

    coverUrl(pl) {
      return pl.cover_image ? `/uploads/${pl.cover_image}` : null;
    },

    trackCount(pl) {
      return pl.items?.length ?? 0;
    },

    async selectPlaylist(pl) {
      this.activePlaylist = await this.api('GET', `/playlists/${pl.id}`);
      this.sidebarOpen = false;
      this._updateHeaderColor();
      this.recommendations = [];
      this.seenRecUrls = [];
      this.recsLoaded = false;
    },

    async loadRecommendations() {
      if (!this.activePlaylist || this.recsLoading) return;
      this.recsLoading = true;
      this.recommendations = [];
      try {
        const params = new URLSearchParams();
        if (this.currentTrack?.id) params.set('track_id', this.currentTrack.id);
        this.seenRecUrls.forEach(u => params.append('exclude', u));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const fresh = await this.api('GET', `/playlists/${this.activePlaylist.id}/recommendations${qs}`);
        this.seenRecUrls = [...new Set([...this.seenRecUrls, ...fresh.map(r => r.url)])];
        this.recommendations = fresh;
        this.recsLoaded = true;
      } catch (e) {
        this.showToast('Could not load recommendations.', true);
      } finally {
        this.recsLoading = false;
      }
    },

    async addRecommendation(rec) {
      const wasPreviewingThis = this.previewingUrl === rec.audio_url;
      if (!wasPreviewingThis) this.stopPreview();
      this.addUrl = rec.url;
      await this.addTrack();
      this.recommendations = this.recommendations.filter(r => r.url !== rec.url);
      if (wasPreviewingThis) {
        // Re-anchor the still-playing audio to the newly added playlist item
        const items = this.activePlaylist.items;
        const idx = [...items].reverse().findIndex(i => i.track.bandcamp_url === rec.url);
        if (idx !== -1) {
          const realIdx = items.length - 1 - idx;
          this.currentItemIndex = realIdx;
          this.currentTrack = items[realIdx].track;
          this.previewingUrl = null;
        }
      }
    },

    async addRecommendationToPlaylist(rec, targetPlaylist) {
      this.recDropdownOpen = null;
      if (targetPlaylist.id === this.activePlaylist?.id) {
        await this.addRecommendation(rec);
        return;
      }
      try {
        const updated = await this.api('POST', `/playlists/${targetPlaylist.id}/tracks/single`, {
          url: rec.url,
        });
        this._syncSidebarPlaylist(updated);
        this.recommendations = this.recommendations.filter(r => r.url !== rec.url);
        this.showToast(`Added to "${targetPlaylist.name}"`);
      } catch (e) {
        this.showToast('Failed to add track.', true);
      }
    },

    previewRec(rec) {
      if (this.previewingUrl === rec.audio_url) {
        this.playing ? this.audio.pause() : this.audio.play();
        return;
      }
      this.previewingUrl = rec.audio_url;
      this.currentTrack = { title: rec.title, artist: rec.artist, artwork_url: rec.artwork_url };
      this.currentItemIndex = null;
      this.audio.src = rec.audio_url;
      this.audio.currentTime = 0;
      this.audio.play().catch(() => this.showToast('Could not preview track.', true));
      this._updateMediaSession();
    },

    stopPreview() {
      if (!this.previewingUrl) return;
      this.audio.pause();
      this.previewingUrl = null;
    },

    async createPlaylist() {
      if (!this.newPlaylist.name.trim()) return;
      const pl = await this.api('POST', '/playlists', this.newPlaylist);
      this.playlists.unshift(pl);
      this.newPlaylist = { name: '', bg_color: '#1a1a2e' };
      this.showCreateModal = false;
      await this.selectPlaylist(pl);
    },

    openEdit() {
      if (!this.activePlaylist) return;
      this.editForm = { name: this.activePlaylist.name, bg_color: this.activePlaylist.bg_color };
      this.showEditModal = true;
    },

    async saveEdit() {
      const pl = await this.api('PATCH', `/playlists/${this.activePlaylist.id}`, this.editForm);
      this.activePlaylist = pl;
      this._syncSidebarPlaylist(pl);
      this.showEditModal = false;
      this._updateHeaderColor();
    },

    async deletePlaylist() {
      if (!confirm(`Delete "${this.activePlaylist.name}"?`)) return;
      await this.api('DELETE', `/playlists/${this.activePlaylist.id}`);
      this.playlists = this.playlists.filter(p => p.id !== this.activePlaylist.id);
      this.activePlaylist = null;
    },

    /* ── Sharing ── */
    async openShare() {
      if (!this.activePlaylist) return;
      this.shareUsername = '';
      this.showShareModal = true;
      await Promise.all([this.loadCollaborators(), this.loadUsers()]);
    },

    async loadCollaborators() {
      this.collaborators = await this.api('GET', `/playlists/${this.activePlaylist.id}/collaborators`);
    },

    async loadUsers() {
      this.allUsers = await this.api('GET', '/users');
    },

    availableUsers() {
      const collaboratorIds = new Set(this.collaborators.map(c => c.user_id));
      return this.allUsers.filter(u => u.id !== this.activePlaylist?.owner.id && !collaboratorIds.has(u.id));
    },

    async addCollaborator() {
      if (!this.shareUsername) return;
      try {
        await this.api('POST', `/playlists/${this.activePlaylist.id}/collaborators`, { username: this.shareUsername });
        this.shareUsername = '';
        await this.loadCollaborators();
        this.showToast('Playlist shared');
      } catch (e) {
        this.showToast(e.message, true);
      }
    },

    async removeCollaborator(c) {
      await this.api('DELETE', `/playlists/${this.activePlaylist.id}/collaborators/${c.user_id}`);
      this.collaborators = this.collaborators.filter(x => x.user_id !== c.user_id);
    },

    async leavePlaylist(pl) {
      if (!confirm(`Leave "${pl.name}"? You'll lose access unless re-added.`)) return;
      await this.api('DELETE', `/playlists/${pl.id}/leave`);
      this.playlists = this.playlists.filter(p => p.id !== pl.id);
      if (this.activePlaylist?.id === pl.id) this.activePlaylist = null;
    },

    /* ── Cover image ── */
    triggerCoverUpload() {
      document.getElementById('cover-file-input').click();
    },

    async uploadCover(event) {
      const file = event.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/playlists/${this.activePlaylist.id}/cover`, { method: 'POST', body: fd });
      if (!r.ok) { this.showToast('Upload failed', true); return; }
      const pl = await r.json();
      this.activePlaylist = pl;
      this._syncSidebarPlaylist(pl);
    },

    async copyPlaylistLinks() {
      const urls = this.activePlaylist.items.map(i => i.track.bandcamp_url).join('\n');
      try {
        await navigator.clipboard.writeText(urls);
      } catch {
        // Fallback for non-secure contexts (HTTP on local network)
        const ta = document.createElement('textarea');
        ta.value = urls;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      this.showToast('Links copied to clipboard');
    },

    /* ── Tracks ── */
    async addTrack() {
      if (!this.addUrl.trim()) return;
      this.addLoading = true;
      try {
        const pl = await this.api('POST', `/playlists/${this.activePlaylist.id}/tracks`, { url: this.addUrl.trim() });
        const added = pl.items.length - this.activePlaylist.items.length;
        this.activePlaylist = pl;
        this._syncSidebarPlaylist(pl);
        this.addUrl = '';
        this.showToast(`Added ${added} track${added !== 1 ? 's' : ''}`);
      } catch (e) {
        this.showToast(e.message, true);
      } finally {
        this.addLoading = false;
      }
    },

    async removeTrack(item) {
      const pl = await this.api('DELETE', `/playlists/${this.activePlaylist.id}/tracks/${item.id}`);
      this.activePlaylist = pl;
      this._syncSidebarPlaylist(pl);
    },

    isPlaying(item) {
      return this.currentTrack && this.currentTrack.id === item.track.id;
    },

    /* ── Playback ── */
    async playItem(index) {
      if (!this.activePlaylist) return;
      const item = this.activePlaylist.items[index];
      if (!item) return;

      this.currentItemIndex = index;
      this.currentTrack = item.track;

      // Fetch fresh stream URL
      const data = await fetch(`/api/tracks/${item.track.id}/stream-url`).then(r => r.json());
      this.previewingUrl = null;
      this.audio.src = data.url;
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {
        this.showToast('Could not start playback. The URL may have expired.', true);
      });
      this._updateMediaSession();
    },

    _updateMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const t = this.currentTrack;
      if (!t) return;
      const artwork = t.artwork_url
        ? [{ src: t.artwork_url, sizes: '300x300', type: 'image/jpeg' }]
        : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || 'Unknown',
        artist: t.artist || '',
        album: t.album || '',
        artwork,
      });
      navigator.mediaSession.setActionHandler('play',     () => this.audio.play());
      navigator.mediaSession.setActionHandler('pause',    () => this.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      navigator.mediaSession.setActionHandler('nexttrack',     () => this.next());
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        this.audio.currentTime = d.seekTime;
      });
    },

    togglePlay() {
      if (!this.audio.src) {
        if (this.activePlaylist?.items?.length) this.playItem(0);
        return;
      }
      this.playing ? this.audio.pause() : this.audio.play();
    },

    prev() {
      if (this.currentItemIndex === null) {
        if (this.previewingUrl) {
          const i = this.recommendations.findIndex(r => r.audio_url === this.previewingUrl);
          if (i > 0) this.previewRec(this.recommendations[i - 1]);
          else if (this.audio.currentTime > 3) this.audio.currentTime = 0;
        }
        return;
      }
      const i = this.currentItemIndex;
      if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
      this.playItem(Math.max(0, i - 1));
    },

    next() {
      if (this.currentItemIndex === null) {
        if (this.previewingUrl) {
          const i = this.recommendations.findIndex(r => r.audio_url === this.previewingUrl);
          if (i !== -1 && i + 1 < this.recommendations.length) this.previewRec(this.recommendations[i + 1]);
        } else if (this.activePlaylist?.items?.length) {
          this.playItem(0);
        }
        return;
      }
      const items = this.activePlaylist?.items || [];
      const next = this.currentItemIndex + 1;
      if (next < items.length) this.playItem(next);
    },

    setVolume(e) {
      this.volume = parseFloat(e.target.value);
      this.audio.volume = this.volume;
    },

    seekStart() { this.seeking = true; },
    seekEnd(e) {
      this.audio.currentTime = parseFloat(e.target.value);
      this.seeking = false;
    },

    /* ── Drag & drop reorder ── */
    dragStart(e, index) {
      this.dragSrcIndex = index;
      e.dataTransfer.effectAllowed = 'move';
    },
    dragOver(e, index) {
      e.preventDefault();
      if (this.dragSrcIndex === null || this.dragSrcIndex === index) return;
      const items = [...this.activePlaylist.items];
      const [moved] = items.splice(this.dragSrcIndex, 1);
      items.splice(index, 0, moved);
      this.activePlaylist.items = items;
      this.dragSrcIndex = index;
    },
    async dragEnd() {
      this.dragSrcIndex = null;
      const ids = this.activePlaylist.items.map(i => i.id);
      await this.api('PUT', `/playlists/${this.activePlaylist.id}/reorder`, { item_ids: ids });
      // Sync current item index after reorder
      if (this.currentTrack) {
        this.currentItemIndex = this.activePlaylist.items.findIndex(i => i.track.id === this.currentTrack.id);
      }
    },

    /* ── Helpers ── */
    _syncSidebarPlaylist(pl) {
      const idx = this.playlists.findIndex(p => p.id === pl.id);
      if (idx !== -1) this.playlists[idx] = pl;
    },

    _updateHeaderColor() {
      const color = this.activePlaylist?.bg_color || '#1a1a2e';
      document.getElementById('playlist-header')?.style.setProperty('--header-color', color);
    },

    _updateProgressBar() {
      const pct = this.duration ? (this.currentTime / this.duration) * 100 : 0;
      const bar = document.getElementById('progress-bar');
      if (bar) bar.style.setProperty('--pct', pct + '%');
    },

    showToast(msg, error = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'show' + (error ? ' error' : '');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { el.className = ''; }, 3000);
    },
  };
}
