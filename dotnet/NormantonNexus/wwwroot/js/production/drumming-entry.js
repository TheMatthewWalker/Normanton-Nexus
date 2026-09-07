// Drumming entry — port of Node's Drumming wizard, simplified to one form
// per type (Make-to-Stock / Make-to-Order) rather than Node's phased
// wizard steps. See DrummingEntry.cshtml.cs's own doc comment.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const packagingApi = NexusApi.make("/api");

  function shiftFromHour() {
    const h = new Date().getHours();
    if (h >= 6 && h < 14) return 1;
    if (h >= 14 && h < 22) return 2;
    return 3;
  }
  document.getElementById("dw-shift").value = String(shiftFromHour());

  document.getElementById("dw-type").addEventListener("change", (e) => {
    document.getElementById("dw-customer-fields").style.display = e.target.value === "customer" ? "" : "none";
  });

  async function loadPackaging() {
    const sel = document.getElementById("dw-packaging");
    try {
      const { data } = await packagingApi("/packagingdata");
      sel.innerHTML = '<option value="">—</option>' + (data || []).map((p) => `<option value="${esc(p.packId)}">${esc(p.packId)} — ${esc(p.packDescription)}</option>`).join("");
    } catch {
      sel.innerHTML = '<option value="">Could not load packaging data</option>';
    }
  }

  // ── Parent batch / raw material rows (same shape as Complete Run) ──
  function addParentRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <input type="text" placeholder="Process Code (e.g. MX)" class="dw-parent-pc" style="max-width:140px;">
      <input type="number" placeholder="Record ID" class="dw-parent-rid" style="max-width:120px;">
      <input type="number" placeholder="Tub ID (optional)" class="dw-parent-tub" style="max-width:120px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("dw-parent-list").appendChild(row);
  }
  document.getElementById("dw-add-parent").addEventListener("click", addParentRow);

  function addRawMatRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <input type="text" placeholder="Material" class="dw-rawmat-material" style="max-width:160px;">
      <input type="text" placeholder="Batch Number" class="dw-rawmat-batch" style="max-width:160px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("dw-rawmat-list").appendChild(row);
  }
  document.getElementById("dw-add-rawmat").addEventListener("click", addRawMatRow);

  function addCoilRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <input type="number" placeholder="Length (m)" class="dw-coil-length" step="0.001" style="max-width:140px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("dw-coil-list").appendChild(row);
  }
  document.getElementById("dw-add-coil").addEventListener("click", addCoilRow);

  let scrapReasons = [];
  async function loadScrapReasons() {
    try {
      const { data } = await api("/scrap-reasons?pc=DR");
      scrapReasons = data || [];
    } catch { /* best-effort */ }
  }

  function addScrapRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <select class="dw-scrap-reason">${scrapReasons.map((r) => `<option value="${r.reasonId}">${esc(r.reasonDescription)}</option>`).join("")}</select>
      <input type="number" placeholder="KG" class="dw-scrap-kg" step="0.001" style="max-width:100px;">
      <input type="number" placeholder="Occurrences" class="dw-scrap-occ" style="max-width:120px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("dw-scrap-list").appendChild(row);
  }
  document.getElementById("dw-add-scrap").addEventListener("click", addScrapRow);

  function collectParentBatches() {
    return Array.from(document.querySelectorAll("#dw-parent-list > div")).map((row) => ({
      processCode: row.querySelector(".dw-parent-pc").value.trim() || null,
      recordId: row.querySelector(".dw-parent-rid").value ? Number(row.querySelector(".dw-parent-rid").value) : null,
      tubId: row.querySelector(".dw-parent-tub").value ? Number(row.querySelector(".dw-parent-tub").value) : null,
    })).filter((p) => p.processCode && p.recordId);
  }

  function collectRawMaterialBatches() {
    return Array.from(document.querySelectorAll("#dw-rawmat-list > div")).map((row) => ({
      material: row.querySelector(".dw-rawmat-material").value.trim() || null,
      batchNumber: row.querySelector(".dw-rawmat-batch").value.trim() || null,
    })).filter((r) => r.material || r.batchNumber);
  }

  function collectCoilLengths() {
    return Array.from(document.querySelectorAll("#dw-coil-list .dw-coil-length"))
      .map((i) => Number(i.value)).filter((v) => v > 0);
  }

  function collectScrapReasons() {
    return Array.from(document.querySelectorAll("#dw-scrap-list > div")).map((row) => ({
      reasonId: Number(row.querySelector(".dw-scrap-reason").value),
      kg: row.querySelector(".dw-scrap-kg").value ? Number(row.querySelector(".dw-scrap-kg").value) : null,
      occurrences: row.querySelector(".dw-scrap-occ").value ? Number(row.querySelector(".dw-scrap-occ").value) : null,
    }));
  }

  document.getElementById("dw-submit-btn").addEventListener("click", async () => {
    const resultEl = document.getElementById("dw-result");
    const type = document.getElementById("dw-type").value;
    const material = document.getElementById("dw-material").value.trim();
    if (!material) { resultEl.textContent = "Material is required."; resultEl.style.color = "#b91c1c"; return; }

    const hasScrap = document.getElementById("dw-has-scrap").checked;
    const body = {
      material,
      shiftId: Number(document.getElementById("dw-shift").value),
      customerNumber: type === "customer" ? (document.getElementById("dw-customer").value.trim() || null) : null,
      orderNumber: type === "customer" ? (document.getElementById("dw-order").value.trim() || null) : null,
      orderItem: type === "customer" ? (document.getElementById("dw-order-item").value.trim() || null) : null,
      packagingId: document.getElementById("dw-packaging").value || null,
      weightKg: document.getElementById("dw-weight").value ? Number(document.getElementById("dw-weight").value) : null,
      parentBatches: collectParentBatches(),
      rawMaterialBatches: collectRawMaterialBatches(),
      coilLengths: collectCoilLengths(),
      hasScrap,
      scrapTotalKg: hasScrap && document.getElementById("dw-scrap-total").value ? Number(document.getElementById("dw-scrap-total").value) : null,
      scrapReasons: hasScrap ? collectScrapReasons() : [],
      comments: document.getElementById("dw-comments").value.trim() || null,
    };

    resultEl.textContent = "Posting to SAP…";
    resultEl.style.color = "#6b7280";
    try {
      const { data } = await api(`/drumming/${type}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (data.status === "SAP_FAILED") {
        resultEl.textContent = `⚠ ${data.batchRef} saved but SAP posting failed: ${data.error}. See Failed Backflush queue for supervisor retry.`;
        resultEl.style.color = "#d97706";
      } else {
        resultEl.textContent = `✓ ${data.batchRef} posted — MatDoc: ${data.materialDocument || "—"}${data.warning ? ` (${data.warning})` : ""}${data.bomMismatch ? " — BOM mismatch flagged" : ""}`;
        resultEl.style.color = "#059669";
      }
      window.ProductionLabels.mount(document.getElementById("dw-print-widget"), { processCode: "DR", recordId: data.drummingId, tubs: null });
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      resultEl.style.color = "#b91c1c";
    }
  });

  loadPackaging();
  addParentRow();
  addRawMatRow();
  addCoilRow();
  loadScrapReasons().then(addScrapRow);
})();
