const CONFIG = window.IPRACTICE_CONFIG || {};
const SETTINGS = CONFIG.adminWizard || {};
const STORAGE_KEY = SETTINGS.storageKey || "ipracticeMusic.adminWizard.v2";
const SESSION_KEY = `${STORAGE_KEY}.session`;
const DB_NAME = "iPracticeMusicAdminAssets";
const DB_STORE = "assets";
const STEPS = ["Login", "Playlists", "Song Titles", "Upload Tracks", "Review & Open"];
const AUDIO_PATTERN = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i;
const VISUAL_PATTERN = /\.(pdf|png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|m4v)$/i;
const LRC_PATTERN = /\.lrc$/i;

const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));

function id(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function safeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nowIso() { return new Date().toISOString(); }

function blankPlaylist(title = "New Practice Playlist") {
  const stamp = nowIso();
  return {
    id: id("playlist"),
    title,
    description: "",
    skin: CONFIG.defaultSkin || "classic-blue",
    createdAt: stamp,
    updatedAt: stamp,
    songs: []
  };
}

function blankSong(title = "Untitled Song") {
  return {
    id: id("song"),
    title,
    mediaType: "",
    mediaUrl: "",
    mediaAsset: null,
    lyricsUrl: "",
    lyricsAsset: null,
    tracks: []
  };
}

function normalizeImportedTrack(track = {}) {
  return {
    id: track.id || id("track"),
    name: String(track.name || track.trackName || "Practice Track"),
    subtitle: String(track.subtitle || ""),
    audioUrl: String(track.audioUrl || track.url || ""),
    audioAsset: track.audioAsset || null,
    volume: Number.isFinite(Number(track.volume)) ? Math.max(0, Math.min(1, Number(track.volume))) : 0.85,
    downloadAllowed: track.downloadAllowed !== false
  };
}

function normalizeImportedSong(song = {}) {
  let mediaType = String(song.mediaType || "").toLowerCase();
  let mediaUrl = String(song.mediaUrl || song.pdfUrl || song.imageUrl || song.videoUrl || "");
  if (!mediaType && mediaUrl) mediaType = detectMediaType(mediaUrl);
  return {
    id: song.id || id("song"),
    title: String(song.title || "Untitled Song"),
    mediaType,
    mediaUrl,
    mediaAsset: song.mediaAsset || null,
    lyricsUrl: String(song.lyricsUrl || song.lrcUrl || song.syncedLyricsUrl || ""),
    lyricsAsset: song.lyricsAsset || null,
    tracks: (Array.isArray(song.tracks) ? song.tracks : []).map(normalizeImportedTrack)
  };
}

function normalizePlaylist(playlist = {}) {
  const stamp = nowIso();
  return {
    id: playlist.id || id("playlist"),
    title: String(playlist.title || "Imported Practice Playlist"),
    description: String(playlist.description || ""),
    skin: String(playlist.skin || CONFIG.defaultSkin || "classic-blue"),
    createdAt: playlist.createdAt || stamp,
    updatedAt: playlist.updatedAt || stamp,
    songs: (Array.isArray(playlist.songs) ? playlist.songs : []).map(normalizeImportedSong)
  };
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && Array.isArray(raw.playlists)) {
      raw.playlists = raw.playlists.map(normalizePlaylist);
      raw.currentStep = Number.isInteger(raw.currentStep) ? Math.max(0, Math.min(4, raw.currentStep)) : 0;
      return raw;
    }
  } catch (error) {
    console.warn("Could not read the administration draft:", error);
  }
  return { currentStep: 0, activePlaylistId: null, playlists: [] };
}

function saveState(state) {
  const serializable = clone(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  window.dispatchEvent(new CustomEvent("ipractice:playlists-changed", {
    detail: { activePlaylistId: serializable.activePlaylistId || null }
  }));
}

function detectMediaType(name) {
  const clean = String(name || "").split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|webm|mov|m4v)$/.test(clean)) return "video";
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(clean)) return "image";
  return "";
}

function stem(value) {
  return String(value || "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/\b(soprano|alto|tenor|bass|satb|melody|accompaniment|piano|organ|full mix|demo|practice|track|audio|video|sheet music|score)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bestSongForFilename(fileName, songs, fallbackIndex = 0) {
  const fileStem = stem(fileName);
  let bestIndex = -1;
  let bestScore = 0;
  songs.forEach((song, index) => {
    const titleStem = stem(song.title);
    if (!titleStem) return;
    let score = 0;
    if (fileStem === titleStem) score = 1000 + titleStem.length;
    else if (fileStem.includes(titleStem)) score = 500 + titleStem.length;
    else {
      const words = titleStem.split(/\s+/).filter(Boolean);
      const matched = words.filter(word => fileStem.includes(word));
      score = matched.length * 20 + matched.join("").length;
      if (matched.length < Math.ceil(words.length * .6)) score = 0;
    }
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return bestIndex >= 0 ? bestIndex : Math.max(0, Math.min(songs.length - 1, fallbackIndex));
}

function deriveTrackName(fileName, songTitle) {
  const base = String(fileName || "Practice Track").replace(/\.[^.]+$/, "");
  const escaped = String(songTitle || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const remainder = escaped ? base.replace(new RegExp(escaped, "i"), "") : base;
  const cleaned = remainder.replace(/^[\s._-]+|[\s._-]+$/g, "").replace(/[._-]+/g, " ").trim();
  return cleaned || base || "Practice Track";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
  });
}

async function putAsset(file) {
  const key = id("asset");
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(file, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("The file could not be stored."));
  });
  db.close();
  return { key, name: file.name, type: file.type, size: file.size, storedAt: nowIso() };
}

