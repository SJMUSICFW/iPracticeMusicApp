const METADATA_KEYS = new Set(["ar", "al", "ti", "au", "by", "re", "ve", "length", "la"]);

export function parseLrc(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const metadata = {};
  const parsedLines = [];
  const globalOffsetMatch = text.match(/^\[offset\s*:\s*([+-]?\d+)\]\s*$/im);
  let offsetMs = globalOffsetMatch ? Number(globalOffsetMatch[1]) || 0 : 0;
  let sequence = 0;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const offsetMatch = trimmed.match(/^\[offset\s*:\s*([+-]?\d+)\]\s*$/i);
    if (offsetMatch) {
      metadata.offset = String(offsetMs);
      continue;
    }

    const metadataMatch = trimmed.match(/^\[([a-z]+)\s*:\s*(.*?)\]\s*$/i);
    if (metadataMatch && METADATA_KEYS.has(metadataMatch[1].toLowerCase())) {
      metadata[metadataMatch[1].toLowerCase()] = metadataMatch[2].trim();
      continue;
    }

    const tags = [...trimmed.matchAll(/\[([^\]]+)\]/g)];
    const times = tags
      .map(match => parseTimestampTag(match[1]))
      .filter(Number.isFinite);

    if (!times.length) {
      const untimedText = stripInlineTimestamps(trimmed).trim();
      if (untimedText && !/^\[[a-z]+\s*:/i.test(untimedText)) {
        parsedLines.push({ timeMs: null, text: untimedText, sequence: sequence++ });
      }
      continue;
    }

    const lyricText = stripInlineTimestamps(
      trimmed.replace(/\[[^\]]+\]/g, "")
    ).trim() || "♪";

    for (const timeMs of times) {
      parsedLines.push({
        timeMs: Math.max(0, Math.round(timeMs + offsetMs)),
        text: lyricText,
        sequence: sequence++
      });
    }
  }

  const synced = parsedLines.filter(line => Number.isFinite(line.timeMs));
  const unsynced = parsedLines.filter(line => !Number.isFinite(line.timeMs));

  synced.sort((left, right) => left.timeMs - right.timeMs || left.sequence - right.sequence);

  const lines = synced.length ? synced : unsynced;
  return {
    metadata,
    offsetMs,
    synced: synced.length > 0,
    lines: lines.map((line, index) => ({
      index,
      timeMs: line.timeMs,
      text: line.text
    }))
  };
}

function parseTimestampTag(value) {
  const normalized = String(value || "").trim().replace(",", ".");

  let match = normalized.match(/^(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?$/);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fraction = fractionToMilliseconds(match[3]);
    return (minutes * 60 + seconds) * 1000 + fraction;
  }

  match = normalized.match(/^(\d+):([0-5]?\d):([0-5]?\d)(?:[.:](\d{1,3}))?$/);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const fraction = fractionToMilliseconds(match[4]);
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + fraction;
  }

  return NaN;
}

function fractionToMilliseconds(value) {
  if (!value) return 0;
  const digits = String(value).slice(0, 3);
  if (digits.length === 1) return Number(digits) * 100;
  if (digits.length === 2) return Number(digits) * 10;
  return Number(digits);
}

function stripInlineTimestamps(value) {
  return String(value || "").replace(/<\d+(?::[0-5]?\d){1,2}(?:[.:]\d{1,3})?>/g, "");
}

export class LrcLyricsViewer {
  constructor(elements, options = {}) {
    this.elements = elements;
    this.onSeek = typeof options.onSeek === "function" ? options.onSeek : null;
    this.lines = [];
    this.synced = false;
    this.activeIndex = -1;
    this.loadGeneration = 0;
    this.sourceUrl = "";
  }

