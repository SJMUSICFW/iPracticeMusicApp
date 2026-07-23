/*
 * iPracticeMusic App 2.0 configuration
 *
 * The endpoint below is preserved from the existing iPracticeMusic player.
 * Change it only when you deploy a different Apps Script web app.
 */
window.IPRACTICE_CONFIG = Object.freeze({
  version: "2.0.9",
  defaultSkin: "classic-blue",
  configEndpoint:
    "https://script.google.com/macros/s/AKfycbx2IlK-0D4jaekRqFyTxQjp81FQ1ULVxi67JFyEE2lIYSosVnPgSvuliv_RI0uO-NkF/exec",

  /*
   * Embedded multi-step administration widget. This is a browser-based
   * prototype gate; connect it to server-side authentication before using it
   * for protected production administration.
   */
  adminWizard: {
    enabled: true,
    demoEmail: "rkochel@stjudefw.org",
    demoPassword: "practice",
    storageKey: "ipracticeMusic.adminWizard.v2",
    skins: [
      "classic-blue",
      "art-deco-navy",
      "cathedral-gold",
      "forest-green",
      "midnight-dark"
    ]
  },

  /*
   * PDF.js renders the pages into a canvas instead of relying on the browser's
   * built-in PDF plug-in. The second location is an automatic fallback.
   */
  pdfJsModuleUrls: [
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.min.mjs",
    "https://unpkg.com/pdfjs-dist@6.1.200/build/pdf.min.mjs"
  ],
  pdfJsWorkerUrls: [
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs",
    "https://unpkg.com/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs"
  ],

  fallbackSongs: [],

  /* Open index.html?demo=1 to preview Version 2.0 without Apps Script. */
  demoSongs: []
});
