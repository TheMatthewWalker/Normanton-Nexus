// Shared Inbound Shipment detail modal — port of private/js/logistics.js's
// openInboundShipmentDetail/refreshInboundShipmentDetail family, extracted
// out of inbound-log.js so Order Suggestions' Tracked Orders can open the
// same modal from its own "Shipment" column (matching Node's own
// openInboundShipmentDetail(shipmentId, opener) being reachable from both
// the Inbound Log's row click and Tracked Orders' shipment pill).
//
// Usage: window.ShipmentDetailModal.open(shipmentId, { onChange }) — onChange
// is called (no args) after any action that could change the shipment's own
// bucket/status (save, mark received, undo, cancel), so the caller's own list
// can refresh itself; this module never assumes which page it's running on.
//
// Once a shipment is marked Received, the ONLY action available here is
// Undo Received — no header edit, no manual items/documents/costs additions,
// no Cancel Shipment — matching Node's own real behavior for a completed
// shipment exactly (there's nothing left to manage once it's landed and
// been receipted; undoing is the one way back).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance/order-suggestions/shipments");
  const itemApi = NexusApi.make("/api/performance/order-suggestions");
  const costApi = NexusApi.make("/api/inboundcosts");
  const refApi = NexusApi.make("/api");

  const KG_PER_UNIT = { KG: 1, LB: 0.45359237 };
  function kgToOrderUnit(qtyKg, unit) {
    const factor = KG_PER_UNIT[(unit || "KG").toUpperCase()];
    if (!factor) return qtyKg;
    return Math.round((qtyKg / factor) * 1000) / 1000;
  }

  const TRANSPORT_MODES = ["Road", "Groupage", "Sea", "Air", "Rail", "Courier", "Other"];

  let forwarders = [];
  let costTypes = [];
  let refDataLoaded = false;

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }

  async function ensureRefData() {
    if (refDataLoaded) return;
    refDataLoaded = true;
    try {
      const { data } = await refApi("/forwarders/approved");
      forwarders = data || [];
    } catch { /* best-effort */ }
    try {
      const { data } = await refApi("/costtypes");
      costTypes = data || [];
    } catch { /* best-effort */ }
  }

  function populateHaulierSelect(selectEl, mode, preselectId) {
    const matching = mode ? forwarders.filter((f) => (f.forwarderMode || "").toLowerCase() === mode.toLowerCase()) : forwarders;
    selectEl.disabled = false;
    selectEl.innerHTML = '<option value="">—</option>' + matching.map((f) =>
      `<option value="${f.forwarderId}" ${preselectId && Number(preselectId) === f.forwarderId ? "selected" : ""}>${esc(f.forwarderName)}</option>`).join("");
  }

  async function open(shipmentId, { onChange } = {}) {
    await ensureRefData();
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Shipment</div><div class="ps-modal-sub">Loading…</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body" id="isd-body"><div class="nx-toolbar-hint">Loading…</div></div>`, { wide: true });
    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    await refresh(card, shipmentId, onChange);
  }

  async function refresh(card, shipmentId, onChange) {
    const notifyChange = () => { if (onChange) onChange(); };
    const body = card.querySelector("#isd-body");
    try {
      const { data: s } = await api(`/${shipmentId}`);

      card.querySelector(".ps-modal-title").textContent = s.shipmentReference || `Shipment #${s.shipmentId}`;
      card.querySelector(".ps-modal-sub").textContent = s.cancelledAtUtc
        ? `Cancelled ${fmtDate(s.cancelledAtUtc)}${s.cancelledBy ? " by " + s.cancelledBy : ""} — orders unlinked`
        : (s.receivedAtUtc
          ? `Received ${fmtDate(s.receivedAtUtc)}${s.receivedBy ? " by " + s.receivedBy : ""}`
          : `${s.orders.length} order line${s.orders.length === 1 ? "" : "s"} — not yet received`);

      const canReceive = !s.cancelledAtUtc && !s.receivedAtUtc;
      const canUndoReceive = !s.cancelledAtUtc && !!s.receivedAtUtc;
      // Once Received, the only action left is Undo Received — no header
      // edit, no Cancel, no adding manual items/documents/costs.
      const completedReadOnly = canUndoReceive;

      const ordersRows = s.orders.map((o) => {
        const isCancelled = o.status === "Cancelled";
        const receivedUnit = o.orderMoqUom || o.uom || "KG";
        const qtyReceivedCell = canReceive
          ? (isCancelled
            ? '<span style="color:var(--text-muted)">—</span>'
            : `<input class="tf-input isd-received-qty" type="number" step="0.001" min="0" data-suggestion-id="${o.suggestionId}" data-material="${esc(o.material)}" value="${kgToOrderUnit(Number(o.orderQty), receivedUnit)}" style="width:90px"> <span style="font-size:11px;color:var(--text-muted)">${esc(receivedUnit)}</span>`)
          : (o.receivedQty != null ? `${kgToOrderUnit(Number(o.receivedQty), receivedUnit).toLocaleString()} ${esc(receivedUnit)}` : "—");

        const supplierRefCell = (canReceive && !isCancelled)
          ? (o.supplierReference
            ? esc(o.supplierReference)
            : `<input class="tf-input isd-supplier-ref" type="text" data-suggestion-id="${o.suggestionId}" data-material="${esc(o.material)}" placeholder="Enter paperwork ref" style="width:110px">`)
          : esc(o.supplierReference || "—");

        const missingPoItemOnly = !completedReadOnly && !isCancelled && !o.sapMaterialDocument && o.sapGrSkipped && o.poNumber && !o.poItemNumber;
        const poItemFixControl = `
          <input class="tf-input isd-po-item-input" type="text" maxlength="5" data-suggestion-id="${o.suggestionId}" value="${esc(o.poItemNumber || "")}" placeholder="e.g. 00010" style="width:70px">
          <button type="button" class="secondary isd-po-item-save" data-suggestion-id="${o.suggestionId}" style="padding:2px 6px;font-size:10.5px;margin-left:4px">Save</button>`;
        const sapGrCell = canReceive ? "" : `<td>${
          isCancelled ? '<span style="color:var(--text-muted)">—</span>'
          : o.sapMaterialDocument ? `<span title="Material document">✓ ${esc(o.sapMaterialDocument)}</span>`
          : missingPoItemOnly ? `<span class="badge badge--error">Not posted</span><div style="font-size:11px;color:var(--error);margin-bottom:4px">${esc(o.sapGrError)}</div>${poItemFixControl}`
          : (o.sapGrSkipped && o.sapGrError) ? `<span class="badge badge--error">Not posted</span><div style="font-size:11px;color:var(--error)">${esc(o.sapGrError)}</div>`
          : o.sapGrSkipped ? '<span style="color:var(--text-muted)">Skipped (testing)</span>'
          : o.sapGrError ? `<span class="badge badge--error">Failed</span><div style="font-size:11px;color:var(--error)">${esc(o.sapGrError)}</div>`
          : "—"
        }</td>`;

        return `<tr>
          <td><strong>${esc(o.material)}</strong><div style="font-size:11px;color:var(--text-muted)">${esc(o.materialText || "")}</div></td>
          <td>${esc(o.vendorName)}</td>
          <td>${Number(o.orderQty).toLocaleString()} ${esc(o.uom || "KG")}</td>
          <td>${qtyReceivedCell}</td>
          <td>${esc(o.poNumber || "—")}</td>
          <td>${supplierRefCell}</td>
          ${sapGrCell}
        </tr>`;
      }).join("");

      // A completed shipment gets a plain read-only header summary instead
      // of the editable form — nothing about it can still be changed.
      const headerHtml = completedReadOnly
        ? `<div style="font-size:12.5px;line-height:1.7">
             <div><strong>Dispatch:</strong> ${fmtDate(s.dispatchDate) || "—"} &nbsp; <strong>ETA:</strong> ${fmtDate(s.expectedEta) || "—"}</div>
             <div><strong>Haulier:</strong> ${esc(s.haulier || "—")} &nbsp; <strong>Mode:</strong> ${esc(s.modeOfTransport || "—")}</div>
             <div><strong>Tracking:</strong> ${esc(s.trackingNumber || "—")} &nbsp; <strong>Container:</strong> ${esc(s.containerNumber || "—")}</div>
             ${s.billOfLading ? `<div><strong>B/L:</strong> ${esc(s.billOfLading)}</div>` : ""}
             ${s.notes ? `<div><strong>Notes:</strong> ${esc(s.notes)}</div>` : ""}
           </div>`
        : `<form id="isd-form">
            <div class="tf-row">
              <div class="tf-field"><label class="tf-label">Dispatch Date</label><input class="tf-input" type="date" id="isd-dispatch" value="${s.dispatchDate ? String(s.dispatchDate).slice(0, 10) : ""}"></div>
              <div class="tf-field"><label class="tf-label">Expected ETA</label><input class="tf-input" type="date" id="isd-eta" value="${s.expectedEta ? String(s.expectedEta).slice(0, 10) : ""}"></div>
            </div>
            <div class="tf-row">
              <div class="tf-field"><label class="tf-label">Haulier</label><select class="tf-input" id="isd-haulier"><option value="">Loading…</option></select></div>
              <div class="tf-field"><label class="tf-label">Mode of Transport</label>
                <select class="tf-input" id="isd-mode"><option value="">—</option>${TRANSPORT_MODES.map((m) => `<option value="${m}" ${s.modeOfTransport === m ? "selected" : ""}>${m}</option>`).join("")}</select>
              </div>
            </div>
            <div class="tf-row">
              <div class="tf-field"><label class="tf-label">Tracking Number</label><input class="tf-input" type="text" id="isd-tracking" value="${esc(s.trackingNumber || "")}"></div>
              <div class="tf-field"><label class="tf-label">Container Number</label><input class="tf-input" type="text" id="isd-container" value="${esc(s.containerNumber || "")}"></div>
            </div>
            <div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">B/L Number</label><input class="tf-input" type="text" id="isd-bl" value="${esc(s.billOfLading || "")}"></div></div>
            <div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Notes</label><input class="tf-input" type="text" id="isd-notes" value="${esc(s.notes || "")}"></div></div>
            <button type="submit" class="secondary">Save</button>
            <div id="isd-save-result"></div>
          </form>`;

      body.innerHTML = `
        ${s.isManual ? `<p style="font-size:12px;color:var(--text-muted)">Manual shipment — not linked to any tracked order. Origin: <strong>${esc(s.originName || "—")}</strong></p>` : ""}
        ${headerHtml}

        ${s.orders.length ? `
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:16px 0 6px">Order Lines</div>
        ${canReceive ? '<p style="font-size:11px;color:var(--text-muted)">Qty Received defaults to what was ordered — adjust any line before Mark Received to confirm a short or over delivery. Only the confirmed quantity is posted as goods receipt in SAP.</p>' : ""}
        <div style="overflow-x:auto">
          <table><thead><tr><th>Material</th><th>Vendor</th><th>Qty Ordered</th><th>Qty Received</th><th>PO Number</th><th>Supplier Ref</th>${canReceive ? "" : "<th>SAP GR</th>"}</tr></thead><tbody>${ordersRows}</tbody></table>
        </div>
        ${canReceive ? `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px"><input type="checkbox" id="isd-skip-sap"> <span>Skip SAP posting (testing only) — marks received in the portal without posting any goods receipt to SAP</span></label>` : ""}
        ${canUndoReceive ? `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px"><input type="checkbox" id="isd-undo-skip-sap"> <span>Skip SAP reversal (testing only / already reversed by hand) — force-clears the portal record without calling SAP</span></label>` : ""}
        <div id="isd-result" style="margin-top:8px"></div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          ${canReceive ? '<button type="button" class="btn" id="isd-receive-btn">Mark Received</button>' : ""}
          ${canUndoReceive ? '<button type="button" class="secondary" id="isd-undo-btn">Undo Received</button>' : ""}
          ${!s.cancelledAtUtc && !completedReadOnly ? '<button type="button" class="secondary" id="isd-cancel-btn" style="color:var(--error)">Cancel Shipment</button>' : ""}
        </div>` : ""}

        ${s.isManual && !completedReadOnly ? `
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:16px 0 6px">Cargo Items</div>
        <p style="font-size:11px;color:var(--text-muted)">Not linked to SAP or any tracked order — record what's actually on this shipment for your own tracking.</p>
        <div id="isd-manual-items"><div class="nx-toolbar-hint">Loading…</div></div>
        <form id="isd-manual-item-form" style="margin-top:8px">
          <div class="tf-row">
            <div class="tf-field"><label class="tf-label">Material</label><input class="tf-input" type="text" id="ilmi-material"></div>
            <div class="tf-field"><label class="tf-label">Description</label><input class="tf-input" type="text" id="ilmi-desc"></div>
            <div class="tf-field"><label class="tf-label">Quantity</label><input class="tf-input" type="number" step="0.01" id="ilmi-qty" required></div>
            <div class="tf-field"><label class="tf-label">UoM</label><input class="tf-input" type="text" id="ilmi-uom"></div>
            <div class="tf-field" style="justify-content:flex-end"><button type="submit" class="secondary">Add Item</button></div>
          </div>
        </form>` : (s.isManual ? `
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:16px 0 6px">Cargo Items</div>
        <div id="isd-manual-items"><div class="nx-toolbar-hint">Loading…</div></div>` : "")}

        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:16px 0 6px">Documents</div>
        ${completedReadOnly ? "" : '<p style="font-size:11px;color:var(--text-muted)">Purchase orders assigned to this shipment are filed here automatically. Upload shipping documents or the supplier invoice too — everything lands in the same folder.</p>'}
        <div id="isd-documents"><div class="nx-toolbar-hint">Loading…</div></div>
        ${completedReadOnly ? "" : `
        <input type="file" id="isd-doc-file-input" accept=".pdf,.jpg,.jpeg,.png,.docx,.doc,.xlsx,.xls,.msg,.eml,.txt,.csv" class="hidden">
        <button type="button" class="secondary" id="isd-doc-upload-btn" style="margin-top:8px">Upload Document</button>`}

        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:16px 0 6px">Associated Costs</div>
        <div id="isd-costs"><div class="nx-toolbar-hint">Loading…</div></div>
        ${completedReadOnly ? "" : `
        <form id="isd-cost-form" style="margin-top:8px">
          <div class="tf-row">
            <div class="tf-field"><label class="tf-label">Cost Type</label><select class="tf-input" id="ilc-type" required><option value="">—</option>${costTypes.map((t) => `<option value="${esc(t.typeDescription)}">${esc(t.typeDescription)}</option>`).join("")}</select></div>
            <div class="tf-field"><label class="tf-label">Tier</label><input class="tf-input" type="text" id="ilc-tier"></div>
            <div class="tf-field"><label class="tf-label">Amount</label><input class="tf-input" type="number" step="0.01" id="ilc-amount" required></div>
            <div class="tf-field"><label class="tf-label">Mode of Transport</label><input class="tf-input" type="text" id="ilc-mode"></div>
            ${s.isManual ? '<div class="tf-field"><label class="tf-label">Cost Centre</label><input class="tf-input" type="text" id="ilc-costcentre"></div>' : ""}
            <div class="tf-field"><label class="tf-label">Information</label><input class="tf-input" type="text" id="ilc-info"></div>
            <div class="tf-field" style="justify-content:flex-end"><button type="submit" class="secondary">Add Cost</button></div>
          </div>
        </form>`}

        <div class="ps-modal-actions" style="margin-top:14px"><button type="button" class="secondary" id="isd-close-btn">Close</button></div>`;

      card.querySelector("#isd-close-btn")?.addEventListener("click", () => NexusModal.close());

      if (!completedReadOnly) {
        populateHaulierSelect(card.querySelector("#isd-haulier"), s.modeOfTransport, s.forwarderId);

        card.querySelector("#isd-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const resultEl = card.querySelector("#isd-save-result");
          try {
            await api(`/${s.shipmentId}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                dispatchDate: card.querySelector("#isd-dispatch").value || null,
                expectedEta: card.querySelector("#isd-eta").value || null,
                haulier: card.querySelector("#isd-haulier").selectedOptions[0]?.textContent || null,
                forwarderId: card.querySelector("#isd-haulier").value ? Number(card.querySelector("#isd-haulier").value) : null,
                modeOfTransport: card.querySelector("#isd-mode").value || null,
                trackingNumber: card.querySelector("#isd-tracking").value || null,
                billOfLading: card.querySelector("#isd-bl").value || null,
                containerNumber: card.querySelector("#isd-container").value || null,
                notes: card.querySelector("#isd-notes").value || null,
              }),
            });
            notifyChange();
            await refresh(card, s.shipmentId, onChange);
          } catch (err) {
            resultEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
          }
        });
      }

      card.querySelectorAll(".isd-po-item-save").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const suggestionId = btn.dataset.suggestionId;
          const input = card.querySelector(`.isd-po-item-input[data-suggestion-id="${suggestionId}"]`);
          btn.disabled = true; btn.textContent = "Saving…";
          try {
            await itemApi(`/${suggestionId}/po-item`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poItemNumber: input.value.trim() || null }) });
            await refresh(card, s.shipmentId, onChange);
          } catch (err) {
            await NexusModal.alert(err.message);
            btn.disabled = false; btn.textContent = "Save";
          }
        });
      });

      const receiveBtn = card.querySelector("#isd-receive-btn");
      if (receiveBtn) receiveBtn.addEventListener("click", () => markShipmentReceived(card, s, onChange));

      const undoBtn = card.querySelector("#isd-undo-btn");
      if (undoBtn) undoBtn.addEventListener("click", async () => {
        const skipSap = !!card.querySelector("#isd-undo-skip-sap")?.checked;
        const msg = skipSap
          ? "Undo Mark Received? This force-clears the portal record WITHOUT reversing anything in SAP — only use this if it's already been reversed by hand."
          : "Undo Mark Received? This reverses the SAP goods receipt for each linked order.";
        if (!(await NexusModal.confirm(msg, { danger: true, confirmLabel: "Undo Received" }))) return;
        try {
          const { data } = await api(`/${s.shipmentId}/undo-receive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skipSap }) });
          notifyChange();
          if (data.stillPostedCount > 0) await NexusModal.alert(`${data.stillPostedCount} line(s) could not be reversed in SAP and remain posted — retry needed.`);
          await refresh(card, s.shipmentId, onChange);
        } catch (err) {
          await NexusModal.alert(err.message);
        }
      });

      const cancelBtn = card.querySelector("#isd-cancel-btn");
      if (cancelBtn) cancelBtn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Cancel this shipment? Linked orders are unlinked (returned to Ordered), not deleted.", { danger: true, confirmLabel: "Cancel Shipment", cancelLabel: "Back" }))) return;
        try {
          await api(`/${s.shipmentId}/cancel`, { method: "POST" });
          notifyChange();
          await refresh(card, s.shipmentId, onChange);
        } catch (err) {
          await NexusModal.alert(err.message);
        }
      });

      if (s.isManual) loadManualItems(card, s.shipmentId, !completedReadOnly);
      loadDocuments(card, s.shipmentId);
      loadCosts(card, s.shipmentId, s.isManual, !completedReadOnly);

      const itemForm = card.querySelector("#isd-manual-item-form");
      if (itemForm) itemForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api(`/${s.shipmentId}/manual-items`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              material: card.querySelector("#ilmi-material").value || null,
              description: card.querySelector("#ilmi-desc").value || null,
              quantity: Number(card.querySelector("#ilmi-qty").value),
              unitOfMeasure: card.querySelector("#ilmi-uom").value || null,
            }),
          });
          e.target.reset();
          await loadManualItems(card, s.shipmentId, true);
        } catch (err) {
          await NexusModal.alert(err.message);
        }
      });

      const uploadBtn = card.querySelector("#isd-doc-upload-btn");
      if (uploadBtn) {
        uploadBtn.addEventListener("click", () => card.querySelector("#isd-doc-file-input").click());
        card.querySelector("#isd-doc-file-input").addEventListener("change", async () => {
          const fileInput = card.querySelector("#isd-doc-file-input");
          const file = fileInput.files[0];
          if (!file) return;
          try {
            const buf = await file.arrayBuffer();
            await api(`/${s.shipmentId}/documents/upload?fileName=${encodeURIComponent(file.name)}`, {
              method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf,
            });
            fileInput.value = "";
            await loadDocuments(card, s.shipmentId);
          } catch (err) {
            await NexusModal.alert(err.message);
          }
        });
      }

      const costForm = card.querySelector("#isd-cost-form");
      if (costForm) costForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await costApi("", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              poShipmentId: s.shipmentId,
              tier: card.querySelector("#ilc-tier").value || null,
              amount: Number(card.querySelector("#ilc-amount").value),
              costType: card.querySelector("#ilc-type").value || null,
              information: card.querySelector("#ilc-info").value || null,
              modeOfTransport: card.querySelector("#ilc-mode").value || null,
              costCenter: s.isManual ? (card.querySelector("#ilc-costcentre")?.value || null) : null,
            }),
          });
          e.target.reset();
          await loadCosts(card, s.shipmentId, s.isManual, true);
        } catch (err) {
          await NexusModal.alert(err.message);
        }
      });
    } catch (err) {
      body.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function markShipmentReceived(card, shipment, onChange) {
    const orderCount = shipment.orders?.length || 0;
    const resultEl = card.querySelector("#isd-result");
    resultEl.innerHTML = "";

    const receivedQuantities = {};
    for (const input of card.querySelectorAll(".isd-received-qty")) {
      const suggestionId = input.dataset.suggestionId;
      const qty = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(qty) || qty < 0) {
        resultEl.innerHTML = `<div class="tf-inline-error">Enter a valid received quantity for ${esc(input.dataset.material || "every order line")}.</div>`;
        return;
      }
      receivedQuantities[suggestionId] = qty;
    }

    const supplierReferences = {};
    for (const input of card.querySelectorAll(".isd-supplier-ref")) {
      const suggestionId = input.dataset.suggestionId;
      const ref = input.value.trim();
      if (!ref) {
        resultEl.innerHTML = `<div class="tf-inline-error">Enter the supplier's delivery paperwork reference for ${esc(input.dataset.material || "every order line")}.</div>`;
        return;
      }
      supplierReferences[suggestionId] = ref;
    }

    const skipSap = !!card.querySelector("#isd-skip-sap")?.checked;
    const confirmMsg = skipSap
      ? `Mark ${shipment.shipmentReference || "this shipment"} received? ${orderCount} order line${orderCount === 1 ? "" : "s"} will be flipped to Received using the confirmed quantities — SAP posting will be SKIPPED (testing mode).`
      : `Mark ${shipment.shipmentReference || "this shipment"} received? ${orderCount} order line${orderCount === 1 ? "" : "s"} will be flipped to Received and posted as goods receipt in SAP using the confirmed quantities.`;
    if (!(await NexusModal.confirm(confirmMsg, { confirmLabel: "Mark Received" }))) return;

    const btn = card.querySelector("#isd-receive-btn");
    btn.disabled = true; btn.textContent = "Marking…";
    try {
      const { data } = await api(`/${shipment.shipmentId}/receive`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receivedAt: new Date().toISOString(), receivedQuantities, supplierReferences, skipSap }),
      });
      if (onChange) onChange();
      await refresh(card, shipment.shipmentId, onChange);
      const failed = (data.sapResults || []).filter((r) => !r.success);
      if (failed.length) await NexusModal.alert(`Received with ${failed.length} SAP issue(s):\n` + failed.map((f) => `${f.material}: ${f.error || "not posted"}`).join("\n"));
    } catch (err) {
      resultEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Mark Received";
    }
  }

  async function loadManualItems(card, shipmentId, editable) {
    const el = card.querySelector("#isd-manual-items");
    if (!el) return;
    try {
      const { data } = await api(`/${shipmentId}/manual-items`);
      const items = data || [];
      el.innerHTML = items.length === 0 ? '<p style="font-size:12px;color:var(--text-muted)">No manual items.</p>' : `
        <table>
          <thead><tr><th>Material</th><th>Description</th><th>Qty</th><th>UoM</th>${editable ? "<th></th>" : ""}</tr></thead>
          <tbody>${items.map((i) => `
            <tr>
              <td>${esc(i.material)}</td><td>${esc(i.description)}</td><td>${esc(i.quantity)}</td><td>${esc(i.unitOfMeasure)}</td>
              ${editable ? `<td><button type="button" class="secondary" data-remove-item="${i.itemId}" style="padding:2px 8px;font-size:10.5px">Remove</button></td>` : ""}
            </tr>`).join("")}</tbody>
        </table>`;
      if (editable) {
        el.querySelectorAll("button[data-remove-item]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            if (!(await NexusModal.confirm("Remove this item?", { danger: true, confirmLabel: "Remove" }))) return;
            try {
              await itemApi(`/manual-items/${btn.dataset.removeItem}`, { method: "DELETE" });
            } catch (err) {
              await NexusModal.alert(err.message);
            }
            await loadManualItems(card, shipmentId, editable);
          });
        });
      }
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  async function loadDocuments(card, shipmentId) {
    const el = card.querySelector("#isd-documents");
    try {
      const { data } = await api(`/${shipmentId}/documents/folder`);
      const files = data.files || [];
      el.innerHTML = files.length === 0 ? '<p style="font-size:12px;color:var(--text-muted)">No documents.</p>' : `
        <ul style="margin:0;padding-left:18px;font-size:12.5px">${files.map((f) => `<li><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">${esc(f.fileName)}</a> (${Math.round(f.sizeBytes / 1024)} KB)</li>`).join("")}</ul>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  async function loadCosts(card, shipmentId, isManual, editable) {
    const el = card.querySelector("#isd-costs");
    try {
      const { data } = await costApi(`/shipment/${shipmentId}`);
      const costRows = data || [];
      el.innerHTML = costRows.length === 0 ? '<p style="font-size:12px;color:var(--text-muted)">No cost lines.</p>' : `
        <table>
          <thead><tr><th>Element</th><th>Tier</th><th>Cost Centre</th><th>Type</th><th>Expected</th><th>Actual</th><th>Posted</th>${editable ? "<th></th>" : ""}</tr></thead>
          <tbody>${costRows.map((c) => `
            <tr>
              <td>${esc(c.costElement)} ${esc(c.elementDescription)}</td>
              <td>${esc(c.tier)}</td>
              <td>${esc(c.costCenter)}</td>
              <td>${esc(c.costType)}</td>
              <td>${esc(c.expectedCost)}</td>
              <td>${c.actualCost != null ? esc(c.actualCost) : "—"}</td>
              <td>${c.migoStatus ? "Yes" : "No"}</td>
              ${editable ? `<td>${c.migoStatus ? "" : `<button type="button" class="secondary" data-remove-cost="${c.costId}" style="padding:2px 8px;font-size:10.5px">Delete</button>`}</td>` : ""}
            </tr>`).join("")}</tbody>
        </table>`;
      if (editable) {
        el.querySelectorAll("button[data-remove-cost]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            if (!(await NexusModal.confirm("Delete this cost line?", { danger: true, confirmLabel: "Delete" }))) return;
            try {
              await costApi(`/${btn.dataset.removeCost}`, { method: "DELETE" });
              await loadCosts(card, shipmentId, isManual, editable);
            } catch (err) {
              await NexusModal.alert(err.message);
            }
          });
        });
      }
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  window.ShipmentDetailModal = { open };
})();
