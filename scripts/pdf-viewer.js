const DEFAULT_SCALE = 1.25;
const MIN_SCALE = 0.55;
const MAX_SCALE = 3;
const SCALE_STEP = 0.15;

export class PdfCanvasViewer {
  constructor(elements, options = {}) {
    this.elements = elements;
    this.moduleUrls = Array.isArray(options.moduleUrls) ? options.moduleUrls : [];
    this.workerUrls = Array.isArray(options.workerUrls) ? options.workerUrls : [];
    this.pdfjs = null;
    this.loadingTask = null;
    this.document = null;
    this.sourceUrl = "";
    this.pageNumber = 1;
    this.scale = DEFAULT_SCALE;
    this.rotation = 0;
    this.fitWidth = true;
    this.rendering = false;
    this.pendingRender = false;
    this.renderTask = null;
    this.resizeTimer = null;

    this.bindControls();
  }

  bindControls() {
    const e = this.elements;
    e.previousButton.addEventListener("click", () => this.goToPage(this.pageNumber - 1));
    e.nextButton.addEventListener("click", () => this.goToPage(this.pageNumber + 1));
    e.pageInput.addEventListener("change", () => this.goToPage(Number(e.pageInput.value)));
    e.pageInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.goToPage(Number(e.pageInput.value));
      }
    });
    e.zoomOutButton.addEventListener("click", () => this.changeScale(-SCALE_STEP));
    e.zoomInButton.addEventListener("click", () => this.changeScale(SCALE_STEP));
    e.fitButton.addEventListener("click", () => {
      this.fitWidth = true;
      this.queueRender();
    });
    e.rotateButton.addEventListener("click", () => {
      this.rotation = (this.rotation + 90) % 360;
      this.queueRender();
    });
    e.fullscreenButton.addEventListener("click", () => this.toggleFullscreen());

    window.addEventListener("resize", () => {
      if (!this.document || !this.fitWidth) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.queueRender(), 160);
    });

    document.addEventListener("fullscreenchange", () => this.updateFullscreenLabel());
  }

  async load(sourceUrl, label = "Sheet music") {
    await this.destroyDocument();
    this.sourceUrl = String(sourceUrl || "").trim();
    this.pageNumber = 1;
    this.scale = DEFAULT_SCALE;
    this.rotation = 0;
    this.fitWidth = true;
    this.resetUi();

    if (!this.sourceUrl) {
      throw new Error("No PDF URL was provided.");
    }

    try {
      const pdfjs = await this.loadLibrary();
      const loadingOptions = {
        url: new URL(this.sourceUrl, window.location.href).href,
        cMapPacked: true,
        enableXfa: true
      };

      this.loadingTask = pdfjs.getDocument(loadingOptions);
      this.loadingTask.onProgress = progress => {
        if (!progress || !Number.isFinite(progress.total) || progress.total <= 0) return;
        const percent = Math.round((progress.loaded / progress.total) * 100);
        this.elements.loading.textContent = `Loading ${label}… ${percent}%`;
      };

      this.document = await this.loadingTask.promise;
      this.elements.pageCount.textContent = String(this.document.numPages);
      this.elements.pageInput.max = String(this.document.numPages);
      this.elements.loading.hidden = true;
      this.elements.canvas.hidden = false;
      await this.renderPage();
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async loadLibrary() {
    if (this.pdfjs) return this.pdfjs;
    let lastError = null;

    for (let index = 0; index < this.moduleUrls.length; index += 1) {
      try {
        const moduleUrl = this.moduleUrls[index];
        const pdfjs = await import(moduleUrl);
        const workerUrl = this.workerUrls[index] || this.workerUrls[0];
        if (workerUrl) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        this.pdfjs = pdfjs;
        return pdfjs;
      } catch (error) {
        lastError = error;
        console.warn("PDF.js source failed:", this.moduleUrls[index], error);
      }
    }

    throw new Error(
      `The PDF renderer could not load. ${lastError?.message || "Check the internet connection and content-blocking settings."}`
    );
  }

  async renderPage() {
    if (!this.document || this.rendering) {
      this.pendingRender = true;
      return;
    }

    this.rendering = true;
    this.pendingRender = false;

    try {
      if (this.renderTask) {
        try { this.renderTask.cancel(); } catch (_) {}
        this.renderTask = null;
      }

      const page = await this.document.getPage(this.pageNumber);
      let renderScale = this.scale;
      const unscaled = page.getViewport({ scale: 1, rotation: this.rotation });

      if (this.fitWidth) {
        const availableWidth = Math.max(240, this.elements.canvasStage.clientWidth - 32);
        renderScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, availableWidth / unscaled.width));
        this.scale = renderScale;
      }

      const viewport = page.getViewport({ scale: renderScale, rotation: this.rotation });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = this.elements.canvas;
      const context = canvas.getContext("2d", { alpha: false });

      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      this.renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        background: "rgb(255,255,255)"
      });
      await this.renderTask.promise;
      this.renderTask = null;

      this.elements.pageInput.value = String(this.pageNumber);
      this.elements.zoomOutput.value = `${Math.round(this.scale * 100)}%`;
      this.elements.previousButton.disabled = this.pageNumber <= 1;
      this.elements.nextButton.disabled = this.pageNumber >= this.document.numPages;
      this.elements.canvasStage.scrollTo({ top: 0, left: 0, behavior: "instant" });
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") this.showError(error);
    } finally {
      this.rendering = false;
      if (this.pendingRender) this.renderPage();
    }
  }

  queueRender() {
    if (!this.document) return;
    if (this.rendering) {
      this.pendingRender = true;
      return;
    }
    this.renderPage();
  }

  goToPage(pageNumber) {
    if (!this.document) return;
    const safePage = Math.min(this.document.numPages, Math.max(1, Math.round(Number(pageNumber) || 1)));
    this.pageNumber = safePage;
    this.queueRender();
  }

  changeScale(delta) {
    this.fitWidth = false;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale + delta));
    this.queueRender();
  }

  async toggleFullscreen() {
    const container = this.elements.container;
    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen();
      } else if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else {
        container.classList.toggle("pdf-fullscreen-fallback");
        document.body.classList.toggle("modal-open", container.classList.contains("pdf-fullscreen-fallback"));
        this.updateFullscreenLabel();
        this.queueRender();
      }
    } catch (_) {
      container.classList.toggle("pdf-fullscreen-fallback");
      document.body.classList.toggle("modal-open", container.classList.contains("pdf-fullscreen-fallback"));
      this.updateFullscreenLabel();
      this.queueRender();
    }
  }

  updateFullscreenLabel() {
    const isOpen = document.fullscreenElement === this.elements.container ||
      this.elements.container.classList.contains("pdf-fullscreen-fallback");
    this.elements.fullscreenButton.textContent = isOpen ? "× Close" : "⛶ Enlarge";
  }

  resetUi() {
    this.elements.loading.hidden = false;
    this.elements.loading.textContent = "Loading sheet music…";
    this.elements.canvas.hidden = true;
    this.elements.error.hidden = true;
    this.elements.errorMessage.textContent = "";
    this.elements.pageCount.textContent = "—";
    this.elements.pageInput.value = "1";
    this.elements.zoomOutput.value = "100%";
  }

  showError(error) {
    const message = explainPdfError(error, this.sourceUrl);
    this.elements.loading.hidden = true;
    this.elements.canvas.hidden = true;
    this.elements.error.hidden = false;
    this.elements.errorMessage.textContent = message;
  }

  async destroyDocument() {
    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch (_) {}
      this.renderTask = null;
    }
    if (this.loadingTask) {
      try { await this.loadingTask.destroy(); } catch (_) {}
      this.loadingTask = null;
    }
    this.document = null;
  }
}

function explainPdfError(error, sourceUrl) {
  const message = String(error?.message || error || "Unknown PDF error");
  if (/cors|cross-origin|failed to fetch|networkerror|unexpected server response/i.test(message)) {
    return "The PDF host did not allow the app to retrieve this file. Upload the PDF to the same GitHub Pages repository as the player and use a relative path such as pdf/song-title.pdf.";
  }
  if (/missing pdf|404|not found/i.test(message)) {
    return `The PDF was not found at ${sourceUrl}. Check the filename, capitalization, and folder path.`;
  }
  if (/password/i.test(message)) return "This PDF is password protected and cannot be displayed inside the player.";
  if (/renderer could not load|dynamically imported module/i.test(message)) {
    return "The PDF rendering library was blocked or could not load. Check Brave Shields or the internet connection, then use Open original as a fallback.";
  }
  return message;
}
