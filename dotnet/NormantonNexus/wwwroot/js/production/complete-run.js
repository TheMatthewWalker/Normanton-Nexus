// Complete Run — the draft->complete two-step wizard for the metre
// processes (EX/CO/BR/CL/TW). Port of the "Draft"/"Complete" halves of
// runMeterProcessEntry's draft flow in production-nexus.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const processCode = document.querySelector("[data-process-code]").dataset.processCode;

  function shiftFromHour() {
    const h = new Date().getHours();
    if (h >= 6 && h < 14) return 1;
    if (h >= 14 && h < 22) return 2;
    return 3;
  }
  document.getElementById("cr-shift").value = String(shiftFromHour());

  // ── Open Drafts ─────────────────────────────────────────────────
  async function loadOpenEntries() {
    const el = document.getElementById("cr-open-entries");
    el.textContent = "Loading…";
    try {
      const { data } = await api(`/process/${processCode}/open-entries`);
      const rows = data || [];
      el.innerHTML = rows.length === 0 ? "<p>No open drafts.</p>" : `
        <table>
          <thead><tr><th>Batch Ref</th><th>Material</th><th>Machine</th><th>Notes</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.batchRef)}</td><td>${esc(r.material)}</td><td>${esc(r.machineName || r.machineCode)}</td>
                <td>${esc(r.notes)}</td><td>${new Date(r.createdAt).toLocaleString("en-GB")}</td>
                <td><button type="button" class="secondary" data-select="${r.recordId}" data-ref="${esc(r.batchRef)}">Complete</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-select]").forEach((btn) => {
        btn.addEventListener("click", () => selectDraft(Number(btn.dataset.select), btn.dataset.ref));
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  // ── Parent batch / raw material rows ────────────────────────────
  function addParentRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <input type="text" placeholder="Process Code (e.g. MX)" class="cr-parent-pc" style="max-width:140px;">
      <input type="number" placeholder="Record ID" class="cr-parent-rid" style="max-width:120px;">
      <input type="number" placeholder="Tub ID (optional)" class="cr-parent-tub" style="max-width:120px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("cr-parent-list").appendChild(row);
  }
  document.getElementById("cr-add-parent").addEventListener("click", addParentRow);

  function addRawMatRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <input type="text" placeholder="Material" class="cr-rawmat-material" style="max-width:160px;">
      <input type="text" placeholder="Batch Number" class="cr-rawmat-batch" style="max-width:160px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("cr-rawmat-list").appendChild(row);
  }
  document.getElementById("cr-add-rawmat").addEventListener("click", addRawMatRow);

  function collectParentBatches() {
    return Array.from(document.querySelectorAll("#cr-parent-list > div")).map((row) => ({
      processCode: row.querySelector(".cr-parent-pc").value.trim() || null,
      recordId: row.querySelector(".cr-parent-rid").value ? Number(row.querySelector(".cr-parent-rid").value) : null,
      tubId: row.querySelector(".cr-parent-tub").value ? Number(row.querySelector(".cr-parent-tub").value) : null,
    })).filter((p) => p.processCode && p.recordId);
  }

  function collectRawMaterialBatches() {
    return Array.from(document.querySelectorAll("#cr-rawmat-list > div")).map((row) => ({
      material: row.querySelector(".cr-rawmat-material").value.trim() || null,
      batchNumber: row.querySelector(".cr-rawmat-batch").value.trim() || null,
    })).filter((r) => r.material || r.batchNumber);
  }

  // ── Draft creation ──────────────────────────────────────────────
  document.getElementById("cr-draft-submit").addEventListener("click", async () => {
    const resultEl = document.getElementById("cr-draft-result");
    const material = document.getElementById("cr-material").value.trim();
    if (!material) { resultEl.textContent = "Material is required."; resultEl.style.color = "#b91c1c"; return; }
    resultEl.textContent = "Creating draft…";
    resultEl.style.color = "#6b7280";
    try {
      const { data } = await api(`/process/${processCode}/draft`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material,
          machineId: document.getElementById("cr-machine").value ? Number(document.getElementById("cr-machine").value) : null,
          parentBatches: collectParentBatches(),
          rawMaterialBatches: collectRawMaterialBatches(),
          notes: document.getElementById("cr-draft-notes").value.trim() || null,
        }),
      });
      resultEl.textContent = `✓ Draft ${data.batchRef} created.` + (data.warnings && data.warnings.length ? ` Warnings: ${data.warnings.join("; ")}` : "");
      resultEl.style.color = "#059669";
      await loadOpenEntries();
      selectDraft(data.recordId, data.batchRef);
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      resultEl.style.color = "#b91c1c";
    }
  });

  // ── Scrap rows ───────────────────────────────────────────────────
  let scrapReasons = [];
  async function loadScrapReasons() {
    try {
      const { data } = await api(`/scrap-reasons?pc=${processCode}`);
      scrapReasons = data || [];
    } catch { /* best-effort */ }
  }

  function addScrapRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.25rem;";
    row.innerHTML = `
      <select class="cr-scrap-reason">${scrapReasons.map((r) => `<option value="${r.reasonId}">${esc(r.reasonDescription)}</option>`).join("")}</select>
      <input type="number" placeholder="KG" class="cr-scrap-kg" step="0.001" style="max-width:100px;">
      <input type="number" placeholder="Occurrences" class="cr-scrap-occ" style="max-width:120px;">
      <button type="button" class="secondary" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
    document.getElementById("cr-scrap-list").appendChild(row);
  }
  document.getElementById("cr-add-scrap").addEventListener("click", addScrapRow);

  function collectScrapReasons() {
    return Array.from(document.querySelectorAll("#cr-scrap-list > div")).map((row) => ({
      reasonId: Number(row.querySelector(".cr-scrap-reason").value),
      kg: row.querySelector(".cr-scrap-kg").value ? Number(row.querySelector(".cr-scrap-kg").value) : null,
      occurrences: row.querySelector(".cr-scrap-occ").value ? Number(row.querySelector(".cr-scrap-occ").value) : null,
    }));
  }

  // ── Complete step ────────────────────────────────────────────────
  let selectedRecordId = null;

  function selectDraft(recordId, batchRef) {
    selectedRecordId = recordId;
    document.getElementById("cr-complete-ref").textContent = `(${batchRef})`;
    document.getElementById("cr-complete-section").style.display = "";
    document.getElementById("cr-complete-section").scrollIntoView({ behavior: "smooth" });
  }

  document.getElementById("cr-complete-submit").addEventListener("click", async () => {
    if (!selectedRecordId) return;
    const resultEl = document.getElementById("cr-complete-result");
    const lengthMetres = Number(document.getElementById("cr-length").value);
    if (!(lengthMetres > 0)) { resultEl.textContent = "Length (Metres) must be greater than 0."; resultEl.style.color = "#b91c1c"; return; }

    const operatorIds = document.getElementById("cr-operators").value.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
    const hasScrap = document.getElementById("cr-has-scrap").checked;

    resultEl.textContent = "Posting to SAP…";
    resultEl.style.color = "#6b7280";
    try {
      const { data } = await api(`/process/${processCode}/complete/${selectedRecordId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lengthMetres,
          shiftId: Number(document.getElementById("cr-shift").value),
          additionalOperatorIds: operatorIds,
          hasScrap,
          scrapTotalKg: hasScrap && document.getElementById("cr-scrap-total").value ? Number(document.getElementById("cr-scrap-total").value) : null,
          scrapReasons: hasScrap ? collectScrapReasons() : [],
          notes: document.getElementById("cr-complete-notes").value.trim() || null,
        }),
      });
      if (data.status === "SAP_FAILED") {
        resultEl.textContent = `⚠ ${data.batchRef} saved but SAP posting failed: ${data.error}. See Failed Backflush queue for supervisor retry.`;
        resultEl.style.color = "#d97706";
      } else {
        resultEl.textContent = `✓ ${data.batchRef} completed — MatDoc: ${data.materialDocument}${data.warning ? ` (${data.warning})` : ""}`;
        resultEl.style.color = "#059669";
      }
      window.ProductionLabels.mount(document.getElementById("cr-print-widget"), { processCode, recordId: selectedRecordId, tubs: null });
      await loadOpenEntries();
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes("block")) {
        resultEl.textContent = "Blocked: " + err.message;
      } else {
        resultEl.textContent = "Error: " + err.message;
      }
      resultEl.style.color = "#b91c1c";
    }
  });

  addParentRow();
  addRawMatRow();
  loadScrapReasons().then(addScrapRow);
  loadOpenEntries();
})();