async function getAsset(asset) {
  if (!asset?.key) return null;
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(asset.key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("The file could not be read."));
  });
  db.close();
  return result;
}

async function deleteAsset(asset) {
  if (!asset?.key) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(asset.key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("The file could not be removed."));
  });
  db.close();
}

class AdminWizard {
  constructor() {
    this.state = loadState();
    this.authenticated = sessionStorage.getItem(SESSION_KEY) === "yes";
    this.state.currentStep = this.authenticated ? Math.max(1, this.state.currentStep || 1) : 0;
    this.selectedUploadSongIndex = 0;
    this.objectUrls = [];
    this.elements = {
      open: $("openAdminButton"), overlay: $("adminWizard"), close: $("adminCloseButton"),
      stepper: $("adminStepper"), content: $("adminWizardContent"), back: $("adminBackButton"),
      next: $("adminNextButton"), status: $("adminFooterStatus"), toast: $("adminToast")
    };
    if (!this.elements.overlay) return;
    this.bind();
    this.render();
    window.iPracticeMusicAdminWizard = this;
  }

  bind() {
    this.elements.open?.addEventListener("click", () => this.open());
    this.elements.close.addEventListener("click", () => this.close());
    this.elements.overlay.addEventListener("click", event => {
      if (event.target === this.elements.overlay) this.close();
    });
    this.elements.back.addEventListener("click", () => this.back());
    this.elements.next.addEventListener("click", () => this.next());
    this.elements.stepper.addEventListener("click", event => {
      const button = event.target.closest("[data-step]");
      if (!button) return;
      const target = Number(button.dataset.step);
      if (!this.authenticated && target > 0) return;
      if (target <= this.state.currentStep || target === 0) this.go(target);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.elements.overlay.hidden) this.close();
    });
  }

  open() {
    this.elements.overlay.hidden = false;
    document.body.classList.add("modal-open");
    this.render();
    setTimeout(() => this.elements.close.focus(), 0);
  }

  close() {
    this.elements.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    this.elements.open?.focus();
  }

  activePlaylist() {
    return this.state.playlists.find(item => item.id === this.state.activePlaylistId) || null;
  }

  ensurePlaylist() {
    let playlist = this.activePlaylist();
    if (!playlist) {
      playlist = blankPlaylist();
      this.state.playlists.unshift(playlist);
      this.state.activePlaylistId = playlist.id;
      this.persist();
    }
    return playlist;
  }

  persist(message = "Draft saved in this browser.") {
    const playlist = this.activePlaylist();
    if (playlist) playlist.updatedAt = nowIso();
    saveState(this.state);
    this.elements.status.textContent = message;
  }

  go(step) {
    if (step > 0 && !this.authenticated) step = 0;
    this.state.currentStep = Math.max(0, Math.min(4, step));
    this.persist();
    this.render();
  }

  back() {
    this.go(Math.max(this.authenticated ? 1 : 0, this.state.currentStep - 1));
  }

  async next() {
    const step = this.state.currentStep;
    if (step === 0) {
      const form = $("adminLoginForm");
      if (form) form.requestSubmit();
      return;
    }
    if (step === 1) {
      const playlist = this.ensurePlaylist();
      if (!playlist.title.trim()) { this.toast("Give the playlist a title before continuing.", true); return; }
    }
    if (step === 2) {
      const playlist = this.ensurePlaylist();
      if (!playlist.songs.length) { this.toast("Add at least one song title before continuing.", true); return; }
    }
    if (step < 4) this.go(step + 1);
    else await this.openInPlayer();
  }

  render() {
    this.renderStepper();
    const renderers = ["renderLogin", "renderPlaylists", "renderSongs", "renderUploads", "renderReview"];
    this[renderers[this.state.currentStep]]();
    this.elements.back.hidden = this.state.currentStep <= (this.authenticated ? 1 : 0);
    this.elements.next.textContent = ["Sign In", "Continue", "Continue", "Review Playlist", "Open in Player"][this.state.currentStep];
    this.elements.next.classList.add("primary");
    this.elements.status.textContent = this.authenticated
      ? `${this.state.playlists.length} saved playlist${this.state.playlists.length === 1 ? "" : "s"} on this device.`
      : "The prototype login is stored only for this browser session.";
  }

  renderStepper() {
    this.elements.stepper.innerHTML = STEPS.map((name, index) => `
      <button type="button" class="admin-step-button ${index < this.state.currentStep ? "complete" : ""}"
        data-step="${index}" ${index === this.state.currentStep ? 'aria-current="step"' : ""}
        ${!this.authenticated && index > 0 ? "disabled" : ""}>
        <span class="admin-step-number">${index < this.state.currentStep ? "✓" : index + 1}</span>
        <span>${safeText(name)}</span>
      </button>`).join("");
  }

  renderLogin() {
    const email = SETTINGS.demoEmail || "rkochel@stjudefw.org";
    const password = SETTINGS.demoPassword || "practice";
    this.elements.content.innerHTML = `
      <div class="admin-view">
        <form id="adminLoginForm" class="admin-card admin-login-card">
          <div class="admin-wizard-mark" aria-hidden="true">♪</div>
          <h3>Administration Sign In</h3>
          <p class="admin-lead">Open the guided playlist builder inside iPracticeMusic App 2.0.</p>
          <label class="admin-field"><span>Email</span><input id="adminEmail" type="email" value="${safeText(email)}" autocomplete="username" required></label>
          <label class="admin-field" style="margin-top:12px"><span>Password</span><input id="adminPassword" type="password" value="${safeText(password)}" autocomplete="current-password" required></label>
          <div class="admin-privacy-note"><strong>Prototype privacy note:</strong> this login is a local demonstration gate, not production security. Playlist drafts and uploaded files remain in this browser unless you export them.</div>
        </form>
      </div>`;
    $("adminLoginForm").addEventListener("submit", event => {
      event.preventDefault();
      const suppliedEmail = $("adminEmail").value.trim().toLowerCase();
      const suppliedPassword = $("adminPassword").value;
      if (suppliedEmail !== email.toLowerCase() || suppliedPassword !== password) {
        this.toast("The demonstration email or password is incorrect.", true);
        return;
      }
      this.authenticated = true;
      sessionStorage.setItem(SESSION_KEY, "yes");
      this.state.currentStep = 1;
      this.persist("Signed in. Your draft is saved locally.");
      this.render();
    });
  }

  renderPlaylists() {
    const playlist = this.activePlaylist();
    this.elements.content.innerHTML = `
      <div class="admin-view admin-view-wide">
        <h3>Choose or create a playlist</h3>
        <p class="admin-lead">Each playlist contains its own song titles, visual files, and synchronized practice tracks.</p>
        <div class="admin-grid sidebar">
          <section class="admin-card">
            <h4>Saved playlists</h4>
            <div id="adminPlaylistList" class="admin-playlist-list"></div>
            <div class="admin-actions">
              <button id="adminNewPlaylist" type="button" class="primary">＋ New Playlist</button>
              <button id="adminImportPlayer" type="button">Import Current Player</button>
            </div>
          </section>
          <section class="admin-card">
            <h4>Playlist details</h4>
            ${playlist ? `
              <div class="admin-grid two">
                <label class="admin-field"><span>Playlist title</span><input id="adminPlaylistTitle" value="${safeText(playlist.title)}"></label>
                <label class="admin-field"><span>Player skin</span><select id="adminPlaylistSkin">${this.skinOptions(playlist.skin)}</select></label>
              </div>
              <label class="admin-field" style="margin-top:12px"><span>Description</span><textarea id="adminPlaylistDescription" placeholder="Purpose, choir, event, or rehearsal notes">${safeText(playlist.description)}</textarea></label>
              <div class="admin-actions">
                <button id="adminDuplicatePlaylist" type="button">Duplicate</button>
                <button id="adminDeletePlaylist" type="button" class="admin-danger">Delete Playlist</button>
              </div>` : `<div class="admin-empty">Create a playlist to begin.</div>`}
          </section>
        </div>
      </div>`;
    this.renderPlaylistList();
    $("adminNewPlaylist").addEventListener("click", () => {
      const created = blankPlaylist(`Practice Playlist ${this.state.playlists.length + 1}`);
      this.state.playlists.unshift(created);
      this.state.activePlaylistId = created.id;
      this.persist();
      this.render();
    });
    $("adminImportPlayer").addEventListener("click", () => this.importCurrentPlayer());
    if (playlist) {
      $("adminPlaylistTitle").addEventListener("input", event => { playlist.title = event.target.value; this.persist(); this.renderPlaylistList(); });
      $("adminPlaylistDescription").addEventListener("input", event => { playlist.description = event.target.value; this.persist(); });
      $("adminPlaylistSkin").addEventListener("change", event => { playlist.skin = event.target.value; this.persist(); });
      $("adminDuplicatePlaylist").addEventListener("click", async () => {
        try {
          const copy = await this.duplicatePlaylistWithAssets(playlist);
          this.state.playlists.unshift(copy);
          this.state.activePlaylistId = copy.id;
          this.persist();
          this.render();
          this.toast("Playlist duplicated.");
        } catch (error) {
          this.toast(`The playlist could not be duplicated: ${error.message}`, true);
        }
      });
      $("adminDeletePlaylist").addEventListener("click", async () => {
        if (!confirm(`Delete “${playlist.title}” from this browser?`)) return;
        await this.removePlaylistAssets(playlist);
        this.state.playlists = this.state.playlists.filter(item => item.id !== playlist.id);
        this.state.activePlaylistId = this.state.playlists[0]?.id || null;
        this.persist();
        this.render();
      });
    }
  }

  renderPlaylistList() {
    const target = $("adminPlaylistList");
    if (!target) return;
    if (!this.state.playlists.length) {
      target.innerHTML = `<div class="admin-empty">No saved playlists yet.</div>`;
      return;
    }
    target.innerHTML = this.state.playlists.map(item => `
      <div class="admin-playlist-item ${item.id === this.state.activePlaylistId ? "active" : ""}">
        <div><strong>${safeText(item.title)}</strong><small>${item.songs.length} song${item.songs.length === 1 ? "" : "s"} · Updated ${new Date(item.updatedAt).toLocaleDateString()}</small></div>
        <button type="button" data-open-playlist="${safeText(item.id)}">${item.id === this.state.activePlaylistId ? "Open" : "Select"}</button>
      </div>`).join("");
    target.querySelectorAll("[data-open-playlist]").forEach(button => button.addEventListener("click", () => {
      this.state.activePlaylistId = button.dataset.openPlaylist;
      this.persist();
      this.render();
    }));
  }

  skinOptions(selected) {
    const skins = SETTINGS.skins || ["classic-blue", "art-deco-navy", "cathedral-gold", "forest-green", "midnight-dark"];
    return skins.map(skin => `<option value="${safeText(skin)}" ${skin === selected ? "selected" : ""}>${safeText(skin.replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase()))}</option>`).join("");
  }

  importCurrentPlayer() {
    const definitions = window.iPracticeMusicPlayer?.getSongDefinitions?.() || CONFIG.demoSongs || [];
    const playlist = normalizePlaylist({
      title: `Imported Player ${new Date().toLocaleDateString()}`,
      description: "Imported from the songs currently loaded in iPracticeMusic App 2.0.",
      skin: document.documentElement.dataset.widgetSkin || CONFIG.defaultSkin,
      songs: definitions
    });
    this.state.playlists.unshift(playlist);
    this.state.activePlaylistId = playlist.id;
    this.persist();
    this.render();
    this.toast(`${playlist.songs.length} song${playlist.songs.length === 1 ? "" : "s"} imported.`);
  }

  renderSongs() {
    const playlist = this.ensurePlaylist();
    this.elements.content.innerHTML = `
      <div class="admin-view admin-view-wide">
        <h3>Add the song titles</h3>
        <p class="admin-lead">Paste a complete list or add songs individually. You can rename, reorder, or remove them before uploading files.</p>
        <section class="admin-card">
          <label class="admin-field"><span>Paste song titles</span><textarea id="adminBulkTitles" placeholder="Amazing Grace&#10;Holy God, We Praise Thy Name&#10;Ave Maria"></textarea><small class="admin-help">One title per line. Duplicate titles will be skipped.</small></label>
          <div class="admin-actions"><button id="adminAddBulkTitles" type="button" class="primary">Add Titles</button><button id="adminAddBlankSong" type="button">＋ Add One Song</button></div>
        </section>
        <section class="admin-card">
          <h4>${safeText(playlist.title)} — Song order</h4>
          <div id="adminSongList" class="admin-song-list"></div>
        </section>
      </div>`;
    this.renderSongList();
    $("adminAddBulkTitles").addEventListener("click", () => {
      const titles = $("adminBulkTitles").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const existing = new Set(playlist.songs.map(song => song.title.toLowerCase()));
      let added = 0;
      titles.forEach(title => {
        if (!existing.has(title.toLowerCase())) { playlist.songs.push(blankSong(title)); existing.add(title.toLowerCase()); added += 1; }
      });
      $("adminBulkTitles").value = "";
      this.persist();
      this.renderSongList();
      this.toast(`${added} song title${added === 1 ? "" : "s"} added.`);
    });
    $("adminAddBlankSong").addEventListener("click", () => {
      playlist.songs.push(blankSong(`Song ${playlist.songs.length + 1}`));
      this.persist();
      this.renderSongList();
    });
  }

  renderSongList() {
    const playlist = this.activePlaylist();
    const target = $("adminSongList");
    if (!target || !playlist) return;
    if (!playlist.songs.length) { target.innerHTML = `<div class="admin-empty">No songs have been added.</div>`; return; }
    target.innerHTML = playlist.songs.map((song, index) => `
      <div class="admin-song-row" data-song-id="${safeText(song.id)}">
        <span class="admin-row-number">${index + 1}</span>
        <input aria-label="Song ${index + 1} title" value="${safeText(song.title)}" data-song-title>
        <button type="button" class="admin-row-icon-button" data-move-song="up" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="admin-row-icon-button admin-move-down" data-move-song="down" title="Move down" ${index === playlist.songs.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="admin-delete-song admin-danger" data-delete-song>Delete</button>
      </div>`).join("");
    target.querySelectorAll("[data-song-id]").forEach(row => {
      const index = playlist.songs.findIndex(song => song.id === row.dataset.songId);
      const song = playlist.songs[index];
      row.querySelector("[data-song-title]").addEventListener("input", event => { song.title = event.target.value; this.persist(); });
      row.querySelectorAll("[data-move-song]").forEach(button => button.addEventListener("click", () => {
        const direction = button.dataset.moveSong === "up" ? -1 : 1;
        const destination = index + direction;
        if (destination < 0 || destination >= playlist.songs.length) return;
        [playlist.songs[index], playlist.songs[destination]] = [playlist.songs[destination], playlist.songs[index]];
        this.persist();
        this.renderSongList();
      }));
      row.querySelector("[data-delete-song]").addEventListener("click", async () => {
        if (!confirm(`Remove “${song.title}” and its tracks?`)) return;
        await this.removeSongAssets(song);
        playlist.songs = playlist.songs.filter(item => item.id !== song.id);
        this.persist();
        this.renderSongList();
      });
    });
  }

  renderUploads() {
    const playlist = this.ensurePlaylist();
    this.selectedUploadSongIndex = Math.min(this.selectedUploadSongIndex, Math.max(0, playlist.songs.length - 1));
    this.elements.content.innerHTML = `
      <div class="admin-view admin-view-wide">
        <h3>Upload media and practice tracks</h3>
        <p class="admin-lead">Files are matched to song titles by filename. Unmatched files are added to the selected song.</p>
        <section class="admin-card">
          <div class="admin-grid two">
            <label class="admin-field"><span>Selected song</span><select id="adminUploadSongSelect">${playlist.songs.map((song, index) => `<option value="${index}" ${index === this.selectedUploadSongIndex ? "selected" : ""}>${index + 1}. ${safeText(song.title)}</option>`).join("")}</select></label>
            <label class="admin-field"><span>Visual URL (optional)</span><input id="adminVisualUrl" placeholder="media/pdf/song.pdf or https://..."></label>
            <label class="admin-field"><span>Synced lyrics URL (.lrc)</span><input id="adminLyricsUrl" placeholder="media/lyrics/song.lrc or https://..."></label>
          </div>
          <div class="admin-actions"><button id="adminApplyVisualUrl" type="button">Apply Visual URL</button><button id="adminApplyLyricsUrl" type="button">Apply .LRC URL</button><button id="adminAddAudioUrl" type="button">＋ Add Audio URL</button></div>
          <div class="admin-grid two" style="margin-top:14px">
            <label class="admin-drop-zone" for="adminVisualFiles"><strong>Upload PDF, image, or video</strong><span>Choose files or drag them onto this box</span><input id="adminVisualFiles" type="file" accept="application/pdf,image/*,video/*,.pdf,.png,.jpg,.jpeg,.webp,.gif,.svg,.mp4,.webm,.mov" multiple></label>
            <label class="admin-drop-zone" for="adminAudioFiles"><strong>Upload practice audio</strong><span>Multiple files are allowed</span><input id="adminAudioFiles" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.opus,.webm" multiple></label>
            <label class="admin-drop-zone" for="adminLyricsFiles"><strong>Upload synced lyrics (.lrc)</strong><span>Timestamped lyric files are matched to song titles</span><input id="adminLyricsFiles" type="file" accept="text/plain,.lrc" multiple></label>
          </div>
        </section>
        <section class="admin-card admin-song-assets">
          <h4>Playlist files</h4>
          <div id="adminAssetList"></div>
        </section>
      </div>`;
    $("adminUploadSongSelect").addEventListener("change", event => { this.selectedUploadSongIndex = Number(event.target.value); });
    $("adminVisualFiles").addEventListener("change", event => this.handleFiles(Array.from(event.target.files || []), "visual"));
    $("adminAudioFiles").addEventListener("change", event => this.handleFiles(Array.from(event.target.files || []), "audio"));
    $("adminLyricsFiles").addEventListener("change", event => this.handleFiles(Array.from(event.target.files || []), "lyrics"));
    document.querySelectorAll(".admin-drop-zone").forEach(zone => {
      ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add("drag-over"); }));
      ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove("drag-over"); }));
      zone.addEventListener("drop", event => {
        const type = zone.htmlFor === "adminVisualFiles"
          ? "visual"
          : zone.htmlFor === "adminLyricsFiles"
            ? "lyrics"
            : "audio";
        this.handleFiles(Array.from(event.dataTransfer?.files || []), type);
      });
    });
    $("adminApplyVisualUrl").addEventListener("click", async () => {
      const url = $("adminVisualUrl").value.trim();
      if (!url) { this.toast("Enter a PDF, image, or video URL.", true); return; }
      const song = playlist.songs[this.selectedUploadSongIndex];
      await deleteAsset(song.mediaAsset);
      song.mediaAsset = null;
      song.mediaUrl = url;
      song.mediaType = detectMediaType(url) || "image";
      this.persist();
      this.renderUploads();
    });
    $("adminApplyLyricsUrl").addEventListener("click", async () => {
      const url = $("adminLyricsUrl").value.trim();
      if (!url || !LRC_PATTERN.test(url.split(/[?#]/)[0])) { this.toast("Enter a URL or path ending in .lrc.", true); return; }
      const song = playlist.songs[this.selectedUploadSongIndex];
      await deleteAsset(song.lyricsAsset);
      song.lyricsAsset = null;
      song.lyricsUrl = url;
      this.persist();
      this.renderUploads();
    });
    $("adminAddAudioUrl").addEventListener("click", () => {
      const url = prompt("Paste the audio URL:");
      if (!url?.trim()) return;
      const name = prompt("Track name:", "Practice Track") || "Practice Track";
      playlist.songs[this.selectedUploadSongIndex].tracks.push(normalizeImportedTrack({ name, audioUrl: url.trim() }));
      this.persist();
      this.renderUploads();
    });
    this.renderAssetList();
  }

  async handleFiles(files, expectedType) {
    const playlist = this.activePlaylist();
    if (!playlist?.songs.length || !files.length) return;
    let stored = 0;
    for (const file of files) {
      const isLyrics = LRC_PATTERN.test(file.name);
      const isAudio = !isLyrics && (file.type.startsWith("audio/") || AUDIO_PATTERN.test(file.name));
      const isVisual = !isLyrics && (file.type.startsWith("image/") || file.type.startsWith("video/") || file.type === "application/pdf" || VISUAL_PATTERN.test(file.name));
      if (
        (expectedType === "audio" && !isAudio) ||
        (expectedType === "visual" && !isVisual) ||
        (expectedType === "lyrics" && !isLyrics)
      ) continue;
      const songIndex = bestSongForFilename(file.name, playlist.songs, this.selectedUploadSongIndex);
      const song = playlist.songs[songIndex];
      const asset = await putAsset(file);
      if (isLyrics) {
        await deleteAsset(song.lyricsAsset);
        song.lyricsAsset = asset;
        song.lyricsUrl = "";
      } else if (isAudio) {
        song.tracks.push(normalizeImportedTrack({ name: deriveTrackName(file.name, song.title), audioAsset: asset, audioUrl: "" }));
      } else {
        await deleteAsset(song.mediaAsset);
        song.mediaAsset = asset;
        song.mediaUrl = "";
        song.mediaType = detectMediaType(file.name) || (file.type === "application/pdf" ? "pdf" : file.type.startsWith("video/") ? "video" : "image");
      }
      stored += 1;
    }
    this.persist();
    this.renderUploads();
    this.toast(`${stored} file${stored === 1 ? "" : "s"} added and matched.`);
  }

  renderAssetList() {
    const playlist = this.activePlaylist();
    const target = $("adminAssetList");
    if (!target || !playlist) return;
    target.innerHTML = playlist.songs.map((song, songIndex) => `
      <article class="admin-asset-card" data-asset-song="${safeText(song.id)}">
        <div class="admin-asset-header"><div><strong>${songIndex + 1}. ${safeText(song.title)}</strong></div><div class="admin-asset-pills"><span class="admin-media-pill">${song.mediaType ? `${safeText(song.mediaType.toUpperCase())}: ${safeText(song.mediaAsset?.name || song.mediaUrl || "Configured")}` : "No visual file"}</span><span class="admin-media-pill">${song.lyricsAsset || song.lyricsUrl ? `LRC: ${safeText(song.lyricsAsset?.name || song.lyricsUrl || "Configured")}` : "No synced lyrics"}</span></div></div>
        <div class="admin-track-list">
          ${song.tracks.length ? song.tracks.map(track => `
            <div class="admin-track-row" data-track-id="${safeText(track.id)}">
              <label class="admin-field"><span>Track name</span><input data-track-name value="${safeText(track.name)}"></label>
              <label class="admin-field"><span>Subtitle</span><input data-track-subtitle value="${safeText(track.subtitle)}" placeholder="Optional"></label>
              <label class="admin-field"><span>Volume <output data-track-volume-output>${Math.round(track.volume * 100)}%</output></span><input data-track-volume type="range" min="0" max="1" step="0.01" value="${track.volume}"></label>
              <label><input data-track-download type="checkbox" ${track.downloadAllowed ? "checked" : ""}> Download</label>
              <button type="button" data-delete-track class="admin-danger">Delete</button>
            </div>`).join("") : `<div class="admin-empty">No audio tracks yet.</div>`}
        </div>
        ${song.mediaType || song.lyricsAsset || song.lyricsUrl ? `<div class="admin-actions">${song.mediaType ? `<button type="button" data-remove-visual>Remove Visual</button>` : ""}${song.lyricsAsset || song.lyricsUrl ? `<button type="button" data-remove-lyrics>Remove .LRC</button>` : ""}</div>` : ""}
      </article>`).join("");
    target.querySelectorAll("[data-asset-song]").forEach(card => {
      const song = playlist.songs.find(item => item.id === card.dataset.assetSong);
      card.querySelector("[data-remove-visual]")?.addEventListener("click", async () => {
        await deleteAsset(song.mediaAsset);
        song.mediaAsset = null; song.mediaUrl = ""; song.mediaType = "";
        this.persist(); this.renderUploads();
      });
      card.querySelector("[data-remove-lyrics]")?.addEventListener("click", async () => {
        await deleteAsset(song.lyricsAsset);
        song.lyricsAsset = null; song.lyricsUrl = "";
        this.persist(); this.renderUploads();
      });
      card.querySelectorAll("[data-track-id]").forEach(row => {
        const track = song.tracks.find(item => item.id === row.dataset.trackId);
        row.querySelector("[data-track-name]").addEventListener("input", event => { track.name = event.target.value; this.persist(); });
        row.querySelector("[data-track-subtitle]").addEventListener("input", event => { track.subtitle = event.target.value; this.persist(); });
        row.querySelector("[data-track-volume]").addEventListener("input", event => { track.volume = Number(event.target.value); row.querySelector("[data-track-volume-output]").textContent = `${Math.round(track.volume * 100)}%`; this.persist(); });
        row.querySelector("[data-track-download]").addEventListener("change", event => { track.downloadAllowed = event.target.checked; this.persist(); });
        row.querySelector("[data-delete-track]").addEventListener("click", async () => {
          await deleteAsset(track.audioAsset);
          song.tracks = song.tracks.filter(item => item.id !== track.id);
          this.persist(); this.renderUploads();
        });
      });
    });
  }

  renderReview() {
    const playlist = this.ensurePlaylist();
    const tracks = playlist.songs.reduce((sum, song) => sum + song.tracks.length, 0);
    const visuals = playlist.songs.filter(song => song.mediaType).length;
    const lyrics = playlist.songs.filter(song => song.lyricsAsset || song.lyricsUrl).length;
    const localAssets = playlist.songs.reduce((sum, song) => sum + (song.mediaAsset ? 1 : 0) + (song.lyricsAsset ? 1 : 0) + song.tracks.filter(track => track.audioAsset).length, 0);
    const warnings = [];
    playlist.songs.forEach(song => {
      if (!song.title.trim()) warnings.push("A song is missing its title.");
      if (!song.tracks.length) warnings.push(`“${song.title || "Untitled Song"}” has no audio track.`);
    });
    this.elements.content.innerHTML = `
      <div class="admin-view admin-view-wide">
        <h3>Review and open the playlist</h3>
        <p class="admin-lead">Confirm the song order and files. The finished playlist can open immediately in the musician-facing player.</p>
        <div class="admin-summary-grid">
          <div class="admin-stat"><strong>${playlist.songs.length}</strong><span>Songs</span></div>
          <div class="admin-stat"><strong>${tracks}</strong><span>Practice tracks</span></div>
          <div class="admin-stat"><strong>${visuals}</strong><span>Visual files</span></div>
          <div class="admin-stat"><strong>${lyrics}</strong><span>Synced .LRC files</span></div>
          <div class="admin-stat"><strong>${localAssets}</strong><span>Browser files</span></div>
        </div>
        <section class="admin-card">
          <div class="admin-asset-header"><div><h4 style="margin:0">${safeText(playlist.title)}</h4><small class="admin-help">${safeText(playlist.description || "No description")}</small></div><span class="admin-status-pill">${safeText(playlist.skin)}</span></div>
          <div class="admin-review-list">${playlist.songs.map((song, index) => `
            <div class="admin-review-row"><div><strong>${index + 1}. ${safeText(song.title)}</strong><small>${song.tracks.map(track => safeText(track.name)).join(" · ") || "No practice tracks"}</small></div><span class="admin-media-pill">${song.mediaType ? safeText(song.mediaType.toUpperCase()) : "No visual"}</span><span class="admin-media-pill">${song.lyricsAsset || song.lyricsUrl ? ".LRC ready" : "No .LRC"}</span><span class="admin-media-pill">${song.tracks.length} track${song.tracks.length === 1 ? "" : "s"}</span></div>`).join("") || `<div class="admin-empty">No songs have been added.</div>`}</div>
          ${warnings.length ? `<ul class="admin-warning-list">${[...new Set(warnings)].map(warning => `<li>${safeText(warning)}</li>`).join("")}</ul>` : ""}
          <div class="admin-actions">
            <button id="adminSavePlaylist" type="button" class="primary">Save Playlist</button>
            <button id="adminDownloadJson" type="button">Download JSON</button>
            <label class="button-link" for="adminLoadJson">Load Saved JSON<input id="adminLoadJson" type="file" accept="application/json,.json" hidden></label>
          </div>
        </section>
        <div class="admin-privacy-note"><strong>Local-file note:</strong> uploaded audio, PDFs, images, videos, and .lrc files are stored in this browser using IndexedDB. URL-based files are portable; local files stay on this device unless you upload them to your hosting repository.</div>
      </div>`;
    $("adminSavePlaylist").addEventListener("click", () => { this.persist("Playlist saved in this browser."); this.toast("Playlist saved."); });
    $("adminDownloadJson").addEventListener("click", () => this.downloadJson());
    $("adminLoadJson").addEventListener("change", event => this.loadJsonFile(event.target.files?.[0]));
  }

  downloadJson() {
    const playlist = this.activePlaylist();
    const portable = clone(playlist);
    portable.exportedAt = nowIso();
    portable.schema = "iPracticeMusic-playlist-2.0.8";
    portable.songs.forEach(song => {
      if (song.mediaAsset && !song.mediaUrl) song.mediaUrl = `LOCAL_FILE_REQUIRED/${song.mediaAsset.name}`;
      delete song.mediaAsset;
      if (song.lyricsAsset && !song.lyricsUrl) song.lyricsUrl = `LOCAL_FILE_REQUIRED/${song.lyricsAsset.name}`;
      delete song.lyricsAsset;
      song.tracks.forEach(track => {
        if (track.audioAsset && !track.audioUrl) track.audioUrl = `LOCAL_FILE_REQUIRED/${track.audioAsset.name}`;
        delete track.audioAsset;
      });
    });
    const blob = new Blob([JSON.stringify(portable, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${playlist.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ipracticemusic-playlist"}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    this.toast("Playlist JSON downloaded.");
  }

  async loadJsonFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const playlist = normalizePlaylist(Array.isArray(data) ? { title: file.name.replace(/\.json$/i, ""), songs: data } : data);
      this.state.playlists.unshift(playlist);
      this.state.activePlaylistId = playlist.id;
      this.persist();
      this.render();
      this.toast("Saved playlist loaded.");
    } catch (error) {
      this.toast(`The JSON file could not be loaded: ${error.message}`, true);
    }
  }

  async openInPlayer() {
    const playlist = this.activePlaylist();
    if (!playlist?.songs.length) { this.toast("The playlist does not contain any songs.", true); return; }
    this.elements.next.disabled = true;
    this.elements.next.textContent = "Preparing files…";
    try {
      if (!window.iPracticeMusicPlayer?.openSavedPlaylist) {
        throw new Error("The player has not finished loading. Close and reopen the wizard, then try again.");
      }
      this.persist("Opening playlist in the player.");
      await window.iPracticeMusicPlayer.openSavedPlaylist(playlist.id);
      this.persist("Playlist opened in the player.");
      this.close();
      document.querySelector(".playlist-selector")?.scrollIntoView({ behavior: "smooth", block: "start" });
      this.toast(`“${playlist.title}” is open in the practice player.`);
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      this.elements.next.disabled = false;
      this.elements.next.textContent = "Open in Player";
    }
  }

  revokeObjectUrls() {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  async duplicatePlaylistWithAssets(playlist) {
    const copy = normalizePlaylist({
      ...clone(playlist),
      id: id("playlist"),
      title: `${playlist.title} Copy`,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    for (const song of copy.songs) {
      song.id = id("song");
      if (song.mediaAsset) {
        const file = await getAsset(song.mediaAsset);
        song.mediaAsset = file ? await putAsset(file) : null;
      }
      if (song.lyricsAsset) {
        const file = await getAsset(song.lyricsAsset);
        song.lyricsAsset = file ? await putAsset(file) : null;
      }
      for (const track of song.tracks) {
        track.id = id("track");
        if (track.audioAsset) {
          const file = await getAsset(track.audioAsset);
          track.audioAsset = file ? await putAsset(file) : null;
        }
      }
    }
    return copy;
  }

  async removeSongAssets(song) {
    await deleteAsset(song.mediaAsset);
    await deleteAsset(song.lyricsAsset);
    for (const track of song.tracks || []) await deleteAsset(track.audioAsset);
  }

  async removePlaylistAssets(playlist) {
    for (const song of playlist.songs || []) await this.removeSongAssets(song);
  }

  toast(message, isError = false) {
    const toast = this.elements.toast;
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }
}

if (SETTINGS.enabled !== false) new AdminWizard();
else $("openAdminButton")?.setAttribute("hidden", "");
