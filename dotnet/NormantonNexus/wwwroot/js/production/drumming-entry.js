// Drumming entry — a 5-step progressive wizard (Details / Traceability /
// Coil Lengths / Scrap / Review) over the same POST /drumming/{stock|customer}
// backend as before. Two distinct, mutually-exclusive routes: Make-to-Stock
// (operator types the Material Number) and Make-to-Order (operator enters
// Order Number + Order Item instead — Material is resolved automatically
// from GET order-lookup/by-order/{orderNumber} and never typed by hand).
// Raw Material Batches is deliberately NOT part of this form — the product
// is already finished by the time it reaches Drumming; raw material
// traceability only applies to the EX/CO/BR/CL/TW Complete Run wizard.
// DrummingSubmitRequest.RawMaterialBatches is nullable server-side
// (`?? []`), so simply omitting it from the JSON body is enough.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const packagingApi = NexusApi.make("/api");

  const STEPS = ["Details", "Traceability", "Coil Lengths", "Scrap", "Review"];
  let step = 0;
  let maxReached = 0;
  let orderRows = [];

  function shiftFromHour() {
    const h = new Date().getHours();
    if (h >= 6 && h < 14) return 1;
    if (h >= 14 && h < 22) return 2;
    return 3;
  }
  document.getElementById("dw-shift").value = String(shiftFromHour());

  // ── Stepper controller ──
  function checkmarkSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }

  function renderStepper() {
    const stepperEl = document.getElementById("dw-stepper");
    stepperEl.innerHTML = "";
    STEPS.forEach((label, i) => {
      if (i > 0) {
        const connector = document.createElement("span");
        connector.className = "step-connector" + (i <= step ? " is-done" : "");
        stepperEl.appendChild(connector);
      }
      const done = i < step;
      const active = i === step;
      const disabled = i > maxReached;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "step-tab" + (active ? " is-active" : "") + (done ? " is-done" : "") + (disabled ? " is-disabled" : "");
      tab.disabled = disabled;
      tab.innerHTML = `<span class="step-circle">${done ? checkmarkSvg() : String(i + 1)}</span><span class="step-label">${esc(label)}</span>`;
      tab.addEventListener("click", () => { if (!disabled) goTo(i); });
      stepperEl.appendChild(tab);
    });
    document.getElementById("dw-progress").textContent = `Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`;
  }

  function showStep(n) {
    for (let i = 0; i < STEPS.length; i++) {
      document.getElementById(`dw-step-${i}`).classList.toggle("hidden", i !== n);
    }
  }

  function updateNav() {
    document.getElementById("dw-back-btn").disabled = step === 0;
    const isLast = step === STEPS.length - 1;
    document.getElementById("dw-next-btn").classList.toggle("hidden", isLast);
    document.getElementById("dw-submit-btn").classList.toggle("hidden", !isLast);
  }

  function setStepError(text) {
    const el = document.getElementById("dw-step-error");
    el.innerHTML = text ? `<span class="badge badge--error">${esc(text)}</span>` : "";
  }

  function validateStep(n) {
    if (n === 0) {
      if (!document.getElementById("dw-material").value.trim()) {
        return document.getElementById("dw-type").value === "customer"
          ? "Find the order and select an order item to resolve the material."
          : "Material is required.";
      }
    }
    return null;
  }

  function goTo(n) {
    setStepError(null);
    step = n;
    renderStepper();
    showStep(step);
    updateNav();
  }

  function goNext() {
    const err = validateStep(step);
    if (err) { setStepError(err); return; }
    setStepError(null);
    maxReached = Math.max(maxReached, step + 1);
    step = Math.min(step + 1, STEPS.length - 1);
    renderStepper();
    showStep(step);
    updateNav();
  }

  function goBack() {
    setStepError(null);
    step = Math.max(0, step - 1);
    renderStepper();
    showStep(step);
    updateNav();
  }

  document.getElementById("dw-next-btn").addEventListener("click", goNext);
  document.getElementById("dw-back-btn").addEventListener("click", goBack);

  // ── Type toggle: Make-to-Stock (type material) vs Make-to-Order (resolve from order) ──
  function applyTypeState(type) {
    const isCustomer = type === "customer";
    document.getElementById("dw-customer-fields").classList.toggle("hidden", !isCustomer);
    const materialInput = document.getElementById("dw-material");
    materialInput.readOnly = isCustomer;
    materialInput.classList.toggle("tf-input--resolved", isCustomer);
    materialInput.placeholder = isCustomer ? "Resolved from selected order item" : "";
    if (isCustomer) materialInput.value = "";
  }
  document.getElementById("dw-type").addEventListener("change", (e) => applyTypeState(e.target.value));
  applyTypeState(document.getElementById("dw-type").value);

  async function loadPackaging() {
    const sel = document.getElementById("dw-packaging");
    try {
      const { data } = await packagingApi("/packagingdata");
      sel.innerHTML = '<option value="">—</option>' + (data || []).map((p) => `<option value="${esc(p.packId)}">${esc(p.packId)} — ${esc(p.packDescription)}</option>`).join("");
    } catch {
      sel.innerHTML = '<option value="">Could not load packaging data</option>';
    }
  }

  // ── Make-to-Order: find the order, pick the item, material auto-resolves ──
  document.getElementById("dw-find-order").addEventListener("click", async () => {
    const orderNumber = document.getElementById("dw-order").value.trim();
    const resultEl = document.getElementById("dw-order-result");
    const itemSelect = document.getElementById("dw-order-item");
    if (!orderNumber) {
      resultEl.innerHTML = `<span class="badge badge--error">Enter an order number.</span>`;
      return;
    }
    resultEl.innerHTML = `<div class="nx-empty">Searching…</div>`;
    itemSelect.innerHTML = '<option value="">—</option>';
    orderRows = [];
    try {
      const { data } = await api(`/order-lookup/by-order/${encodeURIComponent(orderNumber)}`);
      orderRows = data || [];
      itemSelect.innerHTML = orderRows
        .map((r) => `<option value="${esc(r.item)}">${esc(r.item)} — ${esc(r.material)} — ${esc(r.materialText || "")}</option>`)
        .join("");
      resultEl.innerHTML = `<span class="badge badge--success">${orderRows.length} open item(s) found.</span>`;
      if (orderRows.length) {
        itemSelect.value = orderRows[0].item;
        itemSelect.dispatchEvent(new Event("change"));
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="badge badge--error">${esc(err.message)}</span>`;
    }
  });

  document.getElementById("dw-order-item").addEventListener("change", (e) => {
    const row = orderRows.find((r) => String(r.item) === e.target.value);
    if (!row) return;
    document.getElementById("dw-material").value = row.material;
    if (!document.getElementById("dw-customer").value.trim()) {
      document.getElementById("dw-customer").value = row.customer;
    }
  });

  // ── Parent batch / coil / scrap rows ──
  function renumber(listEl) {
    Array.from(listEl.children).forEach((row, idx) => {
      const idxEl = row.querySelector(".item-row-index");
      if (idxEl) idxEl.textContent = String(idx + 1);
    });
  }

  function addParentRow() {
    const listEl = document.getElementById("dw-parent-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <input type="text" placeholder="Process Code (e.g. MX)" class="dw-parent-pc tf-input tf-input--sm">
        <input type="number" placeholder="Record ID" class="dw-parent-rid tf-input tf-input--sm">
        <input type="number" placeholder="Tub ID (optional)" class="dw-parent-tub tf-input tf-input--sm">
      </div>
      <button type="button" class="item-row-remove" title="Remove parent batch" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
  }
  document.getElementById("dw-add-parent").addEventListener("click", addParentRow);

  function addCoilRow() {
    const listEl = document.getElementById("dw-coil-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <input type="number" placeholder="Length (m)" class="dw-coil-length tf-input tf-input--sm" step="0.001">
      </div>
      <span class="item-row-unit">M</span>
      <button type="button" class="item-row-remove" title="Remove coil" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
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
    const listEl = document.getElementById("dw-scrap-list");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-row-index"></span>
      <div class="item-row-fields">
        <select class="dw-scrap-reason tf-input tf-input--sm">${scrapReasons.map((r) => `<option value="${r.reasonId}">${esc(r.reasonDescription)}</option>`).join("")}</select>
        <input type="number" placeholder="KG" class="dw-scrap-kg tf-input tf-input--sm" step="0.001">
        <input type="number" placeholder="Occurrences" class="dw-scrap-occ tf-input tf-input--sm">
      </div>
      <button type="button" class="item-row-remove" title="Remove scrap reason" data-remove>&times;</button>`;
    row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); renumber(listEl); });
    listEl.appendChild(row);
    renumber(listEl);
  }
  document.getElementById("dw-add-scrap").addEventListener("click", addScrapRow);

  // ── Scrap toggle ──
  const scrapCheckbox = document.getElementById("dw-has-scrap");
  const scrapTrack = document.getElementById("dw-scrap-track");
  const scrapBody = document.getElementById("dw-scrap-body");
  scrapCheckbox.addEventListener("change", () => {
    scrapTrack.classList.toggle("is-on", scrapCheckbox.checked);
    scrapTrack.classList.toggle("is-off", !scrapCheckbox.checked);
    scrapBody.classList.toggle("hidden", !scrapCheckbox.checked);
  });

  function collectParentBatches() {
    return Array.from(document.querySelectorAll("#dw-parent-list > div")).map((row) => ({
      processCode: row.querySelector(".dw-parent-pc").value.trim() || null,
      recordId: row.querySelector(".dw-parent-rid").value ? Number(row.querySelector(".dw-parent-rid").value) : null,
      tubId: row.querySelector(".dw-parent-tub").value ? Number(row.querySelector(".dw-parent-tub").value) : null,
    })).filter((p) => p.processCode && p.recordId);
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

  const resultEl = document.getElementById("dw-result");
  function setResult(text, kind) {
    if (kind === "loading") {
      resultEl.innerHTML = `<div class="nx-empty">${esc(text)}</div>`;
    } else {
      const cls = kind === "error" ? "badge--error" : kind === "warn" ? "badge--warn" : kind === "success" ? "badge--success" : "";
      resultEl.innerHTML = `<span class="badge ${cls}">${esc(text)}</span>`;
    }
  }

  document.getElementById("dw-submit-btn").addEventListener("click", async () => {
    const type = document.getElementById("dw-type").value;
    const material = document.getElementById("dw-material").value.trim();
    if (!material) { setResult("Material is required.", "error"); return; }

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
      coilLengths: collectCoilLengths(),
      hasScrap,
      scrapTotalKg: hasScrap && document.getElementById("dw-scrap-total").value ? Number(document.getElementById("dw-scrap-total").value) : null,
      scrapReasons: hasScrap ? collectScrapReasons() : [],
      comments: document.getElementById("dw-comments").value.trim() || null,
    };

    setResult("Posting to SAP…", "loading");
    try {
      const { data } = await api(`/drumming/${type}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (data.status === "SAP_FAILED") {
        setResult(`⚠ ${data.batchRef} saved but SAP posting failed: ${data.error}. See Failed Backflush queue for supervisor retry.`, "warn");
      } else {
        setResult(`✓ ${data.batchRef} posted — MatDoc: ${data.materialDocument || "—"}${data.warning ? ` (${data.warning})` : ""}${data.bomMismatch ? " — BOM mismatch flagged" : ""}`, "success");
      }
      window.ProductionLabels.mount(document.getElementById("dw-print-widget"), { processCode: "DR", recordId: data.drummingId, tubs: null });
    } catch (err) {
      setResult("Error: " + err.message, "error");
    }
  });

  renderStepper();
  showStep(0);
  updateNav();
  loadPackaging();
  addParentRow();
  addCoilRow();
  loadScrapReasons().then(addScrapRow);
})();
