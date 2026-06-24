/* ── Tunino App ── */

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function tunino() {
  return {
    /* ── State ── */
    playlists: [],
    activePlaylist: null,
    showCreateModal: false,
    showEditModal: false,
    newPlaylist: { name: '', bg_color: '#1a1a2e' },
    editForm: { name: '', bg_color: '#1a1a2e' },
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
    recsLoading: false,
    recsLoaded: false,
    previewingUrl: null,

    /* ── Init ── */
    async init() {
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

    /* ── API helpers ── */
    async api(method, path, body) {
      const opts = { method, headers: {} };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const r = await fetch('/api' + path, opts);
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
      this.recsLoaded = false;
    },

    async loadRecommendations() {
      if (!this.activePlaylist || this.recsLoading) return;
      this.recsLoading = true;
      this.recommendations = [];
      try {
        const tid = this.currentTrack?.id ? `?track_id=${this.currentTrack.id}` : '';
        this.recommendations = await this.api('GET', `/playlists/${this.activePlaylist.id}/recommendations${tid}`);
        this.recsLoaded = true;
      } catch (e) {
        this.showToast('Could not load recommendations.', true);
      } finally {
        this.recsLoading = false;
      }
    },

    async addRecommendation(rec) {
      this.stopPreview();
      this.addUrl = rec.url;
      await this.addTrack();
      this.recommendations = this.recommendations.filter(r => r.url !== rec.url);
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
      if (this.currentItemIndex === null) return;
      const i = this.currentItemIndex;
      if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
      this.playItem(Math.max(0, i - 1));
    },

    next() {
      if (this.currentItemIndex === null) {
        if (this.activePlaylist?.items?.length) this.playItem(0);
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
