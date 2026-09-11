// Shared label-print widget — server-side raw-TCP direct-to-printer send
// (POST /api/labels/process/{code}/{id}/print), completing the label-
// printing entry-form integration that Mixing/Metre-process entry forms
// only had the browser-preview half of (the "Print Labels" link that opens
// /api/labels/process/{code}/{id} in a new tab, which stays as-is — this
// widget is additive, not a replacement).
window.ProductionLabels = (function () {
  const api = NexusApi.make("/api/labels");

  // Mounts a printer picker + Send to Printer button into containerEl.
  // opts: { processCode, recordId, tubs: [tubSeq,...] | null }. When tubs
  // is a non-empty array (Mixing only), one "Send" button per tub plus a
  // "Send All" button is rendered; otherwise a single button with no tub.
  async function mount(containerEl, opts) {
    const esc = NexusApi.esc;
    containerEl.innerHTML = `<div class="nx-empty">Loading printers…</div>`;
    let printers = [];
    let userDefault = null;
    try {
      const { data } = await api("/printers");
      printers = data.printers || [];
      userDefault = data.userDefault || null;
    } catch (err) {
      containerEl.innerHTML = `<div class="nx-empty">Could not load printers: ${esc(err.message)}</div>`;
      return;
    }

    if (printers.length === 0) {
      containerEl.innerHTML = `<div class="nx-empty">No printers configured.</div>`;
      return;
    }

    const selectId = `lp-printer-${Math.random().toString(36).slice(2, 8)}`;
    const tubs = opts.tubs && opts.tubs.length > 0 ? opts.tubs : null;

    containerEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;">
        <label class="tf-label" for="${selectId}" style="margin:0;">Printer</label>
        <select id="${selectId}" class="tf-input" style="flex:0 0 auto; width:auto;">
          ${printers.map((p) => `<option value="${esc(p.id)}" ${p.id === userDefault ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <label style="margin:0; font-size:0.8rem; font-weight:400;"><input type="checkbox" id="${selectId}-default"> Set as my default</label>
        ${tubs ? tubs.map((t) => `<button type="button" class="secondary" data-tub="${t}">Send Tub ${t}</button>`).join("") + '<button type="button" class="secondary" data-tub="">Send All</button>'
          : '<button type="button" class="secondary" data-tub="">Send to Printer</button>'}
        <span id="${selectId}-status"></span>
      </div>`;

    const select = document.getElementById(selectId);
    const statusEl = document.getElementById(`${selectId}-status`);

    containerEl.querySelectorAll("button[data-tub]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const printerId = select.value;
        const tubVal = btn.dataset.tub ? Number(btn.dataset.tub) : null;
        btn.disabled = true;
        statusEl.innerHTML = `<span class="badge">Sending…</span>`;
        try {
          if (document.getElementById(`${selectId}-default`).checked) {
            await api("/printers/default", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printerId }) });
          }
          const { data } = await api(`/process/${opts.processCode}/${opts.recordId}/print`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printerId, tub: tubVal }),
          });
          statusEl.innerHTML = `<span class="badge badge--success">${esc(data.message || "Sent.")}</span>`;
        } catch (err) {
          statusEl.innerHTML = `<span class="badge badge--error">Error: ${esc(err.message)}</span>`;
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  return { mount };
})();
