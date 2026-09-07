// Shared fetch/escape helpers — introduced during Phase 10's frontend
// catch-up (Warehouse/Logistics/Admin/Management, ~50+ new pages) purely for
// authoring velocity at that volume; every earlier department's JS
// duplicated this same small api()/esc() boilerplate per file instead. Not
// a framework — still one tiny IIFE-free set of globals, no shared
// component/rendering library, matching this app's established
// "no shared modal component exists yet anywhere in this port" precedent.
// Loaded via a <script> tag before each page's own script (see _Layout.cshtml
// for where session-guard.js gets the same treatment).
window.NexusApi = {
  // XSS-safe escape for template-literal innerHTML rendering.
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  // Returns an api(path, opts) function scoped to basePath (e.g. "/api/warehouse").
  make(basePath) {
    return async function api(path, opts) {
      const r = await fetch(basePath + path, opts);
      let json = null;
      try { json = await r.json(); } catch { /* non-JSON body */ }
      if (json?.success === false || !r.ok) {
        throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
      }
      return json;
    };
  },
};
