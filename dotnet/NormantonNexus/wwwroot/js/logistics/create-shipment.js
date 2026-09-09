// Create Outbound Shipment — port of the "Completed picksheets" picker +
// Create Shipment modal + Manual Shipment modal + post-create action cards
// in private/js/logistics.js (runOpenDeliveries/renderOpenDeliveries/
// openShipmentModal/openManualShipmentModal/showPostCreateModal). Design
// approved via the /design canvas "Create Outbound Shipment Redesign",
// replacing the earlier bare comma-separated-delivery-IDs form.
//
// One deliberate change from the approved design and from Node: the
// Customs Complete checkbox is dropped from both the Create Shipment and
// Manual Shipment forms — per explicit instruction, a shipment's customs
// should only ever be marked complete from the Customs tile, not guessed
// at creation time. customsComplete is always sent as false.
//
// GET /api/deliverymain/completed-unshipped and PATCH .../uncomplete were
// both genuinely missing from this migration until this pass — see
// WarehousePicksheetHelper's own doc comments. "Mark as Cancelled" (the
// other context-menu action in Node) is deliberately NOT built here: its
// backend calls cancelHeldPicksheet, a real SAP-staging-reversal path this
// pass hasn't ported or verified — flagged, not silently dropped.
(function () {
  const esc = NexusApi.esc;
  const deliveryApi = NexusApi.make("/api/deliverymain");
  const shipmentApi = NexusApi.make("/api/shipmentmain");
  const refApi = NexusApi.make("/api");

  const BUCKETS = [
    { key: "priority", label: "Priority", color: "var(--error)" },
    { key: "backlog", label: "Backlog", color: "var(--warn)" },
    { key: "today", label: "Today", color: "var(--success)" },
    { key: "this-week", label: "This Week", color: "var(--accent)" },
    { key: "this-month", label: "This Month", color: "var(--pending)" },
    { key: "other", label: "Everything Else", color: "var(--text-muted)" },
  ];

  let rows = [];
  let search = "";
  const selected = new Set();
  const collapsed = new Set(["this-month", "other"]);
  let allForwarders = null;
  let allDestinations = null;

  const bodyEl = document.getElementById("cs-body");
  const lockMsgEl = document.getElementById("cs-lock-msg");
  const searchInput = document.getElementById("cs-search-input");
  const createBtn = document.getElementById("cs-create-btn");
  const clearBtn = document.getElementById("cs-clear-btn");
  const manualBtn = document.getElementById("cs-manual-btn");

  function normalizeHaulierName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function isExWorks(value) { const n = String(value || "").trim().toUpperCase().replace(/\s+/g, ""); return n === "EXW" || n === "EXWORKS"; }
  function fmtDate(v) { return v ? new Date(v).toLocaleDateString("en-GB") : "—"; }

  function bucketFor(row) {
    if (row.deliveryPriority === 1) return "priority";
    if (!row.dispatchDate) return "other";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const due = new Date(row.dispatchDate);
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    if (dueDay < today) return "backlog";
    if (dueDay.getTime() === today.getTime()) return "today";
    const dow = today.getDay() || 7;
    const monday = new Date(today); monday.setDate(today.getDate() - dow + 1);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    if (dueDay <= sunday) return "this-week";
    if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) return "this-month";
    return "other";
  }

  // ── Load + render the picker ─────────────────────────────────────────

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    try {
      const { data } = await deliveryApi("/completed-unshipped");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function selectedRows() { return rows.filter((r) => selected.has(r.deliveryId)); }
  function selectedCustomerId() { const first = selectedRows()[0]; return first ? first.customerId : null; }

  function updateToolbar() {
    const picked = selectedRows();
    createBtn.disabled = picked.length === 0;
    clearBtn.disabled = picked.length === 0;
    document.getElementById("cs-hint").textContent = picked.length
      ? `${picked.length} delivery(ies) selected for ${picked[0].destinationName || "this customer"}.`
      : "Select deliveries for one customer, then create a shipment.";
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty">No completed deliveries are currently available for shipment creation.</div>';
      updateToolbar();
      return;
    }

    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => String(r.deliveryId).includes(q) || (r.destinationName || "").toLowerCase().includes(q)) : rows;

    const byBucket = new Map(BUCKETS.map((b) => [b.key, []]));
    filtered.forEach((r) => byBucket.get(bucketFor(r)).push(r));

    const sectionsHtml = BUCKETS.filter((b) => byBucket.get(b.key).length > 0).map((b) => {
      const bucketRows = byBucket.get(b.key);
      const isExpanded = !collapsed.has(b.key);
      return `<div class="ps-section${isExpanded ? "" : " ps-section--collapsed"}">
        <div class="ps-section-header cs-toggle" data-bucket="${b.key}">
          <span class="ps-section-dot" style="background:${b.color}"></span>
          <span class="ps-section-title">${esc(b.label)}</span>
          <span class="ps-section-count">${bucketRows.length}</span>
          <span class="ps-chevron">&#9660;</span>
        </div>
        <div class="ps-section-body">
          <div style="overflow-x:auto">
          <table>
            <thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Completed</th><th>Due</th><th>Service</th><th>Pallets</th><th>Weight</th><th>Volume</th><th>Comment</th><th></th></tr></thead>
            <tbody>${bucketRows.map((r) => `
              <tr data-id="${r.deliveryId}">
                <td><input type="checkbox" class="cs-check" data-id="${r.deliveryId}" ${selected.has(r.deliveryId) ? "checked" : ""}></td>
                <td>${r.deliveryPriority === 1 ? '<span class="nx-priority-flag"></span>' : ""}${esc(r.deliveryId)}</td>
                <td>${esc(r.destinationName || "—")}</td>
                <td>${fmtDate(r.completionDate)}</td>
                <td>${fmtDate(r.dispatchDate)}</td>
                <td>${esc(r.deliveryService || "")}</td>
                <td>${esc(r.palletCount ?? 0)}</td>
                <td>${esc(r.grossWeight ?? 0)}</td>
                <td>${esc(r.deliveryVolume ?? 0)}</td>
                <td class="nx-comment-cell" title="${esc(r.picksheetComment || "")}">${esc(r.picksheetComment || "—")}</td>
                <td><button type="button" class="nx-row-menu-btn cs-menu-btn" data-id="${r.deliveryId}">&#8942;</button></td>
              </tr>`).join("")}</tbody>
          </table>
          </div>
        </div>
      </div>`;
    }).join("");

    bodyEl.innerHTML = sectionsHtml || `<div class="nx-empty">No deliveries match "${esc(search)}".</div>`;

    bodyEl.querySelectorAll(".cs-toggle").forEach((h) => h.addEventListener("click", () => {
      const key = h.dataset.bucket;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      render();
    }));
    bodyEl.querySelectorAll(".cs-check").forEach((cb) => cb.addEventListener("change", (e) => onToggleRow(Number(e.target.dataset.id), e.target)));
    bodyEl.querySelectorAll(".cs-menu-btn").forEach((btn) => btn.addEventListener("click", (e) => openRowMenu(e, Number(btn.dataset.id))));

    updateToolbar();
  }

  function onToggleRow(id, checkboxEl) {
    const row = rows.find((r) => r.deliveryId === id);
    const lockedCustomer = selectedCustomerId();
    if (checkboxEl.checked && lockedCustomer && String(lockedCustomer) !== String(row.customerId)) {
      checkboxEl.checked = false;
      lockMsgEl.innerHTML = '<div class="nx-lock-msg">Only deliveries for the same customer can be added to one shipment.</div>';
      return;
    }
    lockMsgEl.innerHTML = "";
    if (checkboxEl.checked) selected.add(id); else selected.delete(id);
    updateToolbar();
  }

  clearBtn.addEventListener("click", () => {
    selected.clear();
    lockMsgEl.innerHTML = "";
    render();
  });

  searchInput.addEventListener("input", () => {
    const caret = searchInput.selectionStart;
    search = searchInput.value;
    render();
    const newInput = document.getElementById("cs-search-input");
    newInput.focus();
    newInput.setSelectionRange(caret, caret);
  });

  // ── Row context menu (return to Open Picksheets) ──────────────────────

  function closeRowMenu() {
    document.getElementById("cs-ctx-menu")?.remove();
    document.removeEventListener("click", closeRowMenu);
  }

  function openRowMenu(evt, deliveryId) {
    evt.stopPropagation();
    closeRowMenu();
    const rect = evt.currentTarget.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.id = "cs-ctx-menu";
    menu.className = "nx-ctx-menu";
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 210)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.innerHTML = `<div class="nx-ctx-item" id="cs-ctx-uncomplete">Return to Open Picksheets</div>`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeRowMenu), 0);
    document.getElementById("cs-ctx-uncomplete").addEventListener("click", async () => {
      closeRowMenu();
      if (!(await NexusModal.confirm(`Return Delivery #${deliveryId} to Open Picksheets? It will need to be completed again before it can be added to a shipment. Any pallets already built are kept.`, { confirmLabel: "Return" }))) return;
      try {
        await deliveryApi(`/${deliveryId}/uncomplete`, { method: "PATCH" });
        await load();
      } catch (err) {
        await NexusModal.alert(err.message);
      }
    });
  }

  // ── Shared reference data ─────────────────────────────────────────────

  async function loadForwarders() {
    if (allForwarders) return allForwarders;
    const { data } = await refApi("/forwarders");
    allForwarders = data || [];
    return allForwarders;
  }

  async function loadDestinations() {
    if (allDestinations) return allDestinations;
    const { data } = await refApi("/destinations");
    allDestinations = data || [];
    return allDestinations;
  }

  function forwarderModeOptions(forwarders) {
    return [...new Set(forwarders.map((f) => String(f.forwarderMode || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function wireForwarderCascade(card, modeSelectId, nameSelectId, forwarders) {
    const modeSelect = card.querySelector(`#${modeSelectId}`);
    const nameSelect = card.querySelector(`#${nameSelectId}`);
    function applyMode() {
      const mode = modeSelect.value;
      const matches = forwarders.filter((f) => String(f.forwarderMode || "").trim() === mode);
      const unique = matches.filter((f, i, arr) => arr.findIndex((o) => String(o.forwarderName || "").trim() === String(f.forwarderName || "").trim()) === i);
      nameSelect.innerHTML = `<option value="">Select forwarder</option>${unique.map((f) => `<option value="${f.forwarderId}">${esc(String(f.forwarderName || "").trim())}</option>`).join("")}`;
      nameSelect.disabled = !mode;
      if (unique.length === 1) nameSelect.value = String(unique[0].forwarderId);
    }
    modeSelect.addEventListener("change", applyMode);
    return applyMode;
  }

  // ── Create Shipment modal ─────────────────────────────────────────────

  function buildDraft() {
    const picked = selectedRows();
    const first = picked[0];
    return picked.reduce((draft, r) => {
      draft.palletCount += Number(r.palletCount || 0);
      draft.grossWeight += Number(r.grossWeight || 0);
      draft.shipmentVolume += Number(r.deliveryVolume || 0);
      return draft;
    }, {
      destinationName: first.destinationName || "", destinationStreet: first.destinationStreet || "",
      destinationCity: first.destinationCity || "", destinationPostCode: first.destinationPostCode || "",
      destinationCountry: first.destinationCountry || "", incoTerms: first.incoterms || first.defaultIncoterms || "",
      plannedCollection: new Date().toISOString().slice(0, 10),
      deliveryService: first.deliveryService || "", defaultForwarder: first.defaultForwarder || "",
      palletCount: 0, grossWeight: 0, shipmentVolume: 0,
    });
  }

  async function openCreateModal() {
    const picked = selectedRows();
    if (!picked.length) return;

    const effectiveTerms = [...new Set(picked.map((r) => String(r.incoterms || r.defaultIncoterms || "").trim().toUpperCase()).filter(Boolean))];
    if (effectiveTerms.length > 1) {
      const detail = picked.map((r) => `#${r.deliveryId} → ${String(r.incoterms || r.defaultIncoterms || "?").toUpperCase()}`).join(", ");
      await NexusModal.alert(`Cannot create shipment — deliveries have conflicting incoterms (${effectiveTerms.join(" vs ")}): ${detail}`);
      return;
    }

    const draft = buildDraft();
    const forwarders = await loadForwarders();
    const modeOptions = forwarderModeOptions(forwarders);

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Create Shipment</div><div class="ps-modal-sub">${esc(draft.destinationName)} — ${picked.length} deliveries</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <p class="tf-section-label">Shipment Header</p>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Planned Collection</label><input class="tf-input" type="date" id="cm-planned" value="${esc(draft.plannedCollection)}"></div>
          <div class="tf-field"><label class="tf-label">Forwarder Mode</label><select class="tf-input" id="cm-mode"><option value="">Select mode</option>${modeOptions.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select></div>
          <div class="tf-field"><label class="tf-label">Forwarder Name</label><select class="tf-input" id="cm-name" disabled><option value="">Select forwarder</option></select></div>
          <div class="tf-field"><label class="tf-label">Incoterms</label><input class="tf-input" type="text" id="cm-incoterms" value="${esc(draft.incoTerms)}"></div>
        </div>
        <div id="cm-forwarder-warn"></div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Destination Name</label><input class="tf-input" type="text" id="cm-dest-name" value="${esc(draft.destinationName)}"></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Destination Street</label><input class="tf-input" type="text" id="cm-dest-street" value="${esc(draft.destinationStreet)}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="cm-dest-city" value="${esc(draft.destinationCity)}"></div>
          <div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="cm-dest-postcode" value="${esc(draft.destinationPostCode)}"></div>
          <div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="cm-dest-country" value="${esc(draft.destinationCountry)}"></div>
        </div>
        <div class="lg-flag-row"><label class="lg-flag"><input type="checkbox" id="cm-customs-required"> Customs Required</label></div>
        <p class="tf-section-label">Calculated Totals <span class="tf-locked">Read only</span></p>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Pallet Count</label><input class="tf-input" readonly value="${draft.palletCount.toFixed(3)}"></div>
          <div class="tf-field"><label class="tf-label">Gross Weight</label><input class="tf-input" readonly value="${draft.grossWeight.toFixed(3)}"></div>
          <div class="tf-field"><label class="tf-label">Volume</label><input class="tf-input" readonly value="${draft.shipmentVolume.toFixed(3)}"></div>
        </div>
        <div id="cm-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cm-cancel">Cancel</button>
        <button type="button" class="btn" id="cm-confirm">Confirm Shipment</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cm-cancel").addEventListener("click", () => NexusModal.close());

    const applyMode = wireForwarderCascade(card, "cm-mode", "cm-name", forwarders);
    function applyDefaultForwarder() {
      const warnEl = card.querySelector("#cm-forwarder-warn");
      if (!draft.defaultForwarder || !card.querySelector("#cm-mode").value) { warnEl.innerHTML = ""; return; }
      const nameSelect = card.querySelector("#cm-name");
      const opt = [...nameSelect.options].find((o) => o.text.trim().toLowerCase() === draft.defaultForwarder.trim().toLowerCase() || o.value === draft.defaultForwarder.trim());
      if (opt) { nameSelect.value = opt.value; warnEl.innerHTML = ""; }
      else warnEl.innerHTML = `<div class="nx-lock-msg">Default haulier <strong>${esc(draft.defaultForwarder)}</strong> not available for selected service.</div>`;
    }
    card.querySelector("#cm-mode").addEventListener("change", () => { applyMode(); applyDefaultForwarder(); });

    const svc = draft.deliveryService.trim();
    if (svc) {
      const match = modeOptions.find((m) => m === svc) || modeOptions.find((m) => m.toLowerCase() === svc.toLowerCase());
      if (match) { card.querySelector("#cm-mode").value = match; applyMode(); applyDefaultForwarder(); }
    }

    card.querySelector("#cm-confirm").addEventListener("click", () => submitCreate(card, picked, draft));
  }

  async function submitCreate(card, picked, draft) {
    const btn = card.querySelector("#cm-confirm");
    const result = card.querySelector("#cm-result");
    btn.disabled = true; btn.textContent = "Creating…"; result.innerHTML = "";
    try {
      const payload = {
        deliveryIds: picked.map((r) => r.deliveryId),
        plannedCollection: card.querySelector("#cm-planned").value || null,
        forwarderId: card.querySelector("#cm-name").value || null,
        incoTerms: card.querySelector("#cm-incoterms").value.trim(),
        destinationName: card.querySelector("#cm-dest-name").value.trim(),
        destinationStreet: card.querySelector("#cm-dest-street").value.trim(),
        destinationCity: card.querySelector("#cm-dest-city").value.trim(),
        destinationPostCode: card.querySelector("#cm-dest-postcode").value.trim(),
        destinationCountry: card.querySelector("#cm-dest-country").value.trim(),
        customsRequired: card.querySelector("#cm-customs-required").checked,
        customsComplete: false,
      };
      const { data } = await shipmentApi("/create-from-deliveries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      NexusModal.close();
      await load();
      showPostCreateModal(data.shipmentId, data.shipmentRef, data.folderPath, data.canSendEmail);
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Confirm Shipment";
    }
  }

  // ── Manual Shipment modal ─────────────────────────────────────────────

  async function openManualModal() {
    const forwarders = await loadForwarders();
    const modeOptions = forwarderModeOptions(forwarders);
    const destinations = await loadDestinations();
    let cargoRows = [{ id: 1 }];
    let nextCargoId = 2;

    function cargoRowHtml(row) {
      return `<tr data-row="${row.id}">
        <td><input class="tf-input mn-c-desc" style="padding:5px 8px;font-size:12px" type="text" placeholder="e.g. Steel brackets"></td>
        <td><input class="tf-input mn-c-qty" style="padding:5px 8px;font-size:12px;width:60px" type="number" min="1" step="1" value="1"></td>
        <td><input class="tf-input mn-c-weight" style="padding:5px 8px;font-size:12px;width:80px" type="number" min="0" step="0.1" placeholder="kg"></td>
        <td><input class="tf-input mn-c-length" style="padding:5px 8px;font-size:12px;width:60px" type="number" min="0" step="0.1" placeholder="cm"></td>
        <td><input class="tf-input mn-c-width" style="padding:5px 8px;font-size:12px;width:60px" type="number" min="0" step="0.1" placeholder="cm"></td>
        <td><input class="tf-input mn-c-height" style="padding:5px 8px;font-size:12px;width:60px" type="number" min="0" step="0.1" placeholder="cm"></td>
        <td><button type="button" class="nx-row-menu-btn mn-c-remove">&times;</button></td>
      </tr>`;
    }

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Manual Shipment</div><div class="ps-modal-sub">Goods not managed through SAP — enter cargo manually</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <p class="tf-section-label">Shipment Header</p>
        <div class="tf-row">
          <div class="tf-field tf-field--wide" style="position:relative">
            <label class="tf-label">Destination</label>
            <input class="tf-input" type="text" id="mn-dest-search" placeholder="Start typing a destination name…" autocomplete="off">
            <input type="hidden" id="mn-dest-id">
            <div id="mn-dest-results" class="hidden" style="position:absolute;top:100%;left:0;right:0;z-index:20;background:var(--surface);border:1px solid var(--border);border-radius:0 0 8px 8px;max-height:200px;overflow-y:auto;box-shadow:var(--shadow-md)"></div>
          </div>
          <div class="tf-field"><label class="tf-label">Planned Collection</label><input class="tf-input" type="date" id="mn-planned" value="${new Date().toISOString().slice(0, 10)}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Forwarder Mode</label><select class="tf-input" id="mn-mode"><option value="">Select mode</option>${modeOptions.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select></div>
          <div class="tf-field"><label class="tf-label">Forwarder Name</label><select class="tf-input" id="mn-name" disabled><option value="">Select forwarder</option></select></div>
          <div class="tf-field"><label class="tf-label">Incoterms</label><input class="tf-input" type="text" id="mn-incoterms"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Destination Street</label><input class="tf-input" type="text" id="mn-dest-street"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="mn-dest-city"></div>
          <div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="mn-dest-postcode"></div>
          <div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="mn-dest-country"></div>
        </div>
        <div class="lg-flag-row"><label class="lg-flag"><input type="checkbox" id="mn-customs-required"> Customs Required</label></div>
        <p class="tf-section-label">Cargo</p>
        <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Description</th><th>Qty</th><th>Weight</th><th>Length</th><th>Width</th><th>Height</th><th></th></tr></thead>
          <tbody id="mn-cargo-body">${cargoRows.map(cargoRowHtml).join("")}</tbody>
        </table>
        </div>
        <button type="button" class="secondary" id="mn-add-row" style="margin-top:8px">+ Add Line</button>
        <p class="tf-section-label">Calculated Totals <span class="tf-locked">Read only</span></p>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Package Count</label><input class="tf-input" readonly id="mn-total-packages" value="0"></div>
          <div class="tf-field"><label class="tf-label">Gross Weight (kg)</label><input class="tf-input" readonly id="mn-total-weight" value="0.000"></div>
          <div class="tf-field"><label class="tf-label">Volume (m&sup3;)</label><input class="tf-input" readonly id="mn-total-volume" value="0.000"></div>
        </div>
        <div id="mn-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="mn-cancel">Cancel</button>
        <button type="button" class="btn" id="mn-confirm">Create Shipment</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#mn-cancel").addEventListener("click", () => NexusModal.close());
    wireForwarderCascade(card, "mn-mode", "mn-name", forwarders);

    function recalcCargoTotals() {
      let totalWeight = 0, totalPackages = 0, totalVolume = 0;
      card.querySelectorAll("#mn-cargo-body tr").forEach((tr) => {
        const weight = Number(tr.querySelector(".mn-c-weight").value) || 0;
        const qty = Number(tr.querySelector(".mn-c-qty").value) || 0;
        const l = Number(tr.querySelector(".mn-c-length").value) || 0;
        const w = Number(tr.querySelector(".mn-c-width").value) || 0;
        const h = Number(tr.querySelector(".mn-c-height").value) || 0;
        totalWeight += weight;
        totalPackages += qty;
        if (l && w && h) totalVolume += (l * w * h) / 1000000;
      });
      card.querySelector("#mn-total-weight").value = totalWeight.toFixed(3);
      card.querySelector("#mn-total-packages").value = String(totalPackages);
      card.querySelector("#mn-total-volume").value = totalVolume.toFixed(3);
    }

    function wireCargoRow(tr) {
      tr.querySelector(".mn-c-remove").addEventListener("click", () => { tr.remove(); recalcCargoTotals(); });
      tr.querySelectorAll("input").forEach((input) => input.addEventListener("input", recalcCargoTotals));
    }
    card.querySelectorAll("#mn-cargo-body tr").forEach(wireCargoRow);

    card.querySelector("#mn-add-row").addEventListener("click", () => {
      const tbody = card.querySelector("#mn-cargo-body");
      tbody.insertAdjacentHTML("beforeend", cargoRowHtml({ id: nextCargoId++ }));
      wireCargoRow(tbody.lastElementChild);
    });

    // Destination search-as-you-type (client-side filter over the cached destinations list).
    const destInput = card.querySelector("#mn-dest-search");
    const destIdInput = card.querySelector("#mn-dest-id");
    const destResults = card.querySelector("#mn-dest-results");
    destInput.addEventListener("input", () => {
      const q = destInput.value.trim().toLowerCase();
      destIdInput.value = "";
      if (!q) { destResults.classList.add("hidden"); destResults.innerHTML = ""; return; }
      const matches = destinations.filter((d) => (d.destinationName || "").toLowerCase().includes(q)).slice(0, 20);
      if (!matches.length) { destResults.classList.add("hidden"); destResults.innerHTML = ""; return; }
      destResults.innerHTML = matches.map((d) => `<div class="mn-dest-option" data-id="${d.destinationId}" style="padding:8px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--border)">${esc(d.destinationName)} <span style="color:var(--text-muted)">— ${esc(d.destinationCountry || "")}</span></div>`).join("");
      destResults.classList.remove("hidden");
      destResults.querySelectorAll(".mn-dest-option").forEach((opt) => opt.addEventListener("click", () => {
        const d = destinations.find((x) => String(x.destinationId) === opt.dataset.id);
        destInput.value = d.destinationName || "";
        destIdInput.value = d.destinationId;
        card.querySelector("#mn-dest-street").value = d.destinationStreet || "";
        card.querySelector("#mn-dest-city").value = d.destinationCity || "";
        card.querySelector("#mn-dest-postcode").value = d.destinationPostCode || "";
        card.querySelector("#mn-dest-country").value = d.destinationCountry || "";
        card.querySelector("#mn-incoterms").value = d.defaultIncoterms || "";
        destResults.classList.add("hidden");
      }));
    });

    card.querySelector("#mn-confirm").addEventListener("click", () => submitManual(card));
  }

  async function submitManual(card) {
    const btn = card.querySelector("#mn-confirm");
    const result = card.querySelector("#mn-result");
    result.innerHTML = "";

    const destinationId = card.querySelector("#mn-dest-id").value;
    if (!destinationId) { result.innerHTML = '<div class="tf-inline-error">Select a destination from the dropdown list.</div>'; return; }

    const cargoRows = [...card.querySelectorAll("#mn-cargo-body tr")].map((tr) => ({
      description: tr.querySelector(".mn-c-desc").value.trim(),
      packageCount: Number(tr.querySelector(".mn-c-qty").value) || 1,
      weight: Number(tr.querySelector(".mn-c-weight").value) || 0,
      length: Number(tr.querySelector(".mn-c-length").value) || null,
      width: Number(tr.querySelector(".mn-c-width").value) || null,
      height: Number(tr.querySelector(".mn-c-height").value) || null,
    })).filter((r) => r.weight > 0);

    if (!cargoRows.length) { result.innerHTML = '<div class="tf-inline-error">Add at least one cargo line with a weight greater than 0.</div>'; return; }

    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const incoTerms = card.querySelector("#mn-incoterms").value.trim();
      const { data } = await shipmentApi("/create-manual", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationId: Number(destinationId),
          destinationStreet: card.querySelector("#mn-dest-street").value.trim(),
          destinationCity: card.querySelector("#mn-dest-city").value.trim(),
          destinationPostCode: card.querySelector("#mn-dest-postcode").value.trim(),
          destinationCountry: card.querySelector("#mn-dest-country").value.trim(),
          plannedCollection: card.querySelector("#mn-planned").value || null,
          forwarderId: card.querySelector("#mn-name").value || null,
          incoTerms,
          customsRequired: card.querySelector("#mn-customs-required").checked,
          customsComplete: false,
        }),
      });

      for (const row of cargoRows) {
        await shipmentApi(`/${data.shipmentId}/manual-cargo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) });
      }

      NexusModal.close();
      await load();
      showPostCreateModal(data.shipmentId, data.shipmentRef, null, isExWorks(incoTerms));
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Create Shipment";
    }
  }

  manualBtn.addEventListener("click", () => openManualModal());
  createBtn.addEventListener("click", () => openCreateModal());

  // ── Post-create action cards ───────────────────────────────────────────

  function showPostCreateModal(shipmentId, shipmentRef, folderPath, canSendEmail) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Shipment ${esc(shipmentRef)}</div><div class="ps-modal-sub">Shipment created successfully</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="lg-post-grid">
          <div class="lg-post-card">
            <div class="lg-post-title">Folder</div>
            <div class="nx-toolbar-hint" id="pc-folder-result">${esc(folderPath || "")}</div>
            <button type="button" class="secondary" id="pc-folder-btn">Create Folder</button>
          </div>
          <div class="lg-post-card">
            <div class="lg-post-title">Packing List</div>
            <div class="nx-toolbar-hint" id="pc-doc-result">Generate shipment and delivery PDFs.</div>
            <button type="button" class="secondary" id="pc-doc-btn">Create Packing List</button>
            <div id="pc-doc-links" class="lg-doc-links"></div>
          </div>
          <div class="lg-post-card${canSendEmail ? "" : " lg-post-card--muted"}">
            <div class="lg-post-title">Collection Email</div>
            <div class="nx-toolbar-hint" id="pc-email-result">${canSendEmail ? "Send Ex Works collection email with attachments." : "Available only for Ex Works shipments."}</div>
            <button type="button" class="secondary" id="pc-email-btn" ${canSendEmail ? "" : "disabled"}>Send Email</button>
          </div>
          <div class="lg-post-card">
            <div class="lg-post-title">Packaging Declaration</div>
            <div class="nx-toolbar-hint" id="pc-pkgdec-result">Generate a signed packaging declaration PDF.</div>
            <button type="button" class="secondary" id="pc-pkgdec-btn">Create Packaging Declaration</button>
            <div id="pc-pkgdec-links" class="lg-doc-links"></div>
          </div>
        </div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="btn" id="pc-done">Done</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pc-done").addEventListener("click", () => NexusModal.close());

    card.querySelector("#pc-folder-btn").addEventListener("click", () => runPostAction(card, shipmentId, "create-folder", "pc-folder-result"));
    card.querySelector("#pc-doc-btn").addEventListener("click", () => runPostAction(card, shipmentId, "generate-packing-list", "pc-doc-result", "pc-doc-links"));
    if (canSendEmail) card.querySelector("#pc-email-btn").addEventListener("click", () => runPostAction(card, shipmentId, "send-collection-email", "pc-email-result"));
    card.querySelector("#pc-pkgdec-btn").addEventListener("click", () => openPackagingDeclarationModal(shipmentId, card, "pc-pkgdec-result", "pc-pkgdec-links"));
  }

  async function runPostAction(card, shipmentId, action, resultId, linksId) {
    const result = card.querySelector(`#${resultId}`);
    result.textContent = "Working…";
    try {
      const { data } = await shipmentApi(`/${shipmentId}/${action}`, { method: "POST" });
      if (action === "create-folder") result.textContent = data.folderPath;
      else if (action === "send-collection-email") result.textContent = `Sent to ${data.sentTo}`;
      else if (linksId) {
        result.textContent = data.folderPath;
        card.querySelector(`#${linksId}`).innerHTML = (data.files || []).map((f) => `<a target="_blank" href="${esc(f.downloadUrl)}">${esc(f.fileName)}</a>`).join("");
      }
    } catch (err) {
      result.textContent = err.message;
    }
  }

  // ── Packaging Declaration sub-modal ────────────────────────────────────

  function openPackagingDeclarationModal(shipmentId, parentCard, resultId, linksId) {
    const card = NexusModal.open(`
      <div class="ps-modal-header"><div><div class="ps-modal-title">Packaging Declaration</div></div><button type="button" class="ps-modal-close" aria-label="Close">&times;</button></div>
      <div class="ps-modal-body">
        <p class="tf-section-label">Packaging Included In This Delivery</p>
        <div class="lg-flag-row" style="flex-wrap:wrap">
          <label class="lg-flag"><input type="checkbox" id="pkd-pallets"> Wooden pallets</label>
          <label class="lg-flag"><input type="checkbox" id="pkd-spools"> Wooden spools</label>
          <label class="lg-flag"><input type="checkbox" id="pkd-boxes"> Cardboard boxes</label>
          <label class="lg-flag"><input type="checkbox" id="pkd-bubblewrap"> Bubblewrap sheets</label>
        </div>
        <div id="pkd-packaging-warn" style="font-size:12px;color:var(--text-muted);margin-top:4px"></div>

        <p class="tf-section-label" style="margin-top:16px">Wood Packaging &amp; Shipment Statements</p>
        <div class="tf-row" style="align-items:center">
          <div style="flex:2;min-width:220px;font-size:12px;color:var(--text-muted)">ISPM 15 treatment/marking met (wooden pallets/spools)</div>
          <label class="lg-flag"><input type="radio" name="pkd-ispm15" id="pkd-ispm15-yes" value="yes"> Yes</label>
          <label class="lg-flag"><input type="radio" name="pkd-ispm15" id="pkd-ispm15-na" value="na" checked> N/A</label>
        </div>
        <div class="tf-row" style="align-items:center">
          <div style="flex:2;min-width:220px;font-size:12px;color:var(--text-muted)">No straw/hay/peat/chaff or used produce cartons used as dunnage</div>
          <label class="lg-flag"><input type="checkbox" id="pkd-dunnage" checked> Confirmed</label>
        </div>
        <div class="tf-row" style="align-items:center">
          <div style="flex:2;min-width:220px;font-size:12px;color:var(--text-muted)">Container clean, free of visible animal/plant material and soil</div>
          <label class="lg-flag"><input type="radio" name="pkd-container" id="pkd-container-yes" value="yes"> Yes</label>
          <label class="lg-flag"><input type="radio" name="pkd-container" id="pkd-container-na" value="na" checked> N/A</label>
        </div>

        <p class="tf-section-label" style="margin-top:16px">Authorised Signature</p>
        <div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Position / Job Title</label><input class="tf-input" type="text" id="pkd-position" placeholder="e.g. Logistics &amp; Systems Specialist"></div></div>
        <div id="pkd-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="pkd-cancel">Cancel</button>
        <button type="button" class="btn" id="pkd-confirm">Generate</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pkd-cancel").addEventListener("click", () => NexusModal.close());

    const woodBoxes = [card.querySelector("#pkd-pallets"), card.querySelector("#pkd-spools")];
    const syncIspm15Default = () => {
      if (woodBoxes.some((cb) => cb.checked)) card.querySelector("#pkd-ispm15-yes").checked = true;
      else card.querySelector("#pkd-ispm15-na").checked = true;
    };
    woodBoxes.forEach((cb) => cb.addEventListener("change", syncIspm15Default));

    card.querySelector("#pkd-confirm").addEventListener("click", async () => {
      const packaging = {
        woodenPallets: card.querySelector("#pkd-pallets").checked,
        woodenSpools: card.querySelector("#pkd-spools").checked,
        cardboardBoxes: card.querySelector("#pkd-boxes").checked,
        bubblewrapSheets: card.querySelector("#pkd-bubblewrap").checked,
      };
      const warn = card.querySelector("#pkd-packaging-warn");
      if (!Object.values(packaging).some(Boolean)) { warn.textContent = "Select at least one packaging type used for this delivery."; return; }
      warn.textContent = "";

      const position = card.querySelector("#pkd-position").value.trim();
      const result = card.querySelector("#pkd-result");
      if (!position) { result.innerHTML = '<div class="tf-inline-error">Position / job title is required to sign the declaration.</div>'; return; }

      const btn = card.querySelector("#pkd-confirm");
      btn.disabled = true; btn.textContent = "Generating…"; result.innerHTML = "";
      try {
        const payload = {
          packaging,
          ispm15: card.querySelector("#pkd-ispm15-yes").checked ? "yes" : "na",
          dunnageConfirmed: card.querySelector("#pkd-dunnage").checked,
          containerClean: card.querySelector("#pkd-container-yes").checked ? "yes" : "na",
          position,
        };
        const { data } = await shipmentApi(`/${shipmentId}/generate-packaging-declaration`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        NexusModal.close();
        const resultEl = parentCard.querySelector(`#${resultId}`);
        const linksEl = parentCard.querySelector(`#${linksId}`);
        if (resultEl) resultEl.textContent = data.folderPath;
        if (linksEl) linksEl.innerHTML = (data.files || []).map((f) => `<a target="_blank" href="${esc(f.downloadUrl)}">${esc(f.fileName)}</a>`).join("");
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Generate";
      }
    });
  }

  load();
})();
