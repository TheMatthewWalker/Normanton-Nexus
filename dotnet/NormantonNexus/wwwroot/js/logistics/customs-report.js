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
      statusEl.textContent = "Choose a file first.";
      return;
    }
    statusEl.textContent = "Generating…";
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
      statusEl.textContent = "Report downloaded.";
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });

  // ── VAT Overrides ──
  async function loadVatOverrides() {
    const el = document.getElementById("vo-body");
    try {
      const { data } = await adminApi("/vat-overrides");
      el.innerHTML = (data || []).length === 0 ? "<p>None.</p>" : `
        <table>
          <thead><tr><th>Consignee</th><th>VAT Number</th><th>Notes</th><th></th></tr></thead>
          <tbody>${data.map((r) => `<tr><td>${esc(r.consigneeCode)}</td><td>${esc(r.vatNumber)}</td><td>${esc(r.notes)}</td><td><button type="button" class="btn secondary" data-id="${r.overrideId}" data-kind="vo">Delete</button></td></tr>`).join("")}</tbody>
        </table>`;
      el.querySelectorAll("button[data-kind='vo']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await adminApi(`/vat-overrides/${btn.dataset.id}`, { method: "DELETE" });
          await loadVatOverrides();
        });
      });
    } catch (err) {
      el.textContent = "Error: " + err.message;
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
    try {
      const { data } = await adminApi("/hs-descriptions");
      el.innerHTML = (data || []).length === 0 ? "<p>None.</p>" : `
        <table>
          <thead><tr><th>Commodity Code</th><th>Description</th><th></th></tr></thead>
          <tbody>${data.map((r) => `<tr><td>${esc(r.commodityCode)}</td><td>${esc(r.description)}</td><td><button type="button" class="btn secondary" data-id="${r.hsCodeId}" data-kind="hs">Delete</button></td></tr>`).join("")}</tbody>
        </table>`;
      el.querySelectorAll("button[data-kind='hs']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await adminApi(`/hs-descriptions/${btn.dataset.id}`, { method: "DELETE" });
          await loadHsDescriptions();
        });
      });
    } catch (err) {
      el.textContent = "Error: " + err.message;
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
