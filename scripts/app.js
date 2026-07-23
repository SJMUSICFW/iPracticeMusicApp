import { PdfCanvasViewer } from "./pdf-viewer.js";
import { LrcLyricsViewer } from "./lyrics-viewer.js";

const CONFIG = window.IPRACTICE_CONFIG || {};
const $ = id => document.getElementById(id);
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)(?:$|[?#])/i;
const PLAYLIST_STORAGE_KEY = CONFIG.adminWizard?.storageKey || "ipracticeMusic.adminWizard.v2";
const SELECTED_PLAYLIST_KEY = `${PLAYLIST_STORAGE_KEY}.selectedPlaylist`;
const PLAYLIST_DB_NAME = "iPracticeMusicAdminAssets";
const PLAYLIST_DB_STORE = "assets";
const LIBRARY_PLAYLIST_ID = "__current_song_library__";

function loadSavedPlaylistState() {
  try {
    const state = JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || "null");
    return state && Array.isArray(state.playlists)
      ? state
      : { activePlaylistId: null, playlists: [] };
  } catch (error) {
    console.warn("Could not read the saved playlists:", error);
    return { activePlaylistId: null, playlists: [] };
  }
}

function openPlaylistAssetDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PLAYLIST_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PLAYLIST_DB_STORE)) {
        database.createObjectStore(PLAYLIST_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The playlist file storage could not be opened."));
  });
}

async function readPlaylistAsset(asset) {
  if (!asset?.key) return null;
  const database = await openPlaylistAssetDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(PLAYLIST_DB_STORE, "readonly")
        .objectStore(PLAYLIST_DB_STORE)
        .get(asset.key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("A playlist file could not be read."));
    });
  } finally {
    database.close();
  }
}

