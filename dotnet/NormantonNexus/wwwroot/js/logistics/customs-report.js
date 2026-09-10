// Monthly Customs Report tile — port of routes/customsreport.js (file
// upload -> file download) + routes/customsreportadmin.js (VAT overrides /
// HS descriptions CRUD).
(function () {
  const esc = NexusApi.esc;
  const adminApi = NexusApi.make("/api/customs-report-admin");

  // ── Generate (raw file upload, raw file download — not the usual JSON envelope) ──
  document.getElementById("cr-generate").addEventListener("click", async () => {
    const fileInput = document.getElementById("cr-file");
    const statusEl = document.getElementById("cr-status");
    if (!fileInput.files.length) {
      statusEl.innerHTML = '<span class="tf-inline-error">Choose a file first.</span>';
      return;
    }
    statusEl.innerHTML = '<span class="nx-toolbar-hint">Generating…</span>';
    try {
      const r = await fetch("/api/customsreport/generate", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: fileInput.files[0],
      });
      if (!r.ok) {
        const json = await r.json().catch(() => null);
        throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `customs-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      statusEl.innerHTML = '<span class="badge badge--success">Report downloaded</span>';
    } catch (err) {
      statusEl.innerHTML = `<span class="tf-inline-error">Error: ${esc(err.message)}</span>`;
    }
  });

  // ── VAT Overrides ──
  async function loadVatOverrides() {
    const el = document.getElementById("vo-body");
    el.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await adminApi("/vat-overrides");
      const rows = data || [];
      if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No VAT overrides configured.</div>'; return; }
      el.innerHTML = `
        <div class="nx-toolbar" style="margin-bottom:10px">
          <span class="nx-toolbar-title">${rows.length} override${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table>
          <thead><tr><th>Consignee</th><th>VAT Number</th><th>Notes</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.consigneeCode)}</td><td>${esc(r.vatNumber)}</td><td>${esc(r.notes)}</td><td><button type="button" class="secondary" data-id="${r.overrideId}" data-kind="vo" style="color:var(--error)">Delete</button></td></tr>`).join("")}</tbody>
        </table>`;
      el.querySelectorAll("button[data-kind='vo']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await adminApi(`/vat-overrides/${btn.dataset.id}`, { method: "DELETE" });
          await loadVatOverrides();
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  document.getElementById("vo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await adminApi("/vat-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consigneeCode: document.getElementById("vo-consignee").value.trim(),
        vatNumber: document.getElementById("vo-vat").value.trim(),
        notes: document.getElementById("vo-notes").value.trim() || null,
      }),
    });
    e.target.reset();
    await loadVatOverrides();
  });

  // ── HS Descriptions ──
  async function loadHsDescriptions() {
    const el = document.getElementById("hs-body");
    el.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await adminApi("/hs-descriptions");
      const rows = data || [];
      if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No HS descriptions configured.</div>'; return; }
      el.innerHTML = `
        <div class="nx-toolbar" style="margin-bottom:10px">
          <span class="nx-toolbar-title">${rows.length} description${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table>
          <thead><tr><th>Commodity Code</th><th>Description</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.commodityCode)}</td><td>${esc(r.description)}</td><td><button type="button" class="secondary" data-id="${r.hsCodeId}" data-kind="hs" style="color:var(--error)">Delete</button></td></tr>`).join("")}</tbody>
        </table>`;
      el.querySelectorAll("button[data-kind='hs']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await adminApi(`/hs-descriptions/${btn.dataset.id}`, { method: "DELETE" });
          await loadHsDescriptions();
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  document.getElementById("hs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await adminApi("/hs-descriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commodityCode: document.getElementById("hs-code").value.trim(),
        description: document.getElementById("hs-desc").value.trim(),
      }),
    });
    e.target.reset();
    await loadHsDescriptions();
  });

  loadVatOverrides();
  loadHsDescriptions();
})();
