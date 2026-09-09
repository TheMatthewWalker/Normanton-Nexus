// Shared OUTBOUND shipment detail modal — port of private/js/logistics.js's
// openShipmentDetailModal/renderShipmentDetailModal family (the real "click
// a shipment reference" popup: customer card, packaging card, haulier +
// customs actions, dates & status corrections, associated costs, event log,
// and a Modify Deliveries panel). Distinct from window.ShipmentDetailModal
// (wwwroot/js/logistics/shipment-detail.js), which is the INBOUND (Order
// Suggestions/Inbound Log) shipment popup — different table, different shape.
//
// Usage: window.OutboundShipmentDetail.open(shipmentId, onChange) — onChange
// (no args) is called after any action that could change the shipment's own
// bucket/status, so the caller's own list can refresh; this module never
// assumes which queue page it was opened from.
//
// Deliberate simplifications relative to Node, matching this migration's own
// "simplified frontend, real backend already accepts the fuller shape"
// precedent (see shipment-booking.js's own header comment for the same
// reasoning applied to the bulk booking modal):
//   - Booking a single shipment from here reuses the same ShipmentBooking
//     modal the bulk queues use, rather than porting Node's separate
//     lighter-weight single-booking flow (its own inline KN cost-estimate/
//     document-categorisation sub-screen). One booking UI, not two.
//   - Haulier assignment is one "Name (Mode)" dropdown built straight from
//     /api/forwarders/approved, rather than Node's two-step name-then-mode
//     cascade over the raw (non-deduplicated) forwarder list — the same
///    forwarderID ends up saved either way.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const deliveryApi = NexusApi.make("/api/deliverymain");
  const costApi = NexusApi.make("/api/shipmentcost");
  const refApi = NexusApi.make("/api");

  function normalizeHaulierName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function isExWorksIncoterms(value) { const n = String(value || "").trim().toUpperCase().replace(/\s+/g, ""); return n === "EXW" || n === "EXWORKS"; }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-GB") : "—"; }
  function fmtDateInput(d) { return d ? String(d).slice(0, 10) : ""; }

  async function open(shipmentId, onChange) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Shipment</div><div class="ps-modal-sub">Loading…</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body" id="sd-body"><div class="nx-toolbar-hint">Loading…</div></div>`, { size: "xwide" });
    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    await refresh(card, shipmentId, onChange);
  }

  async function refresh(card, shipmentId, onChange) {
    const notifyChange = () => { if (onChange) onChange(); };
    const body = card.querySelector("#sd-body");
    try {
      const { data } = await api(`/${shipmentId}/details`);
      const shipment = data.shipment;
      const deliveries = data.deliveries || [];
      renderMain(card, shipment, deliveries, shipmentId, notifyChange, onChange);
    } catch (err) {
      body.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function renderMain(card, shipment, deliveries, shipmentId, notifyChange, onChange) {
    const body = card.querySelector("#sd-body");
    const ref = String(shipment.shipmentId).padStart(8, "0");
    const isExw = isExWorksIncoterms(shipment.incoTerms);
    const customsComplete = Boolean(shipment.customsComplete);
    const customsRequired = Boolean(shipment.customsRequired);
    const canBook = !shipment.bookingStatus && !shipment.shipmentCancelled;
    const plannedStr = fmtDate(shipment.plannedCollection || shipment.plannedDelivery);

    card.querySelector(".ps-modal-title").textContent = `Shipment ${ref}`;
    card.querySelector(".ps-modal-sub").textContent = `${shipment.destinationName || ""} — ${shipment.incoTerms || "—"} — Planned ${plannedStr}`;

    const customsToggleDisabled = customsComplete;
    const customsToggleHtml = `<div class="sd-toggle-group">
      <button type="button" class="sd-toggle-btn${!customsRequired ? " sd-toggle-btn--active" : ""}" id="sd-customs-notreq-btn" data-target="false" ${customsToggleDisabled ? "disabled" : ""}>Not Required</button>
      <button type="button" class="sd-toggle-btn${customsRequired ? " sd-toggle-btn--active" : ""}" id="sd-customs-req-btn" data-target="true" ${customsToggleDisabled ? "disabled" : ""}>Required</button>
    </div>`;

    body.innerHTML = `
      <div class="sd-grid">
        <div class="sd-section">
          <div class="sd-section-title">Customer</div>
          <table class="sd-contact-table">
            <tr><td>Delivery To</td><td>${esc(shipment.destinationName || "—")}</td></tr>
            <tr><td>Incoterms</td><td>${esc(shipment.incoTerms || "—")}</td></tr>
            <tr><td>Address</td><td>${esc([shipment.destinationStreet, shipment.destinationCity, shipment.destinationPostCode, shipment.destinationCountry].filter(Boolean).join(", ") || "—")}</td></tr>
            <tr><td>Email</td><td class="sd-contact-email" id="sd-contact-email">Loading…</td></tr>
          </table>
        </div>
        <div class="sd-section">
          <div class="sd-section-title">Actions</div>
          <div class="sd-actions-cols">
            <div>
              <div class="sd-actions-subtitle">Haulier</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Current: <strong>${esc(shipment.forwarderName || "Unassigned")}${shipment.forwarderMode ? ` (${esc(shipment.forwarderMode)})` : ""}</strong></div>
              <div class="sd-haulier-row">
                <select class="tf-input" id="sd-forwarder-select"><option value="">Loading…</option></select>
                <button type="button" class="secondary" id="sd-forwarder-save" style="padding:6px 10px;font-size:11px">Save</button>
              </div>
              <span id="sd-forwarder-result" style="font-size:11.5px;color:var(--text-muted)"></span>
              <div class="sd-actions-subtitle" style="margin-top:12px">Customs</div>
              <div class="sd-customs-row">
                ${customsToggleHtml}
                ${customsComplete ? `<span class="sd-badge sd-badge--complete">Complete</span>` : ""}
              </div>
              <span id="sd-customs-result" style="font-size:11.5px;color:var(--error)"></span>
              ${shipment.customsId ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text-muted)">Customs ID: ${esc(String(shipment.customsId))}</div>` : ""}
            </div>
            <div class="sd-actions">
              <button type="button" class="secondary" id="sd-packing-list-btn">Recreate Packing List</button>
              <div id="sd-packing-list-result" style="font-size:11.5px;color:var(--text-muted)"></div>
              ${isExw ? `<button type="button" class="secondary" id="sd-email-btn">Resend Collection Email</button><div id="sd-email-result" style="font-size:11.5px;color:var(--text-muted)"></div>` : ""}
              ${!shipment.isManual ? `<button type="button" class="secondary" id="sd-deliveries-btn">Modify Deliveries &rarr;</button>` : ""}
              <button type="button" class="secondary" id="sd-eventlog-btn">Event Log</button>
            </div>
          </div>
        </div>
      </div>
      <div class="sd-grid">
        <div class="sd-section">
          <div class="sd-section-title">Packaging</div>
          <div class="sd-pkg-totals">
            <span>Net <strong>${shipment.netWeight != null ? Number(shipment.netWeight).toFixed(1) : "—"} kg</strong></span>
            <span>Gross <strong>${shipment.grossWeight != null ? Number(shipment.grossWeight).toFixed(1) : "—"} kg</strong></span>
            <span>Volume <strong>${shipment.shipmentVolume != null ? Number(shipment.shipmentVolume).toFixed(3) : "—"} m&sup3;</strong></span>
            <span>Pallets <strong>${esc(String(shipment.palletCount ?? "—"))}</strong></span>
          </div>
          <div class="sd-pkg-list" id="sd-pkg-list"><div class="sd-pcard-empty">Loading…</div></div>
        </div>
        <div class="sd-section">
          <div class="sd-section-title">Dates &amp; Status</div>
          <div class="sd-ds-cols">
            <div class="sd-ds-grid">
              <label class="sd-ds-check"><input type="checkbox" id="sd-ds-booking" ${shipment.bookingStatus ? "checked" : ""}> Booked</label>
              <div class="sd-ds-field"><label>Planned Collection</label><input class="tf-input" type="date" id="sd-ds-plan-col" value="${fmtDateInput(shipment.plannedCollection)}"></div>
              <label class="sd-ds-check"><input type="checkbox" id="sd-ds-col-status" ${shipment.collectionStatus ? "checked" : ""}> Collected</label>
              <div class="sd-ds-field"><label>Actual Collection</label><input class="tf-input" type="date" id="sd-ds-act-col" value="${fmtDateInput(shipment.actualCollection)}"></div>
            </div>
            <div class="sd-ds-grid">
              <label class="sd-ds-check"><input type="checkbox" id="sd-ds-del-status" ${shipment.deliveryStatus ? "checked" : ""}> Delivered</label>
              <div class="sd-ds-field"><label>Planned Delivery</label><input class="tf-input" type="date" id="sd-ds-plan-del" value="${fmtDateInput(shipment.plannedDelivery)}"></div>
              <div class="sd-ds-field"><label>Actual Delivery</label><input class="tf-input" type="date" id="sd-ds-act-del" value="${fmtDateInput(shipment.actualDelivery)}"></div>
            </div>
          </div>
          <button type="button" class="secondary" id="sd-ds-save-btn" style="margin-top:10px;width:100%">Save Corrections</button>
          <div id="sd-ds-result" style="margin-top:6px;font-size:11.5px"></div>
        </div>
      </div>
      <div class="sd-section" style="margin-bottom:6px">
        <div class="sd-section-title">Associated Costs</div>
        <div id="sd-costs"><div class="nx-toolbar-hint">Loading…</div></div>
      </div>
      <div id="sd-eventlog" class="hidden" style="margin-top:12px"></div>`;

    card.querySelector("#sd-forwarder-save").addEventListener("click", () => saveForwarder(card, shipmentId, onChange));
    card.querySelector("#sd-packing-list-btn").addEventListener("click", () => generatePackingList(card, shipmentId));
    const emailBtn = card.querySelector("#sd-email-btn");
    if (emailBtn) emailBtn.addEventListener("click", () => resendCollectionEmail(card, shipmentId));
    const deliveriesBtn = card.querySelector("#sd-deliveries-btn");
    if (deliveriesBtn) deliveriesBtn.addEventListener("click", () => openDeliveriesPanel(card, shipment, deliveries, onChange));
    card.querySelector("#sd-eventlog-btn").addEventListener("click", () => toggleEventLog(card, shipmentId));
    card.querySelectorAll("#sd-customs-req-btn, #sd-customs-notreq-btn").forEach((btn) => {
      btn.addEventListener("click", () => saveCustomsRequired(card, shipment, btn.dataset.target === "true", onChange));
    });
    card.querySelector("#sd-ds-save-btn").addEventListener("click", () => saveDatesStatus(card, shipmentId, onChange));

    if (canBook) {
      const actions = card.querySelector(".sd-actions");
      const bookBtn = document.createElement("button");
      bookBtn.type = "button"; bookBtn.className = "btn"; bookBtn.textContent = "Book";
      bookBtn.addEventListener("click", () => {
        NexusModal.close();
        ShipmentBooking.open([shipment], () => { notifyChange(); });
      });
      actions.prepend(bookBtn);
    }

    loadContactEmail(card, shipment);
    loadPackagingList(card, shipment, deliveries);
    loadForwarderSelect(card, shipment);
    loadAssociatedCosts(card, shipmentId, notifyChange);
  }

  async function loadContactEmail(card, shipment) {
    const el = card.querySelector("#sd-contact-email");
    if (!el || !shipment.destinationId) { if (el) el.textContent = "—"; return; }
    try {
      const { data } = await refApi(`/destinations/${shipment.destinationId}/emails`);
      const addresses = data || [];
      el.textContent = addresses.length ? addresses.join(", ") : "—";
    } catch { el.textContent = "—"; }
  }

  async function loadPackagingList(card, shipment, deliveries) {
    const list = card.querySelector("#sd-pkg-list");
    if (!list) return;
    try {
      if (shipment.isManual) {
        const { data } = await api(`/${shipment.shipmentId}/manual-cargo`);
        const lines = data || [];
        list.innerHTML = lines.length === 0 ? '<div class="sd-pcard-empty">No cargo lines recorded.</div>' : lines.map((c) => {
          const dims = [c.length, c.width, c.height].filter(Boolean).join("x");
          const label = [c.packageCount > 1 ? `${c.packageCount}x` : null, c.description].filter(Boolean).join(" ") || "Cargo";
          return `<div class="sd-pkg-item"><span>${esc(label)}</span><span>${dims ? `${esc(dims)}cm @ ` : ""}${Number(c.weight ?? 0).toFixed(1)} KG</span></div>`;
        }).join("");
        return;
      }
      if (!deliveries.length) { list.innerHTML = '<div class="sd-pcard-empty">No pallets linked to this shipment.</div>'; return; }
      const results = await Promise.all(deliveries.map((d) => deliveryApi(`/${d.deliveryId}/pallets`).then((r) => r.data || []).catch(() => [])));
      const pallets = results.flat();
      list.innerHTML = pallets.length === 0 ? '<div class="sd-pcard-empty">No pallets linked to this shipment.</div>' : pallets.map((p) => {
        const dims = [p.palletLength, p.palletWidth, p.palletHeight].filter(Boolean).join("x");
        const wt = p.grossWeight != null ? Number(p.grossWeight).toFixed(1) : "—";
        return `<div class="sd-pkg-item"><span>${esc(p.palletType || "Pallet")}</span><span>${dims ? `${esc(dims)}cm @ ` : ""}${wt} KG</span></div>`;
      }).join("");
    } catch (err) {
      list.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function loadForwarderSelect(card, shipment) {
    const sel = card.querySelector("#sd-forwarder-select");
    if (!sel) return;
    try {
      const { data } = await refApi("/forwarders/approved");
      const forwarders = data || [];
      sel.innerHTML = `<option value="">Unassigned</option>` + forwarders.map((f) =>
        `<option value="${f.forwarderId}" ${shipment.forwarderId === f.forwarderId ? "selected" : ""}>${esc(f.forwarderName)}${f.forwarderMode ? ` (${esc(f.forwarderMode)})` : ""}</option>`).join("");
    } catch {
      sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  async function saveForwarder(card, shipmentId, onChange) {
    const sel = card.querySelector("#sd-forwarder-select");
    const result = card.querySelector("#sd-forwarder-result");
    result.textContent = "Saving…";
    try {
      await api(`/${shipmentId}/forwarder`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forwarderId: sel.value ? Number(sel.value) : null }) });
      result.textContent = "Saved.";
      if (onChange) onChange();
    } catch (err) { result.textContent = err.message; }
  }

  async function saveCustomsRequired(card, shipment, target, onChange) {
    if (target === Boolean(shipment.customsRequired)) return;
    const result = card.querySelector("#sd-customs-result");
    card.querySelectorAll("#sd-customs-req-btn, #sd-customs-notreq-btn").forEach((b) => { b.disabled = true; });
    try {
      await api("/customs-required/bulk", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds: [shipment.shipmentId], required: target }) });
      if (onChange) onChange();
      await refresh(card, shipment.shipmentId, onChange);
    } catch (err) {
      result.textContent = err.message;
      card.querySelectorAll("#sd-customs-req-btn, #sd-customs-notreq-btn").forEach((b) => { b.disabled = Boolean(shipment.customsComplete); });
    }
  }

  async function saveDatesStatus(card, shipmentId, onChange) {
    const btn = card.querySelector("#sd-ds-save-btn");
    const result = card.querySelector("#sd-ds-result");
    const val = (id) => card.querySelector(`#${id}`)?.value || null;
    const chk = (id) => Boolean(card.querySelector(`#${id}`)?.checked);
    btn.disabled = true; btn.textContent = "Saving…"; result.textContent = "";
    try {
      await api(`/${shipmentId}/status-dates`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingStatus: chk("sd-ds-booking"), plannedCollection: val("sd-ds-plan-col"),
          collectionStatus: chk("sd-ds-col-status"), actualCollection: val("sd-ds-act-col"),
          plannedDeliverySet: true, plannedDelivery: val("sd-ds-plan-del"),
          deliveryStatus: chk("sd-ds-del-status"), actualDelivery: val("sd-ds-act-del"),
        }),
      });
      if (onChange) onChange();
      await refresh(card, shipmentId, onChange);
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Save Corrections";
    }
  }

  async function generatePackingList(card, shipmentId) {
    const btn = card.querySelector("#sd-packing-list-btn");
    const result = card.querySelector("#sd-packing-list-result");
    if (!(await NexusModal.confirm("This overwrites any existing packing-list files for this shipment. Continue?", { confirmLabel: "Generate" }))) return;
    btn.disabled = true; result.textContent = "Generating…";
    try {
      const { data } = await api(`/${shipmentId}/generate-packing-list`, { method: "POST" });
      result.innerHTML = (data.files || []).map((f) => `<a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">${esc(f.fileName)}</a>`).join(" ");
    } catch (err) {
      result.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function resendCollectionEmail(card, shipmentId) {
    const btn = card.querySelector("#sd-email-btn");
    const result = card.querySelector("#sd-email-result");
    btn.disabled = true; result.textContent = "Sending…";
    try {
      await api(`/${shipmentId}/send-collection-email`, { method: "POST" });
      result.textContent = "Sent.";
    } catch (err) {
      result.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function toggleEventLog(card, shipmentId) {
    const el = card.querySelector("#sd-eventlog");
    if (!el.classList.contains("hidden")) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.remove("hidden");
    el.innerHTML = '<div class="sd-section"><div class="sd-section-title">Event Log</div><div class="nx-toolbar-hint">Loading…</div></div>';
    try {
      const { data } = await api(`/${shipmentId}/events`);
      const rows = data || [];
      el.innerHTML = `<div class="sd-section"><div class="sd-section-title">Event Log</div>${
        rows.length === 0 ? '<div class="sd-pcard-empty">No events recorded.</div>' : `<div class="sd-scroll"><table><thead><tr><th>When</th><th>Category</th><th>Description</th></tr></thead><tbody>${
          rows.map((r) => `<tr><td style="white-space:nowrap">${new Date(r.timeStamp).toLocaleString("en-GB")}</td><td>${esc(r.eventCategory)}</td><td>${esc(r.eventDescription)}</td></tr>`).join("")
        }</tbody></table></div>`
      }</div>`;
    } catch (err) {
      el.innerHTML = `<div class="sd-section"><div class="tf-inline-error">${esc(err.message)}</div></div>`;
    }
  }

  // ── Associated Costs (full CRUD) ────────────────────────────────────────

  async function loadAssociatedCosts(card, shipmentId, notifyChange) {
    const container = card.querySelector("#sd-costs");
    if (!container) return;
    try {
      const { data } = await costApi(`/shipment/${shipmentId}`);
      const lines = data || [];
      const rows = lines.map((l) => `
        <tr>
          <td>${esc(l.elementDescription || l.costElement || "—")}</td>
          <td style="font-family:'JetBrains Mono',monospace">${esc(l.costType || "—")}</td>
          <td>£${Number(l.expectedCost).toFixed(2)}</td>
          <td>${l.migoStatus ? `<span style="color:var(--success)">Posted — ${esc(l.materialDocument || "")}</span>` : '<span style="color:var(--text-muted)">Pending</span>'}</td>
          <td style="white-space:nowrap">${l.migoStatus
            ? `<button type="button" class="secondary sd-cost-reverse" data-id="${l.costId}" style="padding:2px 8px;font-size:11px">Reverse</button>`
            : `<button type="button" class="secondary sd-cost-edit" data-id="${l.costId}" style="padding:2px 8px;font-size:11px">Edit</button>
               <button type="button" class="secondary sd-cost-delete" data-id="${l.costId}" style="padding:2px 8px;font-size:11px">Remove</button>`}</td>
        </tr>`).join("");

      container.innerHTML = `
        <div class="sd-scroll"><table><thead><tr><th>GL Element</th><th>Cost Type</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="color:var(--text-muted)">No cost lines yet.</td></tr>'}</tbody></table></div>
        <div class="tf-row" style="margin-top:10px">
          <div class="tf-field"><label class="tf-label">GL Account</label><select class="tf-input" id="sd-cost-element"><option>Loading…</option></select></div>
          <div class="tf-field"><label class="tf-label">Cost Type</label><select class="tf-input" id="sd-cost-type"><option value="">Loading…</option></select></div>
          <div class="tf-field"><label class="tf-label">Cost Centre</label><select class="tf-input" id="sd-cost-center"><option>Loading…</option></select></div>
          <div class="tf-field"><label class="tf-label">Amount (£)</label><input class="tf-input" type="number" step="0.01" min="0.01" id="sd-cost-amount"></div>
          <div class="tf-field" style="justify-content:flex-end"><button type="button" class="secondary" id="sd-cost-add-btn">+ Add Cost</button></div>
        </div>
        <div id="sd-cost-result" style="margin-top:6px;font-size:11.5px"></div>`;

      refApi("/costelements").then(({ data }) => {
        const sel = card.querySelector("#sd-cost-element");
        if (!sel) return;
        const outbound = (data || []).filter((e) => e.direction === "outbound");
        sel.innerHTML = outbound.map((e) => `<option value="${esc(e.elementCode)}">${esc(e.elementCode)} — ${esc(e.elementDescription || "")}</option>`).join("");
        if (outbound.some((e) => e.elementCode === "601200")) sel.value = "601200";
      }).catch(() => {});

      refApi("/costtypes").then(({ data }) => {
        const sel = card.querySelector("#sd-cost-type");
        if (!sel) return;
        sel.innerHTML = `<option value="">— Select —</option>` + (data || []).map((t) => `<option value="${esc(String(t.typeId))}">${esc(String(t.typeId))} — ${esc(t.typeDescription || "")}</option>`).join("");
      }).catch(() => {});

      refApi("/costcenters").then(({ data }) => {
        const sel = card.querySelector("#sd-cost-center");
        if (!sel) return;
        const centres = data || [];
        sel.innerHTML = centres.map((c) => `<option value="${esc(c.centerCode || "")}">${esc(c.centerCode || "")} — ${esc(c.centerDescription || "")}</option>`).join("");
        if (centres.some((c) => c.centerCode === "0000002004")) sel.value = "0000002004";
      }).catch(() => {});

      card.querySelector("#sd-cost-add-btn").addEventListener("click", () => addCost(card, shipmentId, lines, notifyChange));
      card.querySelectorAll(".sd-cost-edit").forEach((b) => b.addEventListener("click", () => {
        const line = lines.find((l) => String(l.costId) === b.dataset.id);
        if (line) openCostEditModal(card, line, shipmentId, notifyChange);
      }));
      card.querySelectorAll(".sd-cost-delete").forEach((b) => b.addEventListener("click", () => deleteCost(card, b.dataset.id, shipmentId, notifyChange)));
      card.querySelectorAll(".sd-cost-reverse").forEach((b) => b.addEventListener("click", () => reverseCost(card, b, shipmentId, notifyChange)));
    } catch (err) {
      container.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function addCost(card, shipmentId, lines, notifyChange) {
    const btn = card.querySelector("#sd-cost-add-btn");
    const result = card.querySelector("#sd-cost-result");
    const costElement = card.querySelector("#sd-cost-element").value;
    const costType = card.querySelector("#sd-cost-type").value;
    const costCenter = card.querySelector("#sd-cost-center").value;
    const amount = Number(card.querySelector("#sd-cost-amount").value);
    if (!costElement) { result.innerHTML = '<div class="tf-inline-error">Select a GL Account.</div>'; return; }
    if (!costType) { result.innerHTML = '<div class="tf-inline-error">Select a Cost Type.</div>'; return; }
    if (!costCenter) { result.innerHTML = '<div class="tf-inline-error">Select a Cost Centre.</div>'; return; }
    if (!amount || amount <= 0) { result.innerHTML = '<div class="tf-inline-error">Enter an amount greater than 0.</div>'; return; }
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      await costApi("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentId, costType, costElement, costCenter, expectedCost: amount }) });
      notifyChange();
      await loadAssociatedCosts(card, shipmentId, notifyChange);
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "+ Add Cost";
    }
  }

  async function deleteCost(card, costId, shipmentId, notifyChange) {
    if (!(await NexusModal.confirm("Remove this cost line?", { danger: true, confirmLabel: "Remove" }))) return;
    try {
      await costApi(`/${costId}`, { method: "DELETE" });
      notifyChange();
      await loadAssociatedCosts(card, shipmentId, notifyChange);
    } catch (err) {
      card.querySelector("#sd-cost-result").innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function reverseCost(card, btn, shipmentId, notifyChange) {
    if (!(await NexusModal.confirm("Reverse this posting in SAP? This creates a reversing material document — the line drops back into Unprocessed Costs.", { danger: true, confirmLabel: "Reverse" }))) return;
    btn.disabled = true; btn.textContent = "Reversing…";
    try {
      await costApi(`/${btn.dataset.id}/reverse`, { method: "POST" });
      notifyChange();
      await loadAssociatedCosts(card, shipmentId, notifyChange);
    } catch (err) {
      card.querySelector("#sd-cost-result").innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Reverse";
    }
  }

  function openCostEditModal(parentCard, line, shipmentId, notifyChange) {
    const editCard = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Edit Cost</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">GL Account</label><select class="tf-input" id="sce-element"></select></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Cost Type</label><select class="tf-input" id="sce-type"><option value="">Loading…</option></select></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Cost Centre</label><select class="tf-input" id="sce-center"></select></div>
          <div class="tf-field"><label class="tf-label">Amount (£)</label><input class="tf-input" type="number" step="0.01" min="0.01" id="sce-amount" value="${esc(String(line.expectedCost))}"></div>
        </div>
        <div id="sce-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="sce-cancel">Cancel</button>
        <button type="button" class="btn" id="sce-save">Save Changes</button>
      </div>`);

    editCard.querySelector(".ps-modal-close").addEventListener("click", () => reopenParent());
    editCard.querySelector("#sce-cancel").addEventListener("click", () => reopenParent());
    function reopenParent() { NexusModal.close(); }

    refApi("/costelements").then(({ data }) => {
      const sel = editCard.querySelector("#sce-element");
      const outbound = (data || []).filter((e) => e.direction === "outbound");
      sel.innerHTML = outbound.map((e) => `<option value="${esc(e.elementCode)}">${esc(e.elementCode)} — ${esc(e.elementDescription || "")}</option>`).join("");
      if (outbound.some((e) => e.elementCode === line.costElement)) sel.value = line.costElement;
    }).catch(() => {});
    refApi("/costtypes").then(({ data }) => {
      const sel = editCard.querySelector("#sce-type");
      sel.innerHTML = `<option value="">— Select —</option>` + (data || []).map((t) => `<option value="${esc(String(t.typeId))}">${esc(String(t.typeId))} — ${esc(t.typeDescription || "")}</option>`).join("");
      if ((data || []).some((t) => String(t.typeId) === String(line.costType))) sel.value = String(line.costType);
    }).catch(() => {});
    refApi("/costcenters").then(({ data }) => {
      const sel = editCard.querySelector("#sce-center");
      sel.innerHTML = (data || []).map((c) => `<option value="${esc(c.centerCode || "")}">${esc(c.centerCode || "")} — ${esc(c.centerDescription || "")}</option>`).join("");
      if ((data || []).some((c) => c.centerCode === line.costCenter)) sel.value = line.costCenter;
    }).catch(() => {});

    editCard.querySelector("#sce-save").addEventListener("click", async () => {
      const btn = editCard.querySelector("#sce-save");
      const result = editCard.querySelector("#sce-result");
      const elementSel = editCard.querySelector("#sce-element");
      const typeSel = editCard.querySelector("#sce-type");
      const centerSel = editCard.querySelector("#sce-center");
      const amount = Number(editCard.querySelector("#sce-amount").value);
      if (!elementSel.value) { result.innerHTML = '<div class="tf-inline-error">Select a GL Account.</div>'; return; }
      if (!typeSel.value) { result.innerHTML = '<div class="tf-inline-error">Select a Cost Type.</div>'; return; }
      if (!centerSel.value) { result.innerHTML = '<div class="tf-inline-error">Select a Cost Centre.</div>'; return; }
      if (!amount || amount <= 0) { result.innerHTML = '<div class="tf-inline-error">Enter a valid amount.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await costApi(`/${line.costId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedCost: amount, costElement: elementSel.value, costType: typeSel.value, costCenter: centerSel.value }) });
        notifyChange();
        await open(shipmentId, notifyChange);
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Save Changes";
      }
    });
  }

  // ── Modify Deliveries panel ──────────────────────────────────────────────

  async function openDeliveriesPanel(card, shipment, deliveries, onChange) {
    renderDeliveriesPanel(card, shipment, deliveries, [], false, null, onChange);
    try {
      const { data } = await deliveryApi(`/available-for-shipment/${shipment.destinationId}`);
      renderDeliveriesPanel(card, shipment, deliveries, data || [], true, null, onChange);
    } catch (err) {
      renderDeliveriesPanel(card, shipment, deliveries, [], true, err.message, onChange);
    }
  }

  function renderDeliveriesPanel(card, shipment, deliveries, available, loaded, availError, onChange) {
    const ref = String(shipment.shipmentId).padStart(8, "0");
    const totals = deliveries.reduce((acc, d) => {
      acc.gross += Number(d.grossWeight || 0); acc.net += Number(d.netWeight || 0);
      acc.pallets += Number(d.palletCount || 0); acc.volume += Number(d.deliveryVolume || 0);
      return acc;
    }, { gross: 0, net: 0, pallets: 0, volume: 0 });

    const linkedRows = deliveries.map((d) => `<tr>
      <td>${esc(String(d.deliveryId))}</td>
      <td>${esc(d.destinationName || d.deliveryService || "—")}</td>
      <td>${Number(d.grossWeight || 0).toFixed(3)}</td>
      <td>${Number(d.netWeight || 0).toFixed(3)}</td>
      <td>${Number(d.deliveryVolume || 0).toFixed(3)}</td>
      <td>${Number(d.palletCount || 0).toFixed(0)}</td>
      <td class="nx-comment-cell" title="${esc(d.picksheetComment || "")}">${esc(d.picksheetComment || "—")}</td>
      <td><button type="button" class="sd-remove-btn" data-id="${esc(String(d.deliveryId))}">Remove</button></td>
    </tr>`).join("");
    const totalsRow = `<tr class="sd-totals-row"><td colspan="2">Total</td><td>${totals.gross.toFixed(3)}</td><td>${totals.net.toFixed(3)}</td><td>${totals.volume.toFixed(3)}</td><td>${totals.pallets.toFixed(0)}</td><td></td><td></td></tr>`;
    const linkedHtml = deliveries.length
      ? `<div class="sd-scroll"><table class="sd-delivery-table"><thead><tr><th>Delivery</th><th>Destination</th><th>Gross kg</th><th>Net kg</th><th>Vol CBM</th><th>Pallets</th><th>Comment</th><th></th></tr></thead><tbody>${linkedRows}${totalsRow}</tbody></table></div>`
      : '<div class="sd-picker-empty">No deliveries linked.</div>';

    let availHtml;
    if (!loaded) {
      availHtml = '<div class="nx-toolbar-hint">Loading…</div>';
    } else if (availError) {
      availHtml = `<div class="tf-inline-error">${esc(availError)}</div>`;
    } else if (!available.length) {
      availHtml = '<div class="sd-picker-empty">No available deliveries for this customer.</div>';
    } else {
      const shipmentTerms = String(shipment.incoTerms || "").trim().toUpperCase();
      const availRows = available.map((d) => {
        const effectiveTerm = String(d.incoterms || d.defaultIncoterms || "").trim().toUpperCase();
        const conflicts = shipmentTerms && effectiveTerm && effectiveTerm !== shipmentTerms;
        return `<tr${conflicts ? ' style="opacity:0.45" title="Incoterms mismatch"' : ""}>
          <td><input type="checkbox" class="sd-avail-check" data-id="${esc(String(d.deliveryId))}" ${conflicts ? "disabled" : ""}></td>
          <td>${esc(String(d.deliveryId))}</td>
          <td>${esc(d.destinationName || d.deliveryService || "—")}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(effectiveTerm || "—")}</td>
          <td>${Number(d.grossWeight || 0).toFixed(3)}</td>
          <td>${Number(d.palletCount || 0).toFixed(0)}</td>
          <td class="nx-comment-cell" title="${esc(d.picksheetComment || "")}">${esc(d.picksheetComment || "—")}</td>
        </tr>`;
      }).join("");
      availHtml = `<div class="sd-scroll"><table class="sd-delivery-table"><thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Incoterms</th><th>Gross kg</th><th>Pallets</th><th>Comment</th></tr></thead><tbody>${availRows}</tbody></table></div>
        <div class="sd-picker-actions"><button type="button" class="btn" id="sd-add-btn">Add Selected</button></div>
        <div id="sd-add-result" style="font-size:11.5px;color:var(--error);margin-top:6px"></div>`;
    }

    card.querySelector("#sd-body").innerHTML = `
      <div class="sd-wide-grid">
        <div><div class="sd-picker-title">Linked Deliveries</div>${linkedHtml}<div id="sd-remove-result" style="font-size:11.5px;color:var(--error);margin-top:8px"></div></div>
        <div><div class="sd-picker-title">Add Deliveries</div>${availHtml}</div>
      </div>
      <div class="ps-modal-actions" style="padding:14px 0 0;border-top:1px solid var(--border);margin-top:16px">
        <button type="button" class="secondary" id="sd-back-btn">&larr; Back</button>
      </div>`;
    card.querySelector(".ps-modal-title").textContent = `Deliveries — Shipment ${ref}`;
    card.querySelector(".ps-modal-sub").textContent = shipment.destinationName || "";

    card.querySelector("#sd-back-btn").addEventListener("click", () => refresh(card, shipment.shipmentId, onChange));
    card.querySelectorAll(".sd-remove-btn").forEach((btn) => btn.addEventListener("click", async () => {
      const deliveryId = btn.dataset.id;
      const isLast = deliveries.length === 1;
      let msg = isLast ? "This is the last delivery — removing it will cancel the entire shipment. Continue?" : "Remove this delivery from the shipment?";
      if (shipment.customsComplete) msg = "Customs is already complete for this shipment — removing this delivery may require re-submission. " + msg;
      if (!(await NexusModal.confirm(msg, { danger: true, confirmLabel: "Remove" }))) return;
      btn.disabled = true;
      try {
        const { data } = await api(`/${shipment.shipmentId}/deliveries/${deliveryId}`, { method: "DELETE" });
        if (onChange) onChange();
        if (data.cancelled) { NexusModal.close(); return; }
        await openDeliveriesPanel(card, shipment, deliveries.filter((d) => String(d.deliveryId) !== deliveryId), onChange);
      } catch (err) {
        card.querySelector("#sd-remove-result").textContent = err.message;
        btn.disabled = false;
      }
    }));
    const addBtn = card.querySelector("#sd-add-btn");
    if (addBtn) addBtn.addEventListener("click", async () => {
      const selected = [...card.querySelectorAll(".sd-avail-check:checked")].map((cb) => Number(cb.dataset.id));
      if (!selected.length) return;
      const result = card.querySelector("#sd-add-result");
      addBtn.disabled = true; result.textContent = "Adding…";
      try {
        await api(`/${shipment.shipmentId}/deliveries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deliveryIds: selected }) });
        if (onChange) onChange();
        const { data } = await api(`/${shipment.shipmentId}/details`);
        await openDeliveriesPanel(card, data.shipment, data.deliveries || [], onChange);
      } catch (err) {
        result.textContent = err.message;
        addBtn.disabled = false;
      }
    });
  }

  window.OutboundShipmentDetail = { open };
})();