function loadSongsFromAutomation(endpoint) {
  return new Promise((resolve, reject) => {
    const url = String(endpoint || "").trim();
    if (!url) {
      reject(new Error("No Apps Script configuration endpoint is set."));
      return;
    }

    const callbackName = `__iPracticeMusicConfig_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The administration service did not respond within 20 seconds."));
    }, 20000);

    function cleanup() {
      clearTimeout(timeout);
      script.remove();
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
    }

    window[callbackName] = payload => {
      cleanup();
      if (!payload || payload.ok !== true) {
        reject(new Error(payload?.message || "The administration service returned an invalid response."));
        return;
      }
      resolve(Array.isArray(payload.songs) ? payload.songs : []);
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}action=config&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("The administration configuration script could not be loaded."));
    };
    document.head.appendChild(script);
  });
}

function normalizeSong(rawSong, index) {
  const song = rawSong && typeof rawSong === "object" ? rawSong : {};
  let mediaType = String(song.mediaType || "").trim().toLowerCase();
  let mediaUrl = String(song.mediaUrl || "").trim();

  if (!mediaUrl) {
    if (song.videoUrl) { mediaType = "video"; mediaUrl = String(song.videoUrl); }
    else if (song.imageUrl) { mediaType = "image"; mediaUrl = String(song.imageUrl); }
    else if (song.pdfUrl) { mediaType = "pdf"; mediaUrl = String(song.pdfUrl); }
  }

  if (!mediaType && mediaUrl) mediaType = detectMediaType(mediaUrl);

  const tracks = (Array.isArray(song.tracks) ? song.tracks : [])
    .map((track, trackIndex) => normalizeTrack(track, trackIndex))
    .filter(track => track.url);
  const lyricsUrl = String(song.lyricsUrl || song.lrcUrl || song.syncedLyricsUrl || "").trim();
  const lyricsText = String(song.lyricsText || song.syncedLyrics || "");

  return {
    id: String(song.songId || song.id || `song-${index + 1}`),
    title: String(song.title || `Song ${index + 1}`),
    mediaType,
    mediaUrl,
    lyricsUrl,
    lyricsText,
    tracks
  };
}

function normalizeTrack(rawTrack, index) {
  const track = rawTrack && typeof rawTrack === "object" ? rawTrack : {};
  return {
    id: String(track.trackId || track.id || `track-${index + 1}`),
    name: String(track.name || track.trackName || `Track ${index + 1}`),
    subtitle: String(track.subtitle || ""),
    url: String(track.url || track.audioUrl || "").trim(),
    volume: clamp(Number(track.volume ?? 0.8), 0, 1),
    downloadAllowed: toBoolean(track.downloadAllowed, true)
  };
}

function detectMediaType(url) {
  const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|webm|mov|m4v)$/.test(clean)) return "video";
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(clean)) return "image";
  return "";
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

class IPracticeMusicPlayer {
  constructor(songDefinitions) {
    this.songs = songDefinitions.map(normalizeSong);
    this.librarySongDefinitions = this.songs.map(song => this.serializeSong(song));
    this.librarySkin = document.documentElement.dataset.widgetSkin || CONFIG.defaultSkin || "classic-blue";
    this.activePlaylistId = LIBRARY_PLAYLIST_ID;
    this.playlistObjectUrls = [];
    this.currentSongIndex = -1;
    this.audioContext = null;
    this.masterGain = null;
    this.tracks = [];
    this.localTrackIds = new Set();
    this.loadGeneration = 0;
    this.isPlaying = false;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.duration = 0;
    this.animationFrame = null;
    this.loopSongEnabled = false;
    this.loopSongListEnabled = false;
    this.loopSectionEnabled = false;
    this.loopStart = null;
    this.loopEnd = null;
    this.dragDepth = 0;
    this.activeMediaType = "";

    this.elements = {
      playlistSelect: $("playlistSelect"), playlistDescription: $("playlistDescription"),
      managePlaylistsButton: $("managePlaylistsButton"),
      songSelect: $("songSelect"), reloadButton: $("reloadButton"),
      mediaDescription: $("mediaDescription"), openMediaLink: $("openMediaLink"), mediaEmpty: $("mediaEmpty"),
      welcomeStage: $("welcomeStage"),
      videoStage: $("videoStage"), songVideo: $("songVideo"), imageStage: $("imageStage"), songImage: $("songImage"),
      imageFullscreenButton: $("imageFullscreenButton"), pdfStage: $("pdfStage"),
      lyricsSection: $("lyricsSection"), lyricsDescription: $("lyricsDescription"), lyricsStatus: $("lyricsStatus"),
      lyricsViewport: $("lyricsViewport"), lyricsLoading: $("lyricsLoading"), lyricsLines: $("lyricsLines"),
      lyricsError: $("lyricsError"), lyricsErrorMessage: $("lyricsErrorMessage"), lyricsNowPlaying: $("lyricsNowPlaying"),
      playButton: $("playButton"), stopButton: $("stopButton"), restartButton: $("restartButton"), seekBar: $("seekBar"),
      timeDisplay: $("timeDisplay"), loopSongButton: $("loopSongButton"), loopSongListButton: $("loopSongListButton"),
      setLoopStartButton: $("setLoopStartButton"), setLoopEndButton: $("setLoopEndButton"),
      loopSectionButton: $("loopSectionButton"), clearLoopButton: $("clearLoopButton"),
      practiceToggleState: $("practiceToggleState"),
      loopStartTimeInput: $("loopStartTimeInput"), loopEndTimeInput: $("loopEndTimeInput"),
      loopRangeDisplay: $("loopRangeDisplay"), practiceBoxStatus: $("practiceBoxStatus"),
      masterVolume: $("masterVolume"), masterVolumeValue: $("masterVolumeValue"),
      trackList: $("trackList"), downloadMixButton: $("downloadMixButton"), localAudioDropZone: $("localAudioDropZone"),
      fileInput: $("fileInput"), clearLocalButton: $("clearLocalButton"), status: $("status"),
      loadProgress: $("loadProgress"), loadProgressFill: $("loadProgressFill")
    };

    this.pdfViewer = new PdfCanvasViewer({
      container: $("pdfStage"), previousButton: $("pdfPreviousButton"), nextButton: $("pdfNextButton"),
      pageInput: $("pdfPageInput"), pageCount: $("pdfPageCount"), zoomOutButton: $("pdfZoomOutButton"),
      zoomInButton: $("pdfZoomInButton"), zoomOutput: $("pdfZoomOutput"), fitButton: $("pdfFitButton"),
      rotateButton: $("pdfRotateButton"), fullscreenButton: $("pdfFullscreenButton"), canvasStage: $("pdfCanvasStage"),
      loading: $("pdfLoading"), canvas: $("pdfCanvas"), error: $("pdfError"), errorMessage: $("pdfErrorMessage")
    }, {
      moduleUrls: CONFIG.pdfJsModuleUrls,
      workerUrls: CONFIG.pdfJsWorkerUrls
    });

    this.lyricsViewer = new LrcLyricsViewer({
      section: this.elements.lyricsSection,
      description: this.elements.lyricsDescription,
      status: this.elements.lyricsStatus,
      viewport: this.elements.lyricsViewport,
      loading: this.elements.lyricsLoading,
      lines: this.elements.lyricsLines,
      error: this.elements.lyricsError,
      errorMessage: this.elements.lyricsErrorMessage,
      nowPlaying: this.elements.lyricsNowPlaying
    }, {
      onSeek: seconds => this.seekToTime(seconds)
    });

    this.populatePlaylistSelector();
    this.populateSongSelector();
    this.bindControls();
    this.updateLoopControls();
    this.showStartupMedia();
    if (this.songs.length) this.setStatus("Choose a song to begin practicing.");
    else this.setStatus("No songs are configured.", true);
  }

  serializeSong(song) {
    return {
      id: song.id,
      title: song.title,
      mediaType: song.mediaType,
      mediaUrl: song.mediaUrl,
      lyricsUrl: song.lyricsUrl,
      lyricsText: song.lyricsText,
      tracks: song.tracks.map(track => ({
        id: track.id,
        name: track.name,
        subtitle: track.subtitle,
        audioUrl: track.url,
        volume: track.volume,
        downloadAllowed: track.downloadAllowed
      }))
    };
  }

  getSongDefinitions() {
    return this.songs.map(song => this.serializeSong(song));
  }

  getSavedPlaylists() {
    return loadSavedPlaylistState().playlists
      .filter(playlist => playlist && typeof playlist === "object")
      .sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")));
  }

  populatePlaylistSelector(preferredId = this.activePlaylistId) {
    const select = this.elements.playlistSelect;
    if (!select) return;

    const savedPlaylists = this.getSavedPlaylists();
    select.innerHTML = "";

    const libraryOption = document.createElement("option");
    libraryOption.value = LIBRARY_PLAYLIST_ID;
    libraryOption.textContent = `Current Song Library (${this.librarySongDefinitions.length} song${this.librarySongDefinitions.length === 1 ? "" : "s"})`;
    select.appendChild(libraryOption);

    if (savedPlaylists.length) {
      const group = document.createElement("optgroup");
      group.label = "Saved playlists";
      savedPlaylists.forEach(playlist => {
        const songCount = Array.isArray(playlist.songs) ? playlist.songs.length : 0;
        const option = document.createElement("option");
        option.value = String(playlist.id || "");
        option.textContent = `${playlist.title || "Untitled Playlist"} (${songCount} song${songCount === 1 ? "" : "s"})`;
        option.disabled = songCount === 0;
        group.appendChild(option);
      });
      select.appendChild(group);
    }

    const availableIds = new Set([LIBRARY_PLAYLIST_ID, ...savedPlaylists.map(item => String(item.id || ""))]);
    const selectedId = availableIds.has(String(preferredId)) ? String(preferredId) : LIBRARY_PLAYLIST_ID;
    this.activePlaylistId = selectedId;
    select.value = selectedId;
    this.updatePlaylistDescription();
  }

  updatePlaylistDescription() {
    const output = this.elements.playlistDescription;
    if (!output) return;
    if (this.activePlaylistId === LIBRARY_PLAYLIST_ID) {
      output.textContent = "The complete song library currently supplied to the player.";
      return;
    }
    const playlist = this.getSavedPlaylists().find(item => String(item.id) === String(this.activePlaylistId));
    if (!playlist) {
      output.textContent = "Select a playlist saved in the Administration Wizard.";
      return;
    }
    const count = Array.isArray(playlist.songs) ? playlist.songs.length : 0;
    output.textContent = playlist.description?.trim()
      ? `${playlist.description} · ${count} song${count === 1 ? "" : "s"}`
      : `${count} song${count === 1 ? "" : "s"} in this playlist.`;
  }

  revokePlaylistObjectUrls() {
    this.playlistObjectUrls.forEach(url => URL.revokeObjectURL(url));
    this.playlistObjectUrls = [];
  }

  async materializeSavedPlaylist(playlist) {
    const definitions = [];
    for (const rawSong of Array.isArray(playlist.songs) ? playlist.songs : []) {
      let mediaUrl = String(rawSong.mediaUrl || rawSong.pdfUrl || rawSong.imageUrl || rawSong.videoUrl || "");
      if (rawSong.mediaAsset) {
        const file = await readPlaylistAsset(rawSong.mediaAsset);
        if (file) {
          mediaUrl = URL.createObjectURL(file);
          this.playlistObjectUrls.push(mediaUrl);
        }
      }

      let lyricsUrl = String(rawSong.lyricsUrl || rawSong.lrcUrl || rawSong.syncedLyricsUrl || "");
      if (rawSong.lyricsAsset) {
        const file = await readPlaylistAsset(rawSong.lyricsAsset);
        if (file) {
          lyricsUrl = URL.createObjectURL(file);
          this.playlistObjectUrls.push(lyricsUrl);
        }
      }

      const tracks = [];
      for (const rawTrack of Array.isArray(rawSong.tracks) ? rawSong.tracks : []) {
        let audioUrl = String(rawTrack.audioUrl || rawTrack.url || "");
        if (rawTrack.audioAsset) {
          const file = await readPlaylistAsset(rawTrack.audioAsset);
          if (file) {
            audioUrl = URL.createObjectURL(file);
            this.playlistObjectUrls.push(audioUrl);
          }
        }
        if (audioUrl && !audioUrl.startsWith("LOCAL_FILE_REQUIRED/")) {
          tracks.push({
            id: rawTrack.id,
            name: rawTrack.name || rawTrack.trackName || "Practice Track",
            subtitle: rawTrack.subtitle || "",
            audioUrl,
            volume: rawTrack.volume,
            downloadAllowed: rawTrack.downloadAllowed !== false
          });
        }
      }

      definitions.push({
        id: rawSong.id,
        title: rawSong.title || "Untitled Song",
        mediaType: rawSong.mediaType || detectMediaType(mediaUrl),
        mediaUrl: mediaUrl.startsWith("LOCAL_FILE_REQUIRED/") ? "" : mediaUrl,
        lyricsUrl: lyricsUrl.startsWith("LOCAL_FILE_REQUIRED/") ? "" : lyricsUrl,
        lyricsText: rawSong.lyricsText || rawSong.syncedLyrics || "",
        tracks
      });
    }
    return definitions;
  }

  applyPlaylistSkin(skin) {
    const safeSkin = String(skin || "").trim();
    if (!safeSkin) return;
    const skinLink = $("widgetSkinStylesheet");
    if (skinLink) {
      skinLink.href = `skins/${encodeURIComponent(safeSkin)}.css`;
      document.documentElement.dataset.widgetSkin = safeSkin;
    }
  }

  async openSavedPlaylist(playlistId, { announce = true } = {}) {
    const requestedId = String(playlistId || LIBRARY_PLAYLIST_ID);
    if (requestedId === LIBRARY_PLAYLIST_ID) {
      this.revokePlaylistObjectUrls();
      this.activePlaylistId = LIBRARY_PLAYLIST_ID;
      await this.replaceSongs(this.librarySongDefinitions);
      this.applyPlaylistSkin(this.librarySkin);
      localStorage.setItem(SELECTED_PLAYLIST_KEY, LIBRARY_PLAYLIST_ID);
      this.populatePlaylistSelector(LIBRARY_PLAYLIST_ID);
      if (announce) this.setStatus("The complete song library is open. Choose a song to begin.");
      return;
    }

    const playlist = this.getSavedPlaylists().find(item => String(item.id) === requestedId);
    if (!playlist) throw new Error("That saved playlist could not be found on this device.");
    if (!Array.isArray(playlist.songs) || !playlist.songs.length) throw new Error("That playlist does not contain any songs.");

    this.elements.playlistSelect.disabled = true;
    this.elements.managePlaylistsButton.disabled = true;
    this.setStatus(`Opening “${playlist.title || "Saved Playlist"}”…`);
    try {
      this.stop();
      this.revokePlaylistObjectUrls();
      const definitions = await this.materializeSavedPlaylist(playlist);
      await this.replaceSongs(definitions);
      this.activePlaylistId = requestedId;
      this.applyPlaylistSkin(playlist.skin || this.librarySkin);
      localStorage.setItem(SELECTED_PLAYLIST_KEY, requestedId);
      this.populatePlaylistSelector(requestedId);
      if (announce) this.setStatus(`Playlist “${playlist.title || "Saved Playlist"}” is open. Choose a song to begin.`);
    } catch (error) {
      this.revokePlaylistObjectUrls();
      this.activePlaylistId = LIBRARY_PLAYLIST_ID;
      await this.replaceSongs(this.librarySongDefinitions);
      this.applyPlaylistSkin(this.librarySkin);
      this.populatePlaylistSelector(LIBRARY_PLAYLIST_ID);
      throw error;
    } finally {
      this.elements.playlistSelect.disabled = false;
      this.elements.managePlaylistsButton.disabled = false;
    }
  }

  async replaceSongs(songDefinitions) {
    const normalized = (Array.isArray(songDefinitions) ? songDefinitions : []).map(normalizeSong);
    this.loadGeneration += 1;
    this.stop();
    this.clearTrackObjects();
    this.resetLoop();
    await this.pdfViewer.destroyDocument();
    this.songs = normalized;
    this.currentSongIndex = -1;
    this.populateSongSelector();
    this.showStartupMedia();

    if (!this.songs.length) {
      this.elements.trackList.innerHTML = '<div class="empty-state compact-empty">No songs are configured.</div>';
      this.setStatus("No songs are configured.", true);
      return;
    }

    this.setStatus("Choose a song from this playlist to begin practicing.");
  }

  async ensureAudioContext(resume = false) {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support the Web Audio API.");
      this.audioContext = new AudioContextClass();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = Number(this.elements.masterVolume.value);
      this.masterGain.connect(this.audioContext.destination);
    }
    if (resume && this.audioContext.state === "suspended") await this.audioContext.resume();
  }

  populateSongSelector() {
    const select = this.elements.songSelect;
    select.innerHTML = "";

    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = this.songs.length ? "Choose a song…" : "No songs available";
    prompt.selected = true;
    prompt.disabled = this.songs.length > 0;
    select.appendChild(prompt);

    this.songs.forEach((song, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = song.title;
      select.appendChild(option);
    });

    select.disabled = this.songs.length === 0;
  }

  bindControls() {
    const e = this.elements;
    e.playlistSelect?.addEventListener("change", async () => {
      const previousId = this.activePlaylistId;
      try {
        await this.openSavedPlaylist(e.playlistSelect.value);
      } catch (error) {
        e.playlistSelect.value = previousId;
        this.setStatus(error.message, true);
      }
    });
    e.managePlaylistsButton?.addEventListener("click", () => $("openAdminButton")?.click());
    window.addEventListener("ipractice:playlists-changed", () => {
      this.populatePlaylistSelector(this.activePlaylistId);
    });
    window.addEventListener("storage", event => {
      if (event.key === PLAYLIST_STORAGE_KEY) this.populatePlaylistSelector(this.activePlaylistId);
    });
    e.songSelect.addEventListener("change", () => {
      if (e.songSelect.value === "") return;
      this.loadSong(Number(e.songSelect.value));
    });
    e.reloadButton.addEventListener("click", () => window.location.reload());
    e.playButton.addEventListener("click", () => this.isPlaying ? this.pause() : this.play());
    e.stopButton.addEventListener("click", () => this.stop());
    e.restartButton.addEventListener("click", () => this.restart());
    e.seekBar.addEventListener("input", () => this.previewSeek());
    e.seekBar.addEventListener("change", () => this.commitSeek());
    e.masterVolume.addEventListener("input", () => this.updateMasterVolume());
    e.loopSongButton.addEventListener("click", () => this.toggleSongLoop());
    e.loopSongListButton.addEventListener("click", () => this.toggleSongListLoop());
    e.setLoopStartButton.addEventListener("click", () => this.setLoopPoint("start"));
    e.setLoopEndButton.addEventListener("click", () => this.setLoopPoint("end"));
    e.loopSectionButton.addEventListener("click", () => this.toggleSectionLoop());
    e.clearLoopButton.addEventListener("click", () => this.clearSectionLoop());
    [
      [e.loopStartTimeInput, "start"],
      [e.loopEndTimeInput, "end"]
    ].forEach(([input, which]) => {
      input.addEventListener("input", () => input.classList.remove("invalid"));
      input.addEventListener("change", () => this.applyExactLoopTime(which));
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
      });
    });
    e.downloadMixButton.addEventListener("click", () => this.downloadMixAsMp3());
    e.fileInput.addEventListener("change", event => this.addLocalFiles(Array.from(event.target.files || [])));
    e.clearLocalButton.addEventListener("click", () => this.clearLocalTracks());
    e.localAudioDropZone.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); e.fileInput.click(); }
    });
    e.localAudioDropZone.addEventListener("dragenter", event => this.handleDragEnter(event));
    e.localAudioDropZone.addEventListener("dragover", event => { event.preventDefault(); });
    e.localAudioDropZone.addEventListener("dragleave", event => this.handleDragLeave(event));
    e.localAudioDropZone.addEventListener("drop", event => this.handleDrop(event));
    e.imageFullscreenButton.addEventListener("click", () => this.toggleImageFullscreen());

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && e.imageStage.classList.contains("image-fullscreen-fallback")) {
        this.closeImageFullscreen();
      }
    });
  }

  showStartupMedia() {
    const e = this.elements;
    this.activeMediaType = "";
    [e.videoStage, e.imageStage, e.pdfStage].forEach(element => { element.hidden = true; });
    e.welcomeStage.hidden = false;
    e.mediaEmpty.hidden = true;
    e.openMediaLink.hidden = true;
    e.mediaDescription.textContent = "Choose a song and its video, image, or PDF will replace the welcome screen.";
    e.songVideo.pause();
    e.songVideo.removeAttribute("src");
    e.songVideo.load();
    e.songImage.removeAttribute("src");
    this.lyricsViewer.clear();
    this.renderTracks();
    this.updateTimeUi();
  }

  async loadSong(index) {
    const song = this.songs[index];
    if (!song) return;
    const generation = ++this.loadGeneration;
    this.currentSongIndex = index;
    this.elements.songSelect.value = String(index);
    this.stop();
    this.clearTrackObjects();
    this.resetPracticeBox();
    await Promise.allSettled([
      this.updateMedia(song),
      this.updateLyrics(song)
    ]);

    if (!song.tracks.length) {
      this.renderTracks();
      this.setStatus(`“${song.title}” has no audio tracks yet.`);
      return;
    }

    try {
      await this.ensureAudioContext(false);
      this.elements.loadProgress.hidden = false;
      this.updateLoadProgress(0);
      this.setStatus(`Loading ${song.tracks.length} track${song.tracks.length === 1 ? "" : "s"} for “${song.title}”…`);

      let completed = 0;
      const results = await Promise.allSettled(song.tracks.map(async definition => {
        const track = await this.loadRemoteTrack(definition);
        completed += 1;
        this.updateLoadProgress((completed / song.tracks.length) * 100);
        return track;
      }));

      if (generation !== this.loadGeneration) return;
      this.tracks = results.filter(result => result.status === "fulfilled").map(result => result.value);
      this.refreshDuration();
      this.renderTracks();
      this.updateTimeUi();
      this.elements.loadProgress.hidden = true;

      const failed = results.length - this.tracks.length;
      this.setStatus(failed
        ? `${this.tracks.length} track(s) loaded; ${failed} could not be loaded. Check the audio paths and CORS permissions.`
        : `Ready: “${song.title}” loaded with ${this.tracks.length} track${this.tracks.length === 1 ? "" : "s"}.`,
        failed > 0
      );
    } catch (error) {
      this.elements.loadProgress.hidden = true;
      this.setStatus(error.message, true);
    }
  }

  async loadRemoteTrack(definition) {
    const response = await fetch(new URL(definition.url, window.location.href).href, { mode: "cors", cache: "default" });
    if (!response.ok) throw new Error(`${definition.name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const buffer = await this.audioContext.decodeAudioData(bytes.slice(0));
    return { ...definition, buffer, muted: false, solo: false, source: null, gainNode: null, local: false };
  }

  async addLocalFiles(files) {
    const audioFiles = files.filter(file => file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name));
    if (!audioFiles.length) {
      this.setStatus("No supported audio files were selected.", true);
      return;
    }

    await this.ensureAudioContext(false);
    let added = 0;
    for (const file of audioFiles) {
      try {
        const buffer = await this.audioContext.decodeAudioData((await file.arrayBuffer()).slice(0));
        const id = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.localTrackIds.add(id);
        this.tracks.push({
          id, name: file.name.replace(/\.[^.]+$/, ""), subtitle: "Local audio file", url: "", volume: 0.8,
          downloadAllowed: false, buffer, muted: false, solo: false, source: null, gainNode: null, local: true
        });
        added += 1;
      } catch (error) {
        console.warn("Local audio could not be decoded:", file.name, error);
      }
    }
    this.elements.fileInput.value = "";
    this.refreshDuration();
    this.renderTracks();
    this.updateTimeUi();
    this.setStatus(`${added} local audio file${added === 1 ? "" : "s"} added.`);
  }

  clearLocalTracks() {
    const wasPlaying = this.isPlaying;
    this.stopSources();
    this.tracks = this.tracks.filter(track => !this.localTrackIds.has(track.id));
    this.localTrackIds.clear();
    this.pausedAt = 0;
    this.refreshDuration();
    this.renderTracks();
    this.updateTimeUi();
    if (wasPlaying && this.tracks.length) this.play();
    this.setStatus("Local audio files removed.");
  }

  clearTrackObjects() {
    this.stopSources();
    this.tracks = [];
    this.localTrackIds.clear();
    this.pausedAt = 0;
    this.duration = 0;
    this.renderTracks();
    this.updateTimeUi();
  }

  async updateMedia(song) {
    const e = this.elements;
    await this.pdfViewer.destroyDocument();
    this.activeMediaType = song.mediaType || detectMediaType(song.mediaUrl);
    [e.videoStage, e.imageStage, e.pdfStage].forEach(element => { element.hidden = true; });
    e.welcomeStage.hidden = true;
    e.mediaEmpty.hidden = true;
    e.openMediaLink.hidden = true;
    e.songVideo.pause();
    e.songVideo.removeAttribute("src");
    e.songVideo.load();
    e.songImage.removeAttribute("src");

    if (!song.mediaUrl || !this.activeMediaType) {
      e.mediaEmpty.hidden = false;
      e.mediaDescription.textContent = "No video, image, or PDF is configured for this song.";
      return;
    }

    const resolvedUrl = new URL(song.mediaUrl, window.location.href).href;
    e.openMediaLink.href = resolvedUrl;
    e.openMediaLink.hidden = false;

    if (this.activeMediaType === "video") {
      e.videoStage.hidden = false;
      e.songVideo.src = resolvedUrl;
      e.songVideo.load();
      e.mediaDescription.textContent = "Synchronized practice video";
      return;
    }

    if (this.activeMediaType === "image") {
      e.imageStage.hidden = false;
      e.songImage.src = resolvedUrl;
      e.songImage.alt = `Practice image for ${song.title}`;
      e.mediaDescription.textContent = "Practice image or sheet music";
      return;
    }

    if (this.activeMediaType === "pdf") {
      e.pdfStage.hidden = false;
      $("pdfErrorOpenLink").href = resolvedUrl;
      e.mediaDescription.textContent = "PDF sheet music rendered directly by iPracticeMusic 2.0";
      try {
        await this.pdfViewer.load(resolvedUrl, `${song.title} sheet music`);
      } catch (error) {
        this.setStatus(`PDF viewer: ${error.message}`, true);
      }
      return;
    }

    e.mediaEmpty.hidden = false;
    e.mediaDescription.textContent = "The configured media type is not supported.";
  }

  async updateLyrics(song) {
    const hasLyrics = Boolean(String(song.lyricsUrl || "").trim() || String(song.lyricsText || "").trim());
    this.lyricsViewer.clear({ keepVisible: hasLyrics });
    this.elements.lyricsSection.hidden = !hasLyrics;
    if (!hasLyrics) return;

    const label = `${song.title} synced lyrics`;
    try {
      if (String(song.lyricsText || "").trim()) {
        this.lyricsViewer.loadText(song.lyricsText, label);
      } else {
        await this.lyricsViewer.load(song.lyricsUrl, label);
      }
      this.lyricsViewer.setTime(this.getCurrentTime(), { force: true });
    } catch (error) {
      console.warn(`Lyrics could not be loaded for ${song.title}:`, error);
    }
  }

  renderTracks() {
    const list = this.elements.trackList;
    list.innerHTML = "";
    if (!this.tracks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";
      empty.textContent = "No audio tracks are available for this song.";
      list.appendChild(empty);
      return;
    }

    this.tracks.forEach(track => {
      const row = document.createElement("article");
      row.className = "track-row";
      row.dataset.trackId = track.id;

      const copy = document.createElement("div");
      copy.className = "track-copy";
      const strong = document.createElement("strong");
      strong.textContent = track.name;
      const small = document.createElement("small");
      small.textContent = track.subtitle || (track.local ? "Local audio file" : "Practice track");
      copy.append(strong, small);

      const mute = document.createElement("button");
      mute.type = "button";
      mute.textContent = track.muted ? "Unmute" : "Mute";
      mute.classList.toggle("active", track.muted);
      mute.setAttribute("aria-pressed", String(track.muted));
      mute.addEventListener("click", () => { track.muted = !track.muted; this.applyTrackMix(); this.renderTracks(); });

      const solo = document.createElement("button");
      solo.type = "button";
      solo.textContent = track.solo ? "Unsolo" : "Solo";
      solo.classList.toggle("active", track.solo);
      solo.setAttribute("aria-pressed", String(track.solo));
      solo.addEventListener("click", () => { track.solo = !track.solo; this.applyTrackMix(); this.renderTracks(); });

      const volumeWrap = document.createElement("label");
      volumeWrap.className = "track-volume-wrap";
      const volume = document.createElement("input");
      volume.type = "range";
      volume.min = "0";
      volume.max = "1";
      volume.step = "0.01";
      volume.value = String(track.volume);
      volume.setAttribute("aria-label", `${track.name} volume`);
      const value = document.createElement("output");
      value.textContent = `${Math.round(track.volume * 100)}%`;
      volume.addEventListener("input", () => {
        track.volume = Number(volume.value);
        value.textContent = `${Math.round(track.volume * 100)}%`;
        this.applyTrackMix();
      });
      volumeWrap.append(volume, value);

      const download = document.createElement("a");
      download.className = "track-download";
      download.textContent = track.downloadAllowed && track.url ? "Download" : "No download";
      if (track.downloadAllowed && track.url) {
        download.href = new URL(track.url, window.location.href).href;
        download.download = "";
      } else {
        download.classList.add("disabled");
        download.setAttribute("aria-disabled", "true");
      }

      row.append(copy, mute, solo, volumeWrap, download);
      list.appendChild(row);
    });
  }

  async play() {
    if (!this.tracks.some(track => track.buffer) || this.duration <= 0) {
      this.setStatus("No playable audio tracks are loaded.", true);
      return;
    }
    await this.ensureAudioContext(true);
    if (this.pausedAt >= this.duration) this.pausedAt = 0;
    if (this.loopSectionEnabled && this.hasValidSectionLoop() && (this.pausedAt < this.loopStart || this.pausedAt >= this.loopEnd)) {
      this.pausedAt = this.loopStart;
    }

    this.stopSources();
    const startOffset = this.pausedAt;
    this.startedAt = this.audioContext.currentTime - startOffset;
    const anySolo = this.tracks.some(track => track.solo);

    this.tracks.forEach(track => {
      if (!track.buffer) return;
      const source = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      source.buffer = track.buffer;
      source.connect(gain);
      gain.connect(this.masterGain);
      const audible = !track.muted && (!anySolo || track.solo);
      gain.gain.value = audible ? track.volume : 0;
      track.source = source;
      track.gainNode = gain;
      source.start(0, Math.min(startOffset, Math.max(0, track.buffer.duration - 0.001)));
    });

    this.isPlaying = true;
    this.elements.playButton.textContent = "❚❚ Pause";
    this.playVideo(startOffset);
    this.startProgressLoop();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pausedAt = this.getCurrentTime();
    this.stopSources();
    this.updateTimeUi();
  }

  stop() {
    this.stopSources();
    this.pausedAt = 0;
    this.setVideoTime(0);
    this.updateTimeUi();
  }

  async restart() {
    const wasPlaying = this.isPlaying;
    this.stopSources();
    this.pausedAt = 0;
    this.setVideoTime(0);
    this.updateTimeUi();
    if (wasPlaying) await this.play();
  }

  stopSources() {
    this.tracks.forEach(track => {
      if (track.source) {
        try { track.source.stop(); } catch (_) {}
        try { track.source.disconnect(); } catch (_) {}
        track.source = null;
      }
      if (track.gainNode) {
        try { track.gainNode.disconnect(); } catch (_) {}
        track.gainNode = null;
      }
    });
    this.elements.songVideo.pause();
    this.isPlaying = false;
    this.elements.playButton.textContent = "▶ Play";
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  startProgressLoop() {
    const update = async () => {
      if (!this.isPlaying) return;
      let current = this.getCurrentTime();

      if (this.loopSectionEnabled && this.hasValidSectionLoop() && current >= this.loopEnd) {
        this.stopSources();
        this.pausedAt = this.loopStart;
        await this.play();
        return;
      }

      if (current >= this.duration) {
        if (this.loopSongEnabled) {
          this.stopSources();
          this.pausedAt = 0;
          await this.play();
          return;
        }
        if (this.loopSongListEnabled) {
          await this.playNextSongInList();
          return;
        }
        this.stop();
        return;
      }

      this.pausedAt = current;
      this.correctVideoDrift(current);
      this.updateTimeUi();
      this.animationFrame = requestAnimationFrame(update);
    };
    update();
  }

  getCurrentTime() {
    if (this.isPlaying && this.audioContext) return clamp(this.audioContext.currentTime - this.startedAt, 0, this.duration);
    return clamp(this.pausedAt, 0, this.duration);
  }

  previewSeek() {
    const time = Number(this.elements.seekBar.value) / 1000;
    this.elements.timeDisplay.textContent = `${formatTime(time)} / ${formatTime(this.duration)}`;
    this.setVideoTime(time);
    this.lyricsViewer.setTime(time);
  }

  async commitSeek() {
    await this.seekToTime(Number(this.elements.seekBar.value) / 1000);
  }

  async seekToTime(target) {
    const wasPlaying = this.isPlaying;
    this.stopSources();
    this.pausedAt = clamp(Number(target), 0, this.duration);
    this.setVideoTime(this.pausedAt);
    this.lyricsViewer.setTime(this.pausedAt, { force: true });
    if (wasPlaying) await this.play();
    else this.updateTimeUi();
  }

  updateTimeUi() {
    const current = this.getCurrentTime();
    const enabled = this.duration > 0;
    this.elements.seekBar.max = enabled ? String(Math.max(1, Math.round(this.duration * 1000))) : "1";
    this.elements.seekBar.value = enabled ? String(Math.round(current * 1000)) : "0";
    this.elements.timeDisplay.textContent = `${formatTime(current)} / ${formatTime(this.duration)}`;
    this.lyricsViewer.setTime(current);
    this.elements.playButton.disabled = !enabled;
    this.elements.stopButton.disabled = !enabled;
    this.elements.restartButton.disabled = !enabled;
    this.elements.loopSongButton.disabled = !enabled;
    this.elements.loopSongListButton.disabled = !enabled || this.songs.length < 2;
    this.elements.downloadMixButton.disabled = !enabled;
    this.elements.setLoopStartButton.disabled = !enabled;
    this.elements.setLoopEndButton.disabled = !enabled;
    this.elements.loopStartTimeInput.disabled = !enabled;
    this.elements.loopEndTimeInput.disabled = !enabled;
  }

  refreshDuration() {
    this.duration = this.tracks.reduce((max, track) => Math.max(max, track.buffer?.duration || 0), 0);
  }

  updateMasterVolume() {
    const value = Number(this.elements.masterVolume.value);
    this.elements.masterVolumeValue.value = `${Math.round(value * 100)}%`;
    if (this.masterGain && this.audioContext) this.masterGain.gain.setTargetAtTime(value, this.audioContext.currentTime, 0.01);
  }

  applyTrackMix() {
    if (!this.audioContext) return;
    const anySolo = this.tracks.some(track => track.solo);
    this.tracks.forEach(track => {
      if (!track.gainNode) return;
      const audible = !track.muted && (!anySolo || track.solo);
      track.gainNode.gain.setTargetAtTime(audible ? track.volume : 0, this.audioContext.currentTime, 0.01);
    });
  }

  toggleSongLoop() {
    this.loopSongEnabled = !this.loopSongEnabled;
    if (this.loopSongEnabled) {
      this.loopSongListEnabled = false;
      this.loopSectionEnabled = false;
    }
    this.updateLoopControls();
    this.setStatus(this.loopSongEnabled ? "Entire-song looping is on." : "Entire-song looping is off.");
  }

  toggleSongListLoop() {
    this.loopSongListEnabled = !this.loopSongListEnabled;
    if (this.loopSongListEnabled) {
      this.loopSongEnabled = false;
      this.loopSectionEnabled = false;
    }
    this.updateLoopControls();
    this.setStatus(this.loopSongListEnabled
      ? "The entire songlist will repeat continuously."
      : "Songlist looping is off.");
  }

  async playNextSongInList() {
    if (!this.songs.length) {
      this.stop();
      return;
    }

    this.stopSources();
    const originalIndex = this.currentSongIndex;

    for (let attempt = 1; attempt <= this.songs.length; attempt += 1) {
      const nextIndex = (originalIndex + attempt) % this.songs.length;
      await this.loadSong(nextIndex);
      if (this.tracks.some(track => track.buffer) && this.duration > 0) {
        this.setStatus(`Songlist loop: now playing “${this.songs[nextIndex].title}”.`);
        await this.play();
        return;
      }
    }

    this.stop();
    this.setStatus("Songlist looping stopped because no playable songs were found.", true);
  }

  setLoopPoint(which) {
    const current = roundToMilliseconds(this.getCurrentTime());
    if (which === "start") this.loopStart = current;
    else this.loopEnd = current;
    if (this.loopStart !== null && this.loopEnd !== null && this.loopEnd <= this.loopStart) {
      if (which === "start") this.loopEnd = null; else this.loopStart = null;
      this.loopSectionEnabled = false;
      this.setStatus("The Practice Box ending must be later than its beginning.", true);
    } else {
      this.setStatus(which === "start"
        ? `Practice Box beginning marked at ${formatTime(current)}.`
        : `Practice Box ending marked at ${formatTime(current)}.`);
    }
    this.updateLoopControls();
  }

  applyExactLoopTime(which) {
    const input = which === "start" ? this.elements.loopStartTimeInput : this.elements.loopEndTimeInput;
    const rawValue = input.value.trim();
    const previous = which === "start" ? this.loopStart : this.loopEnd;

    if (!rawValue) {
      if (which === "start") this.loopStart = null;
      else this.loopEnd = null;
      this.loopSectionEnabled = false;
      input.classList.remove("invalid");
      this.updateLoopControls();
      this.setStatus(`${which === "start" ? "Beginning" : "Ending"} time cleared.`);
      return;
    }

    const parsed = parsePreciseTime(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0 || (this.duration > 0 && parsed > this.duration)) {
      input.classList.add("invalid");
      input.value = previous === null ? rawValue : formatTime(previous);
      this.setStatus(`Enter a valid time between 0:00.000 and ${formatTime(this.duration)}.`, true);
      return;
    }

    if (which === "start") this.loopStart = parsed;
    else this.loopEnd = parsed;

    if (this.loopStart !== null && this.loopEnd !== null && this.loopEnd <= this.loopStart) {
      if (which === "start") this.loopStart = previous;
      else this.loopEnd = previous;
      input.classList.add("invalid");
      input.value = previous === null ? "" : formatTime(previous);
      this.loopSectionEnabled = false;
      this.updateLoopControls();
      this.setStatus("The Practice Box ending must be later than its beginning.", true);
      return;
    }

    input.classList.remove("invalid");
    input.value = formatTime(parsed);
    this.updateLoopControls();
    this.setStatus(`${which === "start" ? "Beginning" : "Ending"} set precisely to ${formatTime(parsed)}.`);
  }

  toggleSectionLoop() {
    if (!this.hasValidSectionLoop()) return;
    this.loopSectionEnabled = !this.loopSectionEnabled;
    if (this.loopSectionEnabled) {
      this.loopSongEnabled = false;
      this.loopSongListEnabled = false;
    }
    this.updateLoopControls();
    this.setStatus(this.loopSectionEnabled
      ? `Practice Box is repeating from ${formatTime(this.loopStart)} to ${formatTime(this.loopEnd)}.`
      : "Practice Box repetition is paused.");
  }

  clearSectionLoop() {
    this.loopStart = null;
    this.loopEnd = null;
    this.loopSectionEnabled = false;
    this.updateLoopControls();
    this.setStatus("Practice Box beginning and ending cleared.");
  }

  resetPracticeBox() {
    this.loopSectionEnabled = false;
    this.loopStart = null;
    this.loopEnd = null;
    this.updateLoopControls();
  }

  resetLoop() {
    this.loopSongEnabled = false;
    this.loopSongListEnabled = false;
    this.resetPracticeBox();
  }

  hasValidSectionLoop() {
    return Number.isFinite(this.loopStart) && Number.isFinite(this.loopEnd) && this.loopEnd > this.loopStart;
  }

  updateLoopControls() {
    const e = this.elements;
    const hasPracticeBox = this.hasValidSectionLoop();

    e.loopSongButton.textContent = `↻ Loop Song: ${this.loopSongEnabled ? "On" : "Off"}`;
    e.loopSongButton.setAttribute("aria-pressed", String(this.loopSongEnabled));
    e.loopSongButton.classList.toggle("active", this.loopSongEnabled);

    e.loopSongListButton.textContent = `↻ Loop Songlist: ${this.loopSongListEnabled ? "On" : "Off"}`;
    e.loopSongListButton.setAttribute("aria-pressed", String(this.loopSongListEnabled));
    e.loopSongListButton.classList.toggle("active", this.loopSongListEnabled);

    e.practiceToggleState.textContent = this.loopSectionEnabled ? "On" : "Off";
    e.loopSectionButton.setAttribute("aria-label", `Practice: ${this.loopSectionEnabled ? "on" : "off"}`);
    e.loopSectionButton.setAttribute("aria-pressed", String(this.loopSectionEnabled));
    e.loopSectionButton.classList.toggle("is-on", this.loopSectionEnabled);
    e.loopSectionButton.classList.toggle("is-off", !this.loopSectionEnabled);
    e.loopSectionButton.disabled = !hasPracticeBox;

    e.practiceBoxStatus.textContent = this.loopSectionEnabled ? "On" : "Off";
    e.practiceBoxStatus.classList.toggle("is-on", this.loopSectionEnabled);
    e.practiceBoxStatus.classList.toggle("is-off", !this.loopSectionEnabled);

    e.clearLoopButton.disabled = this.loopStart === null && this.loopEnd === null;
    if (document.activeElement !== e.loopStartTimeInput) {
      e.loopStartTimeInput.value = this.loopStart === null ? "" : formatTime(this.loopStart);
    }
    if (document.activeElement !== e.loopEndTimeInput) {
      e.loopEndTimeInput.value = this.loopEnd === null ? "" : formatTime(this.loopEnd);
    }
    e.loopRangeDisplay.textContent = `Beginning: ${this.loopStart === null ? "—" : formatTime(this.loopStart)} · Ending: ${this.loopEnd === null ? "—" : formatTime(this.loopEnd)}`;
  }

  playVideo(seconds) {
    if (this.activeMediaType !== "video" || !this.elements.songVideo.src) return;
    this.setVideoTime(seconds);
    this.elements.songVideo.muted = true;
    this.elements.songVideo.play().catch(error => console.warn("Video playback did not start:", error));
  }

  setVideoTime(seconds) {
    const video = this.elements.songVideo;
    if (this.activeMediaType !== "video" || !video.src || video.readyState < 1) return;
    try { video.currentTime = Math.min(Math.max(0, seconds), Number.isFinite(video.duration) ? video.duration : seconds); } catch (_) {}
  }

  correctVideoDrift(target) {
    const video = this.elements.songVideo;
    if (this.activeMediaType === "video" && !video.paused && video.readyState >= 2 && Math.abs(video.currentTime - target) > 0.35) {
      this.setVideoTime(target);
    }
  }

  async toggleImageFullscreen() {
    const stage = this.elements.imageStage;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else this.openImageFullscreen();
    } catch (_) { this.openImageFullscreen(); }
  }

  openImageFullscreen() {
    this.elements.imageStage.classList.add("image-fullscreen-fallback");
    document.body.classList.add("modal-open");
  }

  closeImageFullscreen() {
    this.elements.imageStage.classList.remove("image-fullscreen-fallback");
    document.body.classList.remove("modal-open");
  }

  handleDragEnter(event) {
    event.preventDefault();
    this.dragDepth += 1;
    this.elements.localAudioDropZone.classList.add("drag-over");
  }

  handleDragLeave(event) {
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) this.elements.localAudioDropZone.classList.remove("drag-over");
  }

  handleDrop(event) {
    event.preventDefault();
    this.dragDepth = 0;
    this.elements.localAudioDropZone.classList.remove("drag-over");
    this.addLocalFiles(Array.from(event.dataTransfer?.files || []));
  }

  updateLoadProgress(percent) {
    this.elements.loadProgressFill.style.width = `${clamp(percent, 0, 100)}%`;
  }

  setStatus(message, isError = false) {
    this.elements.status.textContent = String(message || "");
    this.elements.status.classList.toggle("error", isError);
  }

  async downloadMixAsMp3() {
    await this.ensureAudioContext(false);
    if (!window.lamejs) {
      this.setStatus("The MP3 encoder was blocked or did not load. Reload the page or lower Brave Shields for this site.", true);
      return;
    }
    const anySolo = this.tracks.some(track => track.solo);
    const audible = this.tracks.filter(track => track.buffer && !track.muted && (!anySolo || track.solo) && track.volume > 0);
    if (!audible.length || !this.duration || Number(this.elements.masterVolume.value) <= 0) {
      this.setStatus("The current mix is silent. Unmute a track and raise its volume first.", true);
      return;
    }

    const button = this.elements.downloadMixButton;
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Rendering mix…";
    this.setStatus("Rendering the current mix from the beginning…");

    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) throw new Error("Offline audio rendering is not supported by this browser.");
      const sampleRate = Math.min(48000, this.audioContext.sampleRate || 44100);
      const length = Math.ceil(this.duration * sampleRate);
      const offline = new Offline(2, Math.max(1, length), sampleRate);
      const master = offline.createGain();
      master.gain.value = Number(this.elements.masterVolume.value);
      master.connect(offline.destination);

      audible.forEach(track => {
        const source = offline.createBufferSource();
        const gain = offline.createGain();
        source.buffer = track.buffer;
        gain.gain.value = track.volume;
        source.connect(gain);
        gain.connect(master);
        source.start(0);
      });

      const rendered = await offline.startRendering();
      const blob = encodeMp3(rendered);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${safeFilename(this.songs[this.currentSongIndex]?.title || "ipracticemusic-mix")}.mp3`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      this.setStatus("The MP3 mix is ready.");
    } catch (error) {
      this.setStatus(`Mix export failed: ${error.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }
}

