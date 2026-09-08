// Shared modal shell — C# port of the Node app's two overlay patterns,
// unified into one component:
//   - .ps-modal (private/css/logistics.css:694-963) — the generic
//     "put a form/detail view in a popup" shell, opened via openModal()/
//     closePickModal() (logistics.js:2345).
//   - .wc-overlay/.wc-modal (private/css/nexus-common.css:219-231) — the
//     narrower confirm/alert replacement for native confirm()/alert(),
//     used across 4 Node files (the more broadly-reused of the two dialog
//     styles there).
// This app didn't have either — every page used native confirm()/alert()
// instead. One shell serves both jobs here (a plain content popup, and a
// confirm/alert dialog built from the same markup), since duplicating two
// nearly-identical overlay implementations the way Node does isn't worth it
// for a fresh build.
//
// Usage:
//   NexusModal.open('<div class="ps-modal-header">...</div><div class="ps-modal-body">...</div>');
//   NexusModal.close();
//   const ok = await NexusModal.confirm('Delete this row?', { title: 'Confirm', danger: true });
//   await NexusModal.alert('Saved.');
(function () {
  const esc = window.NexusApi ? window.NexusApi.esc : (s) => String(s ?? "");

  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.className = "ps-modal-overlay hidden";
    overlayEl.innerHTML = '<div class="ps-modal" id="ps-modal-content"></div>';
    document.body.appendChild(overlayEl);
    // Clicking the backdrop (not the card itself) closes the modal —
    // matches Node's own openModal() behavior.
    overlayEl.addEventListener("click", (e) => {
      if (e.target === overlayEl) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlayEl.classList.contains("hidden")) close();
    });
    return overlayEl;
  }

  function open(html, { wide = false } = {}) {
    const overlay = ensureOverlay();
    const card = overlay.querySelector("#ps-modal-content");
    card.className = "ps-modal" + (wide ? " ps-modal--wide" : "");
    card.innerHTML = html;
    overlay.classList.remove("hidden");
    return card;
  }

  function close() {
    if (!overlayEl) return;
    overlayEl.classList.add("hidden");
    overlayEl.querySelector("#ps-modal-content").innerHTML = "";
  }

  function confirm(message, { title = "Confirm", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
    return new Promise((resolve) => {
      const card = open(`
        <div class="ps-modal-header">
          <div class="ps-modal-title">${esc(title)}</div>
          <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="ps-modal-body"><p>${esc(message)}</p></div>
        <div class="ps-modal-actions">
          <button type="button" class="secondary" id="ps-modal-cancel">${esc(cancelLabel)}</button>
          <button type="button" id="ps-modal-confirm" style="${danger ? "background:var(--error)" : ""}">${esc(confirmLabel)}</button>
        </div>`);

      const finish = (result) => { close(); resolve(result); };
      card.querySelector(".ps-modal-close").addEventListener("click", () => finish(false));
      card.querySelector("#ps-modal-cancel").addEventListener("click", () => finish(false));
      card.querySelector("#ps-modal-confirm").addEventListener("click", () => finish(true));
    });
  }

  function alert(message, { title = "Notice" } = {}) {
    return new Promise((resolve) => {
      const card = open(`
        <div class="ps-modal-header">
          <div class="ps-modal-title">${esc(title)}</div>
          <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="ps-modal-body"><p>${esc(message)}</p></div>
        <div class="ps-modal-actions">
          <button type="button" id="ps-modal-ok">OK</button>
        </div>`);

      const finish = () => { close(); resolve(); };
      card.querySelector(".ps-modal-close").addEventListener("click", finish);
      card.querySelector("#ps-modal-ok").addEventListener("click", finish);
    });
  }

  window.NexusModal = { open, close, confirm, alert };
})();
