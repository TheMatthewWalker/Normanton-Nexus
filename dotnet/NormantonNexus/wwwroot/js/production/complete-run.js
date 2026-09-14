// Complete Run — the draft->complete two-step wizard for the metre
// processes (EX/CO/BR/CL/TW). Port of the "Draft"/"Complete" halves of
// runMeterProcessEntry's draft flow in production-nexus.js.
//
// Presented as a 3-step BRANCHING wizard (Open Drafts / New Draft /
// Complete Run) — deliberately plain active/enabled/disabled tab styling
// (no checkmarks, unlike Drumming's linear stepper) since this flow
// genuinely branches: an operator can jump straight from an existing open
// draft to Complete Run, or go via New Draft first. Retains Raw Material
// Batches (unlike Drumming) — real raw-material traceability applies to
// these metre processes.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const processCode = document.querySelector("[data-process-code]").dataset.processCode;

  const STEPS = ["Open Drafts", "New Draft", "Complete Run"];
  let step = 0;
  let completeUnlocked = false;
  let cameFromStep = 0;

  function shiftFromHour() {
    const h = new Date().getHours();
    if (h >= 6 && h < 14) return 1;
    if (h >= 14 && h < 22) return 2;
    return 3;
  }
  document.getElementById("cr-shift").value = String(shiftFromHour());

  // ── Stepper controller (branching — no checkmarks) ──
  function renderStepper() {
    const stepperEl = document.getElementById("cr-stepper");
    stepperEl.innerHTML = "";
    STEPS.forEach((label, i) => {
      if (i > 0) {
        const connector = document.createElement("span");
        connector.className = "step-connector";
        stepperEl.appendChild(connector);
      }
      const disabled = i === 2 && !completeUnlocked;
      const active = i === step;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "step-tab" + (active ? " is-active" : "") + (disabled ? " is-disabled" : "");
      tab.disabled = disabled;
      tab.innerHTML = `<span class="step-circle">${i + 1}</span><span class="step-label">${esc(label)}</span>`;
      tab.addEventListener("click", () => { if (!disabled) goTo(i); });
      stepperEl.appendChild(tab);
    });
    document.getElementById("cr-progress").textContent = STEPS[step];
  }

  function showStep(n) {
    for (let i = 0; i < STEPS.length; i++) {
      document.getElementById(`cr-step-${i}`).classList.toggle("hidden", i !== n);
    }
  }

  function updateNav() {
    document.getElementById("cr-back-btn").disabled = step === 0;
    document.getElementById("cr-draft-submit").classList.toggle("hidden", step !== 1);
    document.getElementById("cr-complete-submit").classList.toggle("hidden", step !== 2);
  }

  function goTo(n) {
    step = n;
    renderStepper();
    showStep(step);
    updateNav();
    if (n === 0) loadOpenEntries();
  }

  document.getElementById("cr-back-btn").addEventListener("click", () => {
    goTo(step === 2 ? cameFromStep : 0);
  });
  document.getElementById("cr-goto-new-draft").addEventListener("click", (e) => {
    e.preventDefault();
    goTo(1);
  });

  // ── Open Drafts ─────────────────────────────────────────────────
  async function loadOpenEntries() {
    const el = document.getElementById("cr-open-entries");
    el.innerHTML = `<div class="nx-empty">Loading…</div>`;
    try {
      const { data } = await api(`/process/${processCode}/open-entries`);
      const rows = data || [];
      el.innerHTML = rows.length === 0 ? `<div class="nx-empty">No open drafts.</div>` : `
        <table>
          <thead><tr><th>Batch Ref</th><th>Material</th><th>Machine</th><th>Notes</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td><span class="badge badge--accent">${esc(r.batchRef)}</span></td><td>${esc(r.material)}</td><td>${esc(r.machineName || r.machineCode)}</td>
                <td>${esc(r.notes)}</td><td>${new Date(r.createdAt).toLocaleString("en-GB")}</td>
                <td><button type="button" class="secondary" data-select="${r.recordId}" data-ref="${esc(r.batchRef)}">Complete</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-select]").forEach((btn) => {
        btn.addEventListener("click", () => selectDraft(Number(btn.dataset.select), btn.dataset.ref));
      });
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`;
    }
  }

  // ── Parent batch / raw material rows ────────────────────────────
  function renumber(listEl) {
    Array.from(listEl.children).forEach((row, idx) => {
      const idxEl = row.querySelector(".item-row-index");
      if (idxEl) idxEl.textContent = String(idx + 1);
    });
  }

  function addParentRow() {
    const listEl = document.getElementById("cr-parent-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <input type="text" placeholder="Process Code (e.g. MX)" class="cr-parent-pc tf-input tf-input--sm">
        <input type="number" placeholder="Record ID" class="cr-parent-rid tf-input tf-input--sm">
        <input type="number" placeholder="Tub ID (optional)" class="cr-parent-tub tf-input tf-input--sm">
      </div>
      <button type="button" class="item-row-remove" title="Remove parent batch" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
  }
  document.getElementById("cr-add-parent").addEventListener("click", addParentRow);

  function addRawMatRow() {
    const listEl = document.getElementById("cr-rawmat-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <input type="text" placeholder="Material" class="cr-rawmat-material tf-input tf-input--sm">
        <input type="text" placeholder="Batch Number" class="cr-rawmat-batch tf-input tf-input--sm">
      </div>
      <button type="button" class="item-row-remove" title="Remove raw material batch" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
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

  function setDraftResult(text, kind) {
    const el = document.getElementById("cr-draft-result");
    if (kind === "loading") {
      el.innerHTML = `<div class="nx-empty">${esc(text)}</div>`;
    } else {
      const cls = kind === "error" ? "badge--error" : kind === "success" ? "badge--success" : "";
      el.innerHTML = `<span class="badge ${cls}">${esc(text)}</span>`;
    }
  }

  // ── Draft creation ──────────────────────────────────────────────
  document.getElementById("cr-draft-submit").addEventListener("click", async () => {
    const material = document.getElementById("cr-material").value.trim();
    if (!material) { setDraftResult("Material is required.", "error"); return; }
    setDraftResult("Creating draft…", "loading");
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
      setDraftResult(`✓ Draft ${data.batchRef} created.` + (data.warnings && data.warnings.length ? ` Warnings: ${data.warnings.join("; ")}` : ""), "success");
      loadOpenEntries();
      selectDraft(data.recordId, data.batchRef);
    } catch (err) {
      setDraftResult("Error: " + err.message, "error");
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
    const listEl = document.getElementById("cr-scrap-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <select class="cr-scrap-reason tf-input tf-input--sm">${scrapReasons.map((r) => `<option value="${r.reasonId}">${esc(r.reasonDescription)}</option>`).join("")}</select>
        <input type="number" placeholder="KG" class="cr-scrap-kg tf-input tf-input--sm" step="0.001">
        <input type="number" placeholder="Occurrences" class="cr-scrap-occ tf-input tf-input--sm">
      </div>
      <button type="button" class="item-row-remove" title="Remove scrap reason" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
  }
  document.getElementById("cr-add-scrap").addEventListener("click", addScrapRow);

  function collectScrapReasons() {
    return Array.from(document.querySelectorAll("#cr-scrap-list > div")).map((row) => ({
      reasonId: Number(row.querySelector(".cr-scrap-reason").value),
      kg: row.querySelector(".cr-scrap-kg").value ? Number(row.querySelector(".cr-scrap-kg").value) : null,
      occurrences: row.querySelector(".cr-scrap-occ").value ? Number(row.querySelector(".cr-scrap-occ").value) : null,
    }));
  }

  // ── Scrap toggle ──
  const scrapCheckbox = document.getElementById("cr-has-scrap");
  const scrapTrack = document.getElementById("cr-scrap-track");
  const scrapBody = document.getElementById("cr-scrap-body");
  scrapCheckbox.addEventListener("change", () => {
    scrapTrack.classList.toggle("is-on", scrapCheckbox.checked);
    scrapTrack.classList.toggle("is-off", !scrapCheckbox.checked);
    scrapBody.classList.toggle("hidden", !scrapCheckbox.checked);
  });

  // ── Complete step ────────────────────────────────────────────────
  let selectedRecordId = null;

  function selectDraft(recordId, batchRef) {
    selectedRecordId = recordId;
    cameFromStep = step === 2 ? cameFromStep : step;
    completeUnlocked = true;
    document.getElementById("cr-complete-ref").textContent = `(${batchRef})`;
    goTo(2);
  }

  function setCompleteResult(text, kind) {
    const el = document.getElementById("cr-complete-result");
    if (kind === "loading") {
      el.innerHTML = `<div class="nx-empty">${esc(text)}</div>`;
    } else {
      const cls = kind === "error" ? "badge--error" : kind === "warn" ? "badge--warn" : kind === "success" ? "badge--success" : "";
      el.innerHTML = `<span class="badge ${cls}">${esc(text)}</span>`;
    }
  }

  document.getElementById("cr-complete-submit").addEventListener("click", async () => {
    if (!selectedRecordId) return;
    const lengthMetres = Number(document.getElementById("cr-length").value);
    if (!(lengthMetres > 0)) { setCompleteResult("Length (Metres) must be greater than 0.", "error"); return; }

    const operatorIds = document.getElementById("cr-operators").value.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
    const hasScrap = document.getElementById("cr-has-scrap").checked;

    setCompleteResult("Posting to SAP…", "loading");
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
        setCompleteResult(`⚠ ${data.batchRef} saved but SAP posting failed: ${data.error}. See Failed Backflush queue for supervisor retry.`, "warn");
      } else {
        setCompleteResult(`✓ ${data.batchRef} completed — MatDoc: ${data.materialDocument}${data.warning ? ` (${data.warning})` : ""}`, "success");
      }
      window.ProductionLabels.mount(document.getElementById("cr-print-widget"), { processCode, recordId: selectedRecordId, tubs: null });
      loadOpenEntries();
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes("block")) {
        setCompleteResult("Blocked: " + err.message, "error");
      } else {
        setCompleteResult("Error: " + err.message, "error");
      }
    }
  });

  renderStepper();
  showStep(0);
  updateNav();
  addParentRow();
  addRawMatRow();
  loadScrapReasons().then(addScrapRow);
  loadOpenEntries();
})();