function encodeMp3(audioBuffer) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const encoder = new window.lamejs.Mp3Encoder(channels, sampleRate, 192);
  const left = floatToInt16(audioBuffer.getChannelData(0));
  const right = channels === 2 ? floatToInt16(audioBuffer.getChannelData(1)) : null;
  const blockSize = 1152;
  const chunks = [];
  for (let offset = 0; offset < left.length; offset += blockSize) {
    const leftChunk = left.subarray(offset, offset + blockSize);
    const encoded = channels === 2
      ? encoder.encodeBuffer(leftChunk, right.subarray(offset, offset + blockSize))
      : encoder.encodeBuffer(leftChunk);
    if (encoded.length) chunks.push(new Uint8Array(encoded));
  }
  const final = encoder.flush();
  if (final.length) chunks.push(new Uint8Array(final));
  return new Blob(chunks, { type: "audio/mpeg" });
}

function floatToInt16(floatArray) {
  const result = new Int16Array(floatArray.length);
  for (let index = 0; index < floatArray.length; index += 1) {
    const sample = clamp(floatArray[index], -1, 1);
    result[index] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return result;
}

function roundToMilliseconds(seconds) {
  return Math.round(Number(seconds) * 1000) / 1000;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMilliseconds / 60000);
  const secondsPart = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${minutes}:${String(secondsPart).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function parsePreciseTime(value) {
  const normalized = String(value || "").trim().replace(",", ".");
  if (!normalized) return NaN;
  const parts = normalized.split(":");
  if (parts.length > 3 || parts.some(part => part.trim() === "")) return NaN;
  const numbers = parts.map(Number);
  if (numbers.some(number => !Number.isFinite(number) || number < 0)) return NaN;

  let totalSeconds;
  if (numbers.length === 1) {
    totalSeconds = numbers[0];
  } else if (numbers.length === 2) {
    if (numbers[1] >= 60) return NaN;
    totalSeconds = numbers[0] * 60 + numbers[1];
  } else {
    if (numbers[1] >= 60 || numbers[2] >= 60) return NaN;
    totalSeconds = numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  }

  return roundToMilliseconds(totalSeconds);
}

function safeFilename(value) {
  return String(value || "mix").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mix";
}

async function start() {
  const parameters = new URLSearchParams(window.location.search);
  const fallback = Array.isArray(CONFIG.fallbackSongs) ? CONFIG.fallbackSongs : [];
  const demo = Array.isArray(CONFIG.demoSongs) ? CONFIG.demoSongs : [];
  let songs = [];
  let loadError = null;

  if (parameters.get("demo") === "1") {
    songs = demo.length ? demo : fallback;
  } else {
    try {
      songs = await loadSongsFromAutomation(CONFIG.configEndpoint);
    } catch (error) {
      loadError = error;
      songs = fallback;
    }
  }

  const player = new IPracticeMusicPlayer(songs);
  window.iPracticeMusicPlayer = player;
  window.dispatchEvent(new CustomEvent("ipractice:player-ready", { detail: { player } }));
  if (loadError) player.setStatus(`${loadError.message} The fallback configuration is being shown.`, true);

  const savedSelection = localStorage.getItem(SELECTED_PLAYLIST_KEY);
  if (savedSelection && savedSelection !== LIBRARY_PLAYLIST_ID) {
    try {
      await player.openSavedPlaylist(savedSelection, { announce: false });
    } catch (error) {
      localStorage.removeItem(SELECTED_PLAYLIST_KEY);
      player.populatePlaylistSelector(LIBRARY_PLAYLIST_ID);
      console.warn("The previously selected playlist could not be restored:", error);
    }
  }
}

start();