  async load(sourceUrl, label = "Synced lyrics") {
    this.clear({ keepVisible: true });
    const generation = ++this.loadGeneration;
    this.sourceUrl = String(sourceUrl || "").trim();
    if (!this.sourceUrl) throw new Error("No .lrc file was provided.");

    this.elements.loading.hidden = false;
    this.elements.loading.textContent = `Loading ${label}…`;
    this.elements.error.hidden = true;
    this.elements.lines.hidden = true;

    try {
      const resolvedUrl = new URL(this.sourceUrl, window.location.href).href;
      const response = await fetch(resolvedUrl, { mode: "cors", cache: "default" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (generation !== this.loadGeneration) return;
      this.loadText(text, label);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.showError(error);
      throw error;
    }
  }

  loadText(text, label = "Synced lyrics") {
    const parsed = parseLrc(text);
    this.lines = parsed.lines;
    this.synced = parsed.synced;
    this.activeIndex = -1;
    this.renderLines();

    const count = this.lines.length;
    this.elements.loading.hidden = true;
    this.elements.error.hidden = count > 0;
    this.elements.lines.hidden = count === 0;
    this.elements.status.textContent = this.synced ? "Synced .LRC" : "Untimed lyrics";
    this.elements.description.textContent = count
      ? `${label} · ${count} line${count === 1 ? "" : "s"}${parsed.offsetMs ? ` · ${parsed.offsetMs > 0 ? "+" : ""}${parsed.offsetMs} ms offset` : ""}`
      : `${label} does not contain displayable lyric lines.`;

    if (!count) {
      this.elements.error.hidden = false;
      this.elements.errorMessage.textContent = "The .lrc file did not contain recognized lyric lines.";
    }
  }

  renderLines() {
    const target = this.elements.lines;
    target.innerHTML = "";

    this.lines.forEach((line, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lyric-line";
      button.dataset.lyricIndex = String(index);
      button.disabled = !this.synced;
      button.setAttribute("aria-label", this.synced
        ? `Seek to ${formatLrcTime(line.timeMs)}: ${line.text}`
        : line.text);

      if (this.synced) {
        const time = document.createElement("span");
        time.className = "lyric-time";
        time.textContent = formatLrcTime(line.timeMs);
        button.appendChild(time);
      }

      const lyric = document.createElement("span");
      lyric.className = "lyric-text";
      lyric.textContent = line.text;
      button.appendChild(lyric);

      if (this.synced && this.onSeek) {
        button.addEventListener("click", () => this.onSeek(line.timeMs / 1000));
      }

      target.appendChild(button);
    });
  }

  setTime(seconds, options = {}) {
    if (!this.synced || !this.lines.length) return;
    const currentMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const nextIndex = findActiveLineIndex(this.lines, currentMs);
    if (nextIndex === this.activeIndex && !options.force) return;

    this.activeIndex = nextIndex;
    const buttons = this.elements.lines.querySelectorAll(".lyric-line");
    buttons.forEach(button => button.classList.remove("is-active", "is-secondary-active"));

    if (nextIndex < 0) {
      this.elements.nowPlaying.textContent = "Waiting for the first lyric line…";
      return;
    }

    const activeTime = this.lines[nextIndex].timeMs;
    let firstActive = null;
    let activeCount = 0;

    for (let index = nextIndex; index >= 0 && this.lines[index].timeMs === activeTime; index -= 1) {
      const button = buttons[index];
      if (!button) continue;
      button.classList.add(activeCount === 0 ? "is-active" : "is-secondary-active");
      firstActive = button;
      activeCount += 1;
    }
    for (let index = nextIndex + 1; index < this.lines.length && this.lines[index].timeMs === activeTime; index += 1) {
      const button = buttons[index];
      if (!button) continue;
      button.classList.add("is-secondary-active");
      activeCount += 1;
    }

    this.elements.nowPlaying.textContent = this.lines[nextIndex].text;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    firstActive?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }

  clear({ keepVisible = false } = {}) {
    this.loadGeneration += 1;
    this.lines = [];
    this.synced = false;
    this.activeIndex = -1;
    this.sourceUrl = "";
    this.elements.lines.innerHTML = "";
    this.elements.lines.hidden = true;
    this.elements.loading.hidden = true;
    this.elements.error.hidden = true;
    this.elements.errorMessage.textContent = "";
    this.elements.status.textContent = "No .LRC";
    this.elements.description.textContent = "Add a timestamped .lrc file to follow the lyrics with the recording.";
    this.elements.nowPlaying.textContent = "";
    if (!keepVisible) this.elements.section.hidden = true;
  }

  showError(error) {
    this.elements.loading.hidden = true;
    this.elements.lines.hidden = true;
    this.elements.error.hidden = false;
    this.elements.errorMessage.textContent = explainLrcError(error, this.sourceUrl);
    this.elements.status.textContent = "Could not load";
    this.elements.description.textContent = "The synced lyric file could not be opened.";
  }
}

function findActiveLineIndex(lines, currentMs) {
  let low = 0;
  let high = lines.length - 1;
  let answer = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].timeMs <= currentMs) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return answer;
}

function formatLrcTime(milliseconds) {
  const safe = Math.max(0, Math.round(Number(milliseconds) || 0));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const fraction = safe % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

function explainLrcError(error, sourceUrl) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/failed to fetch|cors|network/i.test(message)) {
    return "The .lrc file is on a server that does not allow the player to retrieve it. Store it in the same GitHub Pages repository as the app.";
  }
  if (/404|http 404/i.test(message)) return `The .lrc file was not found at ${sourceUrl}.`;
  return message || "The .lrc file could not be loaded.";
}
