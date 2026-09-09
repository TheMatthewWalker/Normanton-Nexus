// Shared "Book" modal for outbound shipments — port of openBookingModal in
// private/js/logistics.js, used by the Awaiting Booking queue. Exposed as
// window.ShipmentBooking.open(rows, onDone) so any other page (Search,
// the shipment detail modal) can reuse it later.
//
// Deliberately simplified relative to Node, matching this migration's own
// established "simplified frontend, real backend already accepts the fuller
// shape" precedent:
//   - The KN document-verification/upload-to-KN sub-flow
//     (openVerifyDocumentsModal — browsing the shipment's document folder,
//     categorizing Packing List/Invoice/Customs Declaration, and gating
//     booking on all three being assigned) is NOT built. A KN shipment here
//     still calls the real POST /api/freight-booking/shipment/{id} and gets
//     back a real tracking number, but the document-upload-to-KN step is
//     skipped — flagged, not silently dropped.
//   - Node's real code auto-fetches a cost estimate for every row using
//     `isKnHaulier` as a bare (always-truthy) function reference rather than
//     calling it — a real bug in Node that makes every row (not just KN
//     rows) show the auto-calculating cost cell. Rather than reproduce that
//     bug, this port just always tries GET /api/shipmentcost/estimate/{id}
//     for every row (which already degrades gracefully to "no rate found"
//     for a non-KN forwarder) and falls back to manual entry — same net
//     effect, without the confusing always-true function reference.
(function () {
  const esc = NexusApi.esc;
  const shipmentApi = NexusApi.make("/api/shipmentmain");
  const costApi = NexusApi.make("/api/shipmentcost");
  const freightApi = NexusApi.make("/api/freight-booking");
  const refApi = NexusApi.make("/api");

  function normalizeHaulierName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function isCustomerCollectHaulier(value) { return normalizeHaulierName(value).includes("customercollect"); }
  function isKnHaulier(value) { const n = normalizeHaulierName(value); return n.includes("kuehnenagel") || n.includes("kuehneandnagel"); }
  function isExWorksIncoterms(value) { const n = String(value || "").trim().toUpperCase().replace(/\s+/g, ""); return n === "EXW" || n === "EXWORKS"; }
  function hasAssignedHaulier(row) { return Boolean(String(row?.forwarderName || "").trim()); }

  async function open(rows, onDone) {
    const forwarders = await refApi("/forwarders/approved").then((r) => r.data || []).catch(() => []);
    const customerCollectForwarder = forwarders.find((f) => isCustomerCollectHaulier(f.forwarderName));

    const rowsHtml = rows.map((row) => {
      const sid = row.shipmentId;
      const ref = String(sid).padStart(8, "0");
      const rowIsExw = isExWorksIncoterms(row.incoTerms);
      const forwarderField = hasAssignedHaulier(row)
        ? esc(row.forwarderName || "")
        : `<select class="tf-input" id="bk-forwarder-${sid}"><option value="">Select haulier</option>${forwarders.map((f) => `<option value="${f.forwarderId}" ${rowIsExw && customerCollectForwarder && f.forwarderId === customerCollectForwarder.forwarderId ? "selected" : ""}>${esc(f.forwarderName)}</option>`).join("")}</select>`;
      const collectionVal = row.plannedMovement ? String(row.plannedMovement).slice(0, 10) : "";
      const deliveryVal = row.plannedDelivery ? String(row.plannedDelivery).slice(0, 10) : "";
      return `<tr>
        <td>${esc(ref)}</td>
        <td>${esc(row.destinationName || "")}</td>
        <td>${forwarderField}</td>
        <td><input class="tf-input" type="date" id="bk-collection-${sid}" value="${collectionVal}" data-country="${esc(row.destinationCountry || "")}" data-postcode="${esc(row.destinationPostCode || "")}" style="min-width:135px"></td>
        <td><input class="tf-input" type="date" id="bk-delivery-${sid}" value="${deliveryVal}" style="min-width:135px"></td>
        <td><input class="tf-input" type="text" id="bk-tracking-${sid}" value="${esc(row.trackingNumber || "")}" style="min-width:110px"></td>
        <td><span id="bk-cost-loading-${sid}" style="font-size:10.5px;color:var(--text-muted)">…</span><input class="tf-input" type="number" step="0.01" min="0" id="bk-cost-${sid}" style="width:80px;display:none" placeholder="£"></td>
      </tr>`;
    }).join("");

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Book Shipment${rows.length > 1 ? "s" : ""}</div><div class="ps-modal-sub">${rows.length} shipment(s)</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="nx-toolbar-hint">Confirm the haulier, dates and tracking number for each shipment, then Book.</div>
        <div style="overflow-x:auto"><table><thead><tr><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Planned Collection</th><th>Planned Delivery</th><th>Tracking</th><th>Expected Cost</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
        <div class="tf-row" style="margin-top:12px">
          <div class="tf-field"><label class="tf-label">Cost Centre</label><select class="tf-input" id="bk-cost-centre"><option value="">Loading…</option></select></div>
        </div>
        <div id="bk-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="bk-cancel">Cancel</button>
        <button type="button" class="btn" id="bk-submit">Book</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#bk-cancel").addEventListener("click", () => NexusModal.close());

    refApi("/costcenters").then(({ data }) => {
      const sel = card.querySelector("#bk-cost-centre");
      if (!sel) return;
      sel.innerHTML = (data || []).map((c) => `<option value="${esc(c.centerCode || "")}">${esc(c.centerCode || "")} — ${esc(c.centerDescription || "")}</option>`).join("");
      if ((data || []).some((c) => c.centerCode === "0000002004")) sel.value = "0000002004";
    }).catch(() => {});

    rows.forEach(async (row) => {
      const sid = row.shipmentId;
      const loadEl = card.querySelector(`#bk-cost-loading-${sid}`);
      const inputEl = card.querySelector(`#bk-cost-${sid}`);
      if (!inputEl) return;
      try {
        const { data } = await costApi(`/estimate/${sid}`);
        if (data && data.rateFound) {
          inputEl.value = data.expectedCost;
          inputEl.dataset.elementCode = data.elementCode || "";
          inputEl.dataset.customsCost = data.customsCost != null ? String(data.customsCost) : "";
          if (loadEl) loadEl.textContent = `£${data.agreedRate}/kg`;
        } else if (loadEl) {
          loadEl.textContent = "";
        }
      } catch (_) {
        if (loadEl) loadEl.textContent = "";
      } finally {
        inputEl.style.display = "";
      }
    });

    rows.forEach((row) => {
      const sid = row.shipmentId;
      const collectionEl = card.querySelector(`#bk-collection-${sid}`);
      const deliveryEl = card.querySelector(`#bk-delivery-${sid}`);
      if (!collectionEl || !deliveryEl) return;
      async function calc() {
        const collectionDate = collectionEl.value;
        if (!collectionDate || deliveryEl.dataset.userEdited) return;
        const country = collectionEl.dataset.country;
        if (!country) return;
        try {
          const { data } = await refApi(`/deliveryroutes/lookup?country=${encodeURIComponent(country)}&postcode=${encodeURIComponent(collectionEl.dataset.postcode || "")}`);
          if (data?.transitDays == null) return;
          const base = new Date(collectionDate);
          base.setDate(base.getDate() + data.transitDays);
          deliveryEl.value = base.toISOString().slice(0, 10);
        } catch (_) { /* best-effort */ }
      }
      deliveryEl.addEventListener("change", () => { deliveryEl.dataset.userEdited = "1"; });
      collectionEl.addEventListener("change", calc);
      calc();
    });

    card.querySelector("#bk-submit").addEventListener("click", () => submit(card, rows, forwarders, onDone));
  }

  async function submit(card, rows, forwarders, onDone) {
    const btn = card.querySelector("#bk-submit");
    const result = card.querySelector("#bk-result");
    result.innerHTML = "";
    const costCenter = card.querySelector("#bk-cost-centre").value || null;

    const items = rows.map((row) => {
      const sid = row.shipmentId;
      const forwarderSelect = card.querySelector(`#bk-forwarder-${sid}`);
      const forwarderId = forwarderSelect ? (Number(forwarderSelect.value) || null) : row.forwarderId;
      const forwarderInfo = forwarders.find((f) => f.forwarderId === forwarderId);
      const forwarderName = forwarderSelect ? (forwarderInfo?.forwarderName || "") : row.forwarderName;
      const forwarderMode = forwarderInfo?.forwarderMode || row.forwarderMode || null;
      const costInput = card.querySelector(`#bk-cost-${sid}`);
      return {
        shipmentId: sid, forwarderId, forwarderName, forwarderMode,
        plannedCollection: card.querySelector(`#bk-collection-${sid}`).value || null,
        plannedDelivery: card.querySelector(`#bk-delivery-${sid}`).value || null,
        trackingNumber: card.querySelector(`#bk-tracking-${sid}`).value.trim() || "",
        expectedCost: costInput && costInput.value ? Number(costInput.value) : null,
        customsCost: costInput && costInput.dataset.customsCost ? Number(costInput.dataset.customsCost) : null,
        elementCode: costInput ? (costInput.dataset.elementCode || null) : null,
      };
    });

    const missingForwarder = items.find((i) => !i.forwarderId);
    if (missingForwarder) { result.innerHTML = `<div class="tf-inline-error">Haulier is required for shipment ${esc(String(missingForwarder.shipmentId).padStart(8, "0"))}.</div>`; return; }

    btn.disabled = true; btn.textContent = "Working…";

    const failedRefs = [];
    for (const item of items) {
      const ref = String(item.shipmentId).padStart(8, "0");
      try {
        if (isKnHaulier(item.forwarderName)) {
          if (!item.plannedCollection) throw new Error("Planned collection date is required.");
          const { data } = await freightApi(`/shipment/${item.shipmentId}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plannedCollection: item.plannedCollection }),
          });
          if (data?.bookingIsSuccessful === false) throw new Error(data?.message || "Kuehne & Nagel booking was rejected.");
          item.trackingNumber = data?.trackingNumber || item.trackingNumber;
        } else if (isCustomerCollectHaulier(item.forwarderName)) {
          await shipmentApi(`/${item.shipmentId}/send-collection-email`, { method: "POST" });
        } else if (!item.trackingNumber) {
          throw new Error("Tracking number is required.");
        } else if (!item.expectedCost || item.expectedCost <= 0) {
          throw new Error("Expected cost is required.");
        }
      } catch (err) {
        failedRefs.push(`${ref}: ${err.message}`);
        item.failed = true;
      }
    }

    const toBook = items.filter((i) => !i.failed);
    if (!toBook.length) {
      result.innerHTML = `<div class="tf-inline-error">No shipments were booked. ${esc(failedRefs.join(" | "))}</div>`;
      btn.disabled = false; btn.textContent = "Book";
      return;
    }

    try {
      const { data } = await shipmentApi("/mark-booked", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipments: toBook.map((i) => ({
            shipmentId: i.shipmentId, trackingNumber: i.trackingNumber, plannedCollection: i.plannedCollection,
            plannedDelivery: i.plannedDelivery, forwarderId: i.forwarderId, forwarderMode: i.forwarderMode,
            expectedCost: i.expectedCost, costCenter, elementCode: i.elementCode, skipCost: false, customsCost: i.customsCost,
          })),
        }),
      });
      if (failedRefs.length) {
        result.innerHTML = `<div class="tf-inline-error">Booked ${esc(data.updated)} shipment(s). Failed: ${esc(failedRefs.join(" | "))}</div>`;
        btn.disabled = false; btn.textContent = "Book";
      } else {
        NexusModal.close();
      }
      if (onDone) await onDone();
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Book";
    }
  }

  window.ShipmentBooking = { open };
})();
