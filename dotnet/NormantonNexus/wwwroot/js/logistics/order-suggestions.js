// MRP System tile — Order Suggestions + Tracked Orders, port of the core
// interactivity from private/js/logistics.js's osRenderSuggestions/
// osRenderTrackedList/osOpenBuildOrderModal family: Accept / Accept via
// schedule agreement, Build Order (combined order MOQ, live stock-preview
// charts) + Start New Order, per-row Save/Delete, multi-select "Save
// Selected", Assign Shipment, Create Shipment, Create PO / Assign Schedule
// Agreement, and locking Completed/Assigned-to-Shipment rows down to
// read-only (see renderTrackedRow's own comment).
//
// Manual order entry (single + bulk CSV import) now lives in the Tracked
// Orders toolbar (openManualOrderModal/openBulkImportModal), against the
// already-built PurchaseOrderSuggestionHelper.ManualAsync/ManualBulkAsync.
// Deliberately still NOT ported: inline PO-item editing. Assign Shipment
// only offers existing shipments' Unassign — the full shipment detail page
// (manual items, invoice upload, Mark Received/Undo Received, regenerate PO
// PDF) is Inbound Log's own tile.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  let trackedRows = [];
  let selectedTrackedIds = new Set();
  // Deep-link from Stock History & Forecast's "View in MRP" link (?material=X —
  // see window.__osInitialMaterial, set inline by OrderSuggestions.cshtml).
  let trackedSearchQuery = window.__osInitialMaterial || "";

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }
  function statusBadge(status) {
    const cls = status === "Received" || status === "Booked" ? "badge--success" : status === "Ordered" ? "badge--accent" : "";
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }
  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }
  function isoDateOnly(d) {
    return d ? String(d).slice(0, 10) : "";
  }

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return; // don't collapse on a button/checkbox click
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

  // Mirrors routes/performance.js's enforceMaterialQty — snaps to the
  // nearest whole MaterialMoqQty lot and clamps to MaterialMaxQty. A
  // convenience only; the server re-derives and enforces this again
  // regardless.
  function enforceQty(rawQty, materialMoqQty, materialMaxQty) {
    let q = Number(rawQty) || 0;
    if (q <= 0) return null;
    const moq = Number(materialMoqQty) || 0;
    if (moq > 0) {
      q = Math.round(q / moq) * moq;
      if (q <= 0) q = moq;
    }
    const max = Number(materialMaxQty) || 0;
    if (max > 0 && q > max) {
      q = moq > 0 ? Math.floor(max / moq) * moq : max;
      if (q <= 0) q = max;
    }
    return Math.round(q * 1000) / 1000;
  }

  // ══════════════════════════ Order Suggestions ══════════════════════════

  async function loadSuggestions() {
    const el = document.getElementById("os-suggestions");
    el.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/order-suggestions");
      renderSuggestions(data || []);
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  function renderSuggestions(groups) {
    const el = document.getElementById("os-suggestions");
    const toolbar = `
      <div class="nx-toolbar" style="margin-bottom:10px">
        <div class="nx-toolbar-title">${groups.reduce((s, g) => s + g.materials.length, 0)} need${groups.reduce((s, g) => s + g.materials.length, 0) === 1 ? "s" : ""} ordering across ${groups.length} vendor${groups.length === 1 ? "" : "s"}</div>
        <div class="nx-toolbar-spacer"></div>
        <button type="button" class="secondary" id="os-start-new-btn">Start New Order</button>
      </div>`;

    if (groups.length === 0) {
      el.innerHTML = toolbar + '<div class="nx-empty">Nothing needs ordering right now.</div>';
      document.getElementById("os-start-new-btn").addEventListener("click", openStartNewOrderPicker);
      return;
    }
    el.innerHTML = toolbar + `<div class="ps-sections">${groups
      .map((g, gi) => {
        const hasMoq = !!(g.orderMoqQty || g.orderMaxQty);
        const moqTag = hasMoq
          ? `<span class="nx-badge-tag" style="background:${g.moqMet ? "var(--success-dim)" : "var(--warn-dim)"};color:${g.moqMet ? "var(--success)" : "var(--warn)"}">${g.moqMet ? "MOQ met" : "Below MOQ"}</span>`
          : "";
        const buildOrderBtn = hasMoq
          ? `<button type="button" class="btn os-build-order-btn" data-vendor-id="${g.vendorId}" style="margin-left:auto;padding:4px 12px;font-size:11px">Build Order</button>`
          : "";
        return `
        <div class="ps-section${gi === 0 ? "" : " ps-section--collapsed"}">
          <div class="ps-section-header">
            <span class="ps-section-dot ps-section-dot--backlog"></span>
            <span class="ps-section-title">${esc(g.vendorName)}</span>
            ${moqTag}
            <span class="ps-section-count">${g.materials.length}</span>
            ${buildOrderBtn}
            <span class="ps-chevron">&#9660;</span>
          </div>
          <div class="ps-section-body">
            <div style="overflow-x:auto">
              <table>
                <thead><tr><th>Material</th><th>Current Stock</th><th>Suggested Qty</th><th>Urgency</th><th>Order By</th><th></th></tr></thead>
                <tbody>${g.materials
                  .map((m, mi) => {
                    const urgencyBadge = m.urgency === "Overdue"
                      ? '<span class="badge badge--error">Overdue</span>'
                      : '<span class="badge badge--warn">Due Soon</span>';
                    const acceptCell = hasMoq
                      ? `<span style="font-size:11px;color:var(--text-muted)">via Build Order</span>`
                      : `<button type="button" class="secondary os-accept-btn" data-gi="${gi}" data-mi="${mi}" style="padding:4px 12px;font-size:11px">Accept</button>`;
                    const forecastHref = `/Logistics/StockHistoryForecast?material=${encodeURIComponent(m.material)}&materialText=${encodeURIComponent(m.materialText || "")}`;
                    return `<tr>
                        <td><strong>${esc(m.material)}</strong><br><span style="color:var(--text-muted);font-size:11px">${esc(m.materialText || "")}</span></td>
                        <td>${Number(m.currentStock).toLocaleString()} ${esc(m.uom || "")}</td>
                        <td>${Number(m.suggestedQty).toLocaleString()} ${esc(m.uom || "")}</td>
                        <td>${urgencyBadge}</td>
                        <td>${fmtDate(m.orderByDate)}</td>
                        <td style="text-align:right;white-space:nowrap">
                          <a href="${forecastHref}" style="font-size:11px;margin-right:8px" title="View consumption history and stock forecast for this material">📈 Forecast</a>
                          ${acceptCell}
                        </td>
                      </tr>`;
                  })
                  .join("")}</tbody>
              </table>
            </div>
          </div>
        </div>`;
      })
      .join("")}</div>`;
    wireCollapseToggles(el);

    el.querySelectorAll(".os-accept-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = groups[Number(btn.dataset.gi)];
        openAcceptModal(g.materials[Number(btn.dataset.mi)]);
      });
    });
    document.getElementById("os-start-new-btn").addEventListener("click", openStartNewOrderPicker);
    el.querySelectorAll(".os-build-order-btn").forEach((btn) => {
      btn.addEventListener("click", () => openBuildOrderModal(btn.dataset.vendorId));
    });
  }

  function openAcceptModal(s) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Accept Order Suggestion</div><div class="ps-modal-sub">${esc(s.material)} — ${esc(s.vendorName)}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Order Qty</label>
            <input class="tf-input" type="number" step="${s.materialMoqQty || 0.001}" id="os-order-qty" value="${s.suggestedQty}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Order Date</label>
            <input class="tf-input" type="date" id="os-order-date" value="${todayIso()}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Delivery Date (optional — leave blank to auto-calculate from lead time)</label>
            <input class="tf-input" type="date" id="os-delivery-date" value="">
          </div>
        </div>
        ${s.materialMoqQty ? `<p style="font-size:12px;color:var(--text-muted)">This vendor only supplies in ${Number(s.materialMoqQty).toLocaleString()} ${esc(s.uom || "")} lots — order in whole multiples.</p>` : ""}
        ${s.isSpotPo
          ? `<p style="font-size:12px;color:var(--warn)">No schedule agreement for this material — this will need a spot PO raised manually in SAP.</p>`
          : `<p style="font-size:12px;color:var(--text-muted)">Schedule agreement ${esc(s.scheduleAgreement || "")} — release against this in SAP once ordered.</p>`}
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes</label>
            <input class="tf-input" type="text" id="os-notes" value="">
          </div>
        </div>
        <div id="os-accept-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="os-accept-cancel">Cancel</button>
        <button type="button" class="btn" id="os-accept-save-btn">Accept Order</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#os-accept-cancel").addEventListener("click", () => NexusModal.close());

    const qtyInput = card.querySelector("#os-order-qty");
    qtyInput.addEventListener("blur", function () {
      const enforced = enforceQty(this.value, s.materialMoqQty, s.materialMaxQty);
      if (enforced != null) this.value = enforced;
    });

    card.querySelector("#os-accept-save-btn").addEventListener("click", async () => {
      const enforcedQty = enforceQty(qtyInput.value, s.materialMoqQty, s.materialMaxQty);
      if (enforcedQty != null) qtyInput.value = enforcedQty;
      const result = card.querySelector("#os-accept-result");
      if (!enforcedQty) {
        result.innerHTML = '<div class="tf-inline-error">Order qty is required.</div>';
        return;
      }
      const btn = card.querySelector("#os-accept-save-btn");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await api("/order-suggestions/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendorMaterialId: s.vendorMaterialId,
            vendorId: s.vendorId,
            material: s.material,
            suggestedQty: s.suggestedQty,
            orderQty: enforcedQty,
            orderDate: card.querySelector("#os-order-date").value || null,
            deliveryDate: card.querySelector("#os-delivery-date").value || null,
            leadTimeDays: s.leadTimeDays,
            transitTimeDays: s.transitTimeDays,
            isSpotPo: s.isSpotPo,
            notes: card.querySelector("#os-notes").value.trim() || null,
          }),
        });
        NexusModal.close();
        loadSuggestions();
        loadTracked();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = "Accept Order";
      }
    });
  }

  // ══════════════════════════ Build Order (combined order MOQ) ══════════════════════════

  // Mirrors routes/performance.js's addWorkingDaysUtc — client-side only, purely to
  // pre-fill the delivery-date field from lead time as a convenience default. The
  // server independently recomputes/validates the real delivery date when the order
  // is actually accepted, so this never needs to be authoritative.
  function addWorkingDaysUtc(dateStr, days) {
    const result = new Date(dateStr + "T00:00:00Z");
    const step = days >= 0 ? 1 : -1;
    let remaining = Math.abs(Math.round(Number(days) || 0));
    while (remaining > 0) {
      result.setUTCDate(result.getUTCDate() + step);
      const dow = result.getUTCDay();
      if (dow !== 0 && dow !== 6) remaining -= 1;
    }
    return result.toISOString().slice(0, 10);
  }

  const URGENCY_LABEL = { Overdue: "Overdue", DueSoon: "Due Soon", Upcoming: "Upcoming", NotDue: "Not due" };

  let buildPreviewCharts = [];
  let buildPreviewTimer = null;

  function destroyBuildPreviewCharts() {
    buildPreviewCharts.forEach((c) => { try { c.destroy(); } catch { /* already gone */ } });
    buildPreviewCharts = [];
  }

  function scheduleBuildPreview(build) {
    clearTimeout(buildPreviewTimer);
    buildPreviewTimer = setTimeout(() => refreshBuildPreview(build), 400);
  }

  // Re-requests the live what-if stock forecast for whatever's currently checked/
  // quantified in the Build Order modal, and redraws one small stock chart per
  // checked material. Nothing here is persisted — POST /order-suggestions/preview
  // is a pure computation. Chart.js must already be loaded on the page for this to
  // draw anything (see StockHistoryForecast.cshtml's own CDN include) — the Order
  // Suggestions page loads it too, only for this modal's charts.
  async function refreshBuildPreview(build) {
    const panel = document.getElementById("os-build-chart-panel");
    if (!panel) return;

    const deliveryDate = document.getElementById("os-build-delivery-date")?.value;
    const items = [];
    document.querySelectorAll(".os-build-check").forEach((cb) => {
      if (!cb.checked) return;
      const qtyInput = document.querySelector(`.os-build-qty[data-i="${cb.dataset.i}"]`);
      const qty = Number(qtyInput?.value) || 0;
      if (qty <= 0) return;
      const m = build.materials[Number(cb.dataset.i)];
      items.push({ material: m.material, orderQty: qty });
    });

    destroyBuildPreviewCharts();
    if (!deliveryDate || !items.length) {
      panel.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Check at least one material with a qty greater than 0, and set a delivery date, to preview its effect on stock levels.</p>';
      return;
    }

    panel.innerHTML = '<div class="nx-toolbar-hint">Updating stock preview…</div>';
    try {
      const { data } = await api("/order-suggestions/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryDate, items }),
      });
      panel.innerHTML = `
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:12px 0 10px">Live Stock Preview — with this order's delivery included</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          ${data.map((d, i) => `
            <div>
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(d.material)}${d.materialText ? " — " + esc(d.materialText) : ""}</div>
              ${d.error ? `<div class="tf-inline-error">${esc(d.error)}</div>` : `<canvas id="os-build-chart-${i}" style="max-height:220px"></canvas>`}
            </div>`).join("")}
        </div>`;

      data.forEach((d, i) => {
        if (d.error || !d.stockForecast || typeof Chart === "undefined") return;
        const canvas = document.getElementById(`os-build-chart-${i}`);
        if (!canvas) return;
        buildPreviewCharts.push(new Chart(canvas, {
          type: "line",
          data: {
            labels: [d.stockForecast.asOfDate, ...d.stockForecast.weeks.map((w) => w.weekEnding)],
            datasets: [{
              label: "Expected Stock Level",
              data: [Math.max(0, d.stockForecast.currentStock), ...d.stockForecast.weeks.map((w) => Math.max(0, w.expectedStock))],
              borderColor: "#7C3AED", backgroundColor: "rgba(124,58,237,0.10)", fill: true, tension: 0.2, pointRadius: 2,
            }],
          },
          options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 9 } } }, y: { min: 0, ticks: { font: { size: 9 } } } } },
        }));
      });
    } catch (err) {
      panel.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  // Lets a buyer pick ANY vendor (not just one with a currently-due suggestion) and
  // go straight into Build Order for it — computeVendorOrderBuild returns every
  // material the vendor supplies regardless of urgency, so the same modal works
  // unchanged for a vendor with nothing due yet.
  async function openStartNewOrderPicker() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div class="ps-modal-title">Start New Order</div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-field">
          <label class="tf-label">Vendor</label>
          <select class="tf-input" id="os-start-new-vendor-select"><option value="">Loading vendors…</option></select>
        </div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="os-start-new-cancel">Cancel</button>
        <button type="button" class="btn" id="os-start-new-continue-btn" disabled>Continue</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#os-start-new-cancel").addEventListener("click", () => NexusModal.close());

    const sel = card.querySelector("#os-start-new-vendor-select");
    const continueBtn = card.querySelector("#os-start-new-continue-btn");
    try {
      const { data } = await api("/vendors");
      const vendors = (data || []).filter((v) => Number(v.materialCount) > 0);
      sel.innerHTML = '<option value="">Select a vendor…</option>' + vendors.map((v) => `<option value="${v.vendorId}">${esc(v.vendorName)}</option>`).join("");
    } catch (err) {
      sel.innerHTML = `<option value="">${esc(err.message)}</option>`;
    }
    sel.addEventListener("change", () => { continueBtn.disabled = !sel.value; });
    continueBtn.addEventListener("click", () => {
      const vendorId = sel.value;
      NexusModal.close();
      if (vendorId) openBuildOrderModal(vendorId, true);
    });
  }

  // Combines several materials from one vendor into a single order — the way a
  // combined order-level MOQ (Vendor.OrderMoqQty) actually gets managed. Lists
  // every material this vendor supplies (not only the ones currently due),
  // pre-checks the ones that are, and shows the running total against the MOQ
  // live as materials are checked/unchecked or quantities adjusted.
  async function openBuildOrderModal(vendorId, proactive) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${proactive ? "Start New Order" : "Build Order"}</div><div class="ps-modal-sub" id="os-build-vendor-name">Loading…</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div id="os-build-body"><div class="nx-toolbar-hint">Loading…</div></div>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => { destroyBuildPreviewCharts(); NexusModal.close(); });

    try {
      const { data } = await api(`/order-suggestions/vendor/${vendorId}/build`);
      renderBuildOrderForm(card, data);
    } catch (err) {
      card.querySelector("#os-build-body").innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function renderBuildOrderForm(card, build) {
    card.querySelector("#os-build-vendor-name").textContent = build.vendorName;
    const todayStr = todayIso();

    const rows = build.materials.map((m, i) => {
      const checked = m.dueNow && m.suggestedQty > 0;
      return `
        <tr>
          <td><input type="checkbox" class="os-build-check" data-i="${i}" ${checked ? "checked" : ""}></td>
          <td><strong>${esc(m.material)}</strong><div style="font-size:11px;color:var(--text-muted)">${esc(m.materialText || "")}</div></td>
          <td>${esc(URGENCY_LABEL[m.urgency] || m.urgency)}${m.orderByDate ? `<div style="font-size:11px">by ${fmtDate(m.orderByDate)}</div>` : ""}</td>
          <td>${Number(m.currentStock).toLocaleString()} ${esc(m.uom || "")}</td>
          <td>
            <input class="tf-input os-build-qty" type="number" step="${m.materialMoqQty || 0.001}" data-i="${i}" value="${checked ? m.suggestedQty : ""}" style="width:90px">
            ${m.materialMoqQty ? `<div style="font-size:10px;color:var(--text-muted)">lots of ${Number(m.materialMoqQty).toLocaleString()}</div>` : ""}
          </td>
        </tr>`;
    }).join("");

    const initiallyCheckedLeads = build.materials.filter((m) => m.dueNow && m.suggestedQty > 0).map((m) => Number(m.leadTimeDays) || 0);
    const initialLeadTime = initiallyCheckedLeads.length ? Math.max(...initiallyCheckedLeads) : (Number(build.defaultLeadTimeDays) || 0);
    const initialDeliveryDate = addWorkingDaysUtc(todayStr, initialLeadTime);

    card.querySelector("#os-build-body").innerHTML = `
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Order Date</label>
          <input class="tf-input" type="date" id="os-build-order-date" value="${todayStr}">
        </div>
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Delivery Date (earliest possible, from lead time — editable)</label>
          <input class="tf-input" type="date" id="os-build-delivery-date" value="${initialDeliveryDate}">
        </div>
      </div>
      <div style="overflow-x:auto;max-height:320px;overflow-y:auto">
        <table>
          <thead><tr><th></th><th>Material</th><th>Status</th><th>Current Stock</th><th>Order Qty</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="os-build-moq-status" style="margin-top:12px;padding:10px;border-radius:6px;font-size:13px"></div>
      <div id="os-build-chart-panel"></div>
      <div id="os-build-result"></div>
      <div class="ps-modal-actions" style="margin-top:14px">
        <button type="button" class="secondary" id="os-build-cancel-btn">Cancel</button>
        <button type="button" class="btn" id="os-build-save-btn">Accept Order</button>
      </div>`;

    card.querySelector("#os-build-cancel-btn").addEventListener("click", () => { destroyBuildPreviewCharts(); NexusModal.close(); });

    let deliveryDateTouched = false;
    function recalcDeliveryDatePrefill() {
      if (deliveryDateTouched) return;
      const orderDate = card.querySelector("#os-build-order-date").value || todayStr;
      const checkedLeads = [];
      card.querySelectorAll(".os-build-check").forEach((cb) => {
        if (!cb.checked) return;
        checkedLeads.push(Number(build.materials[Number(cb.dataset.i)].leadTimeDays) || 0);
      });
      const lead = checkedLeads.length ? Math.max(...checkedLeads) : (Number(build.defaultLeadTimeDays) || 0);
      card.querySelector("#os-build-delivery-date").value = addWorkingDaysUtc(orderDate, lead);
    }
    card.querySelector("#os-build-delivery-date").addEventListener("input", () => { deliveryDateTouched = true; });
    card.querySelector("#os-build-order-date").addEventListener("change", () => { recalcDeliveryDatePrefill(); scheduleBuildPreview(build); });
    card.querySelector("#os-build-delivery-date").addEventListener("change", () => scheduleBuildPreview(build));

    // Enforced (not hinted): a multi-material combined total can't be
    // auto-corrected the way a single material's lot size can — there's no
    // non-arbitrary way to decide which material to bump or trim — so this
    // disables Accept Order instead of showing a dismissible warning.
    function updateMoqStatus() {
      let total = 0;
      card.querySelectorAll(".os-build-check").forEach((cb) => {
        if (cb.checked) total += Number(card.querySelector(`.os-build-qty[data-i="${cb.dataset.i}"]`).value) || 0;
      });
      total = Math.round(total * 1000) / 1000;
      const statusEl = card.querySelector("#os-build-moq-status");
      const saveBtn = card.querySelector("#os-build-save-btn");
      const min = build.orderMoqQty != null ? Number(build.orderMoqQty) : null;
      const max = build.orderMaxQty != null ? Number(build.orderMaxQty) : null;
      const uom = build.orderMoqUom || "";
      const hasConstraint = !!(min || max);

      let ok = true;
      let msg;
      if (!hasConstraint) {
        msg = `Combined qty: ${total.toLocaleString()} — this vendor has no combined order MOQ.`;
      } else if (min && max && min === max) {
        ok = Math.abs(total - min) <= 0.001;
        msg = ok
          ? `Combined qty: ${total.toLocaleString()} ${uom} — matches the required exact quantity.`
          : `Combined qty: ${total.toLocaleString()} — ${esc(build.vendorName)} requires EXACTLY ${min.toLocaleString()} ${uom}, not just a minimum. ${total < min ? `Add ${(min - total).toLocaleString()} more` : `Remove ${(total - min).toLocaleString()}`} to match.`;
      } else {
        const shortfall = min ? Math.max(0, min - total) : 0;
        const overage = max ? Math.max(0, total - max) : 0;
        ok = shortfall <= 0.001 && overage <= 0.001;
        if (shortfall > 0.001) {
          msg = `Combined qty: ${total.toLocaleString()} / ${min.toLocaleString()} ${uom} MOQ — short by ${shortfall.toLocaleString()}. Check more materials or increase quantities to clear the minimum.`;
        } else if (overage > 0.001) {
          msg = `Combined qty: ${total.toLocaleString()} / ${max.toLocaleString()} ${uom} max — over by ${overage.toLocaleString()}. Uncheck materials or reduce quantities to fit under the cap.`;
        } else {
          msg = `Combined qty: ${total.toLocaleString()}${min ? ` / ${min.toLocaleString()}` : ""}${max ? ` – ${max.toLocaleString()}` : ""} ${uom} — met.`;
        }
      }

      statusEl.style.background = !hasConstraint ? "var(--surface2)" : ok ? "var(--success-dim)" : "var(--error-dim)";
      statusEl.style.color = !hasConstraint ? "" : ok ? "var(--success)" : "var(--error)";
      statusEl.textContent = msg;
      if (saveBtn) saveBtn.disabled = !ok;
      return total;
    }

    card.querySelectorAll(".os-build-check, .os-build-qty").forEach((elm) => {
      elm.addEventListener("input", updateMoqStatus);
      elm.addEventListener("change", updateMoqStatus);
      elm.addEventListener("input", () => scheduleBuildPreview(build));
      elm.addEventListener("change", () => scheduleBuildPreview(build));
    });
    card.querySelectorAll(".os-build-check").forEach((elm) => elm.addEventListener("change", recalcDeliveryDatePrefill));

    // Per-material enforcement (not hinted): snap to the nearest MOQ lot and
    // clamp to the material's max on blur, same as the single Accept modal.
    card.querySelectorAll(".os-build-qty").forEach((elm) => {
      elm.addEventListener("blur", () => {
        const m = build.materials[Number(elm.dataset.i)];
        const enforced = enforceQty(elm.value, m.materialMoqQty, m.materialMaxQty);
        if (enforced != null) elm.value = enforced;
        updateMoqStatus();
        scheduleBuildPreview(build);
      });
    });
    updateMoqStatus();
    refreshBuildPreview(build);

    card.querySelector("#os-build-save-btn").addEventListener("click", async () => {
      const deliveryDate = card.querySelector("#os-build-delivery-date").value || null;
      const items = [];
      card.querySelectorAll(".os-build-check").forEach((cb) => {
        if (!cb.checked) return;
        const m = build.materials[Number(cb.dataset.i)];
        const qtyInput = card.querySelector(`.os-build-qty[data-i="${cb.dataset.i}"]`);
        const enforced = enforceQty(qtyInput.value, m.materialMoqQty, m.materialMaxQty);
        if (enforced == null) return;
        qtyInput.value = enforced;
        items.push({
          vendorMaterialId: m.vendorMaterialId,
          material: m.material,
          suggestedQty: m.suggestedQty,
          orderQty: enforced,
          leadTimeDays: m.leadTimeDays,
          transitTimeDays: m.transitTimeDays,
          isSpotPo: m.isSpotPo,
          deliveryDate,
        });
      });

      const resultEl = card.querySelector("#os-build-result");
      if (!items.length) {
        resultEl.innerHTML = '<div class="tf-inline-error">Check at least one material with a qty greater than 0.</div>';
        return;
      }

      updateMoqStatus();
      if (card.querySelector("#os-build-save-btn").disabled) {
        resultEl.innerHTML = `<div class="tf-inline-error">This combination doesn't satisfy ${esc(build.vendorName)}'s combined order requirement above — adjust quantities or materials.</div>`;
        return;
      }

      const btn = card.querySelector("#os-build-save-btn");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api("/order-suggestions/accept-batch", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vendorId: build.vendorId, orderDate: card.querySelector("#os-build-order-date").value || null, items }),
        });
        destroyBuildPreviewCharts();
        NexusModal.close();
        loadSuggestions();
        loadTracked();
      } catch (err) {
        resultEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Accept Order";
      }
    });
  }

  // ══════════════════════════ Tracked Orders ══════════════════════════

  const BUCKET_DOT = { overdueShipping: "priority", needsBooking: "priority", needs: "backlog", assigned: "week", completed: "today", cancelled: "other" };

  function dispatchUrgency(t) {
    if (!t.readyToCollectDate) return null;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const dispatch = new Date(isoDateOnly(t.readyToCollectDate) + "T00:00:00Z");
    const diffDays = Math.round((dispatch.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return "Overdue";
    if (diffDays === 0) return "Today";
    if (diffDays <= 7) return "ThisWeek";
    return "Future";
  }
  function effectiveDispatchDate(t) { const d = t.readyToCollectDate || t.deliveryDate; return d ? new Date(d).getTime() : Infinity; }
  function effectiveDeliveryDate(t) { return t.deliveryDate ? new Date(t.deliveryDate).getTime() : Infinity; }

  const BUCKET_DEFS = [
    { key: "overdueShipping", label: "Overdue for Shipping", sortBy: "dispatch", match: (t) => t.status === "Ordered" && !t.shipmentId && dispatchUrgency(t) === "Overdue" },
    { key: "needsBooking", label: "Needs Booking", sortBy: "delivery", match: (t) => t.status === "Accepted" },
    { key: "needs", label: "Ordered", sortBy: "dispatch", match: (t) => t.status === "Ordered" && !t.shipmentId && dispatchUrgency(t) !== "Overdue" },
    { key: "assigned", label: "Assigned to Shipment", sortBy: "delivery", match: (t) => t.status === "Ordered" && !!t.shipmentId },
    { key: "completed", label: "Completed", sortBy: "delivery", match: (t) => t.status === "Received" || t.status === "Booked" },
    { key: "cancelled", label: "Cancelled", sortBy: "delivery", match: (t) => t.status === "Cancelled" },
  ];

  const STATUS_OPTIONS = ["Accepted", "Ordered", "Booked", "Received", "Cancelled"];

  function matchesSearch(t, query) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return String(t.material || "").toLowerCase().includes(needle)
      || String(t.materialText || "").toLowerCase().includes(needle)
      || String(t.poNumber || "").toLowerCase().includes(needle);
  }

  function renderTrackedRow(t, bucketKey) {
    const id = t.suggestionId;
    const overdueHint = t.status === "Ordered" && !t.shipmentId && dispatchUrgency(t) === "Overdue" && t.deliveryDate
      ? `<div style="font-size:10.5px;color:var(--error);margin-top:2px">was due ${fmtDate(t.deliveryDate)}</div>`
      : "";
    const shipmentCell = t.shipmentId
      ? `<button type="button" class="os-shipment-link" data-shipment-id="${t.shipmentId}" style="background:none;border:none;padding:0;color:var(--accent);text-decoration:underline;cursor:pointer;font:inherit">${esc(t.shipmentReference || t.haulier || "Assigned")}</button>`
      : "—";

    // Completed (Received/Booked) orders are locked — nothing here is still
    // editable, so no inputs/buttons at all. Assigned-to-shipment orders are
    // also locked, except a single "Remove from Shipment" action — you can't
    // silently pluck one order off a booked shipment; the only way off is to
    // cancel the shipment itself (see openRemoveFromShipmentModal).
    const readOnly = bucketKey === "completed" || bucketKey === "assigned";

    const qtyCell = readOnly
      ? `${Number(t.orderQty).toLocaleString()}`
      : `<input class="tf-input os-qty-input" data-id="${id}" type="number" step="0.001" value="${t.orderQty}" style="width:70px">`;
    const dispatchCell = readOnly
      ? fmtDate(t.readyToCollectDate) || "—"
      : `<input class="tf-input os-dispatch-date-input" data-id="${id}" type="date" value="${isoDateOnly(t.readyToCollectDate)}" style="width:128px">`;
    const deliveryCell = readOnly
      ? (fmtDate(t.deliveryDate) || "—") + overdueHint
      : `<input class="tf-input os-delivery-date-input" data-id="${id}" type="date" value="${isoDateOnly(t.deliveryDate)}" style="width:128px">${overdueHint}`;
    const statusCell = readOnly
      ? statusBadge(t.status)
      : `<select class="tf-input os-status-select" data-id="${id}" style="width:96px">
          ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>`;
    const poCell = readOnly ? esc(t.poNumber || "—") : `<input class="tf-input os-po-input" data-id="${id}" type="text" value="${esc(t.poNumber || "")}" title="${esc(t.poNumber || "")}" style="width:92px">`;
    const poItemCell = readOnly ? esc(t.poItemNumber || "—") : `<input class="tf-input os-po-item-input" data-id="${id}" type="text" value="${esc(t.poItemNumber || "")}" title="${esc(t.poItemNumber || "")}" style="width:58px">`;
    const supplierRefCell = readOnly ? esc(t.supplierReference || "—") : `<input class="tf-input os-supplier-ref-input" data-id="${id}" type="text" value="${esc(t.supplierReference || "")}" title="${esc(t.supplierReference || "")}" style="width:110px">`;

    const actionsCell = bucketKey === "completed"
      ? ""
      : bucketKey === "assigned"
        ? `<button type="button" class="secondary os-remove-from-shipment-btn" data-id="${id}" style="padding:3px 7px;font-size:10.5px">Remove from Shipment</button>`
        : `<button type="button" class="secondary os-save-btn" data-id="${id}" style="padding:3px 7px;font-size:10.5px">Save</button>
           <button type="button" class="secondary os-shipment-btn" data-id="${id}" style="padding:3px 7px;font-size:10.5px">Ship…</button>
           <button type="button" class="secondary os-delete-btn" data-id="${id}" style="padding:3px 7px;font-size:10.5px;color:var(--error)">Delete</button>`;

    return `<tr data-id="${id}">
      <td style="width:22px;padding-right:0"><input type="checkbox" class="os-check" data-id="${id}" ${readOnly ? "disabled title=\"Completed and assigned orders can't be bulk-actioned\"" : ""}></td>
      <td style="max-width:175px"><strong>${esc(t.material)}</strong><br><span style="color:var(--text-muted);font-size:10.5px">${esc(t.materialText || "")}</span></td>
      <td>${qtyCell}</td>
      <td style="white-space:nowrap">${fmtDate(t.orderDate)}</td>
      <td>${dispatchCell}</td>
      <td>${deliveryCell}</td>
      <td>${statusCell}</td>
      <td>${poCell}</td>
      <td>${poItemCell}</td>
      <td>${supplierRefCell}</td>
      <td style="max-width:105px">${shipmentCell}</td>
      <td style="white-space:nowrap">${actionsCell}</td>
    </tr>`;
  }

  function renderTrackedList(tracked, query) {
    trackedRows = tracked;
    const rows = query ? tracked.filter((t) => matchesSearch(t, query)) : tracked;
    const tableHead = "<thead><tr><th></th><th>Material</th><th>Qty</th><th>Order Date</th><th>Exp. Dispatch</th><th>Exp. Delivery</th><th>Status</th><th>PO Number</th><th>PO Item</th><th>Supplier Ref</th><th>Shipment</th><th></th></tr></thead>";

    const bucketSections = BUCKET_DEFS.map((bd, bi) => {
      const bucketRows = rows.filter(bd.match);
      if (!bucketRows.length) return "";
      const byVendor = {};
      bucketRows.forEach((t) => { const key = t.vendorName || "Unknown Vendor"; (byVendor[key] = byVendor[key] || []).push(t); });
      const sortFn = bd.sortBy === "dispatch" ? effectiveDispatchDate : effectiveDeliveryDate;
      Object.values(byVendor).forEach((g) => g.sort((a, b) => sortFn(a) - sortFn(b)));
      // Completed/Assigned rows can't be bulk-actioned (no editable fields, no
      // Create Shipment/Save Selected target) — the select-all checkboxes for
      // those buckets would just be misleading, so they're left out entirely.
      const bucketLocked = bd.key === "completed" || bd.key === "assigned";
      const bucketFullySelected = !bucketLocked && bucketRows.every((t) => selectedTrackedIds.has(Number(t.suggestionId)));
      const vendorGroups = Object.keys(byVendor).sort((a, b) => a.localeCompare(b)).map((name) => {
        const groupFullySelected = !bucketLocked && byVendor[name].every((t) => selectedTrackedIds.has(Number(t.suggestionId)));
        return `
        <div class="ps-section ps-section--nested${query ? "" : " ps-section--collapsed"}" data-group="${esc(name)}">
          <div class="ps-section-header">
            ${bucketLocked ? "" : `<input type="checkbox" class="os-group-select-all" ${groupFullySelected ? "checked" : ""} title="Select all for ${esc(name)}">`}
            <span class="ps-section-dot ps-section-dot--other"></span>
            <span class="ps-section-title">${esc(name)}</span>
            <span class="ps-section-count">${byVendor[name].length}</span>
            <span class="ps-chevron">&#9660;</span>
          </div>
          <div class="ps-section-body"><div>
            <table class="table--compact">${tableHead}<tbody>${byVendor[name].map((t) => renderTrackedRow(t, bd.key)).join("")}</tbody></table>
          </div></div>
        </div>`;
      }).join("");
      return `
      <div class="ps-section${bi === 0 && !query ? "" : query ? "" : " ps-section--collapsed"}" data-bucket="${bd.key}">
        <div class="ps-section-header">
          ${bucketLocked ? "" : `<input type="checkbox" class="os-bucket-select-all" ${bucketFullySelected ? "checked" : ""} title="Select all in ${esc(bd.label)}">`}
          <span class="ps-section-dot ps-section-dot--${BUCKET_DOT[bd.key]}"></span>
          <span class="ps-section-title">${bd.label}</span>
          <span class="ps-section-count">${bucketRows.length}</span>
          <span class="ps-chevron">&#9660;</span>
        </div>
        <div class="ps-section-body"><div class="ps-sections ps-sections--nested">${vendorGroups}</div></div>
      </div>`;
    }).join("");

    const el = document.getElementById("os-tracked");
    el.innerHTML = `
      <div class="nx-toolbar">
        <div>
          <div class="nx-toolbar-title" id="os-selection-hint">${selectedTrackedIds.size ? `${selectedTrackedIds.size} order line${selectedTrackedIds.size === 1 ? "" : "s"} selected` : `${tracked.length} tracked order${tracked.length === 1 ? "" : "s"}`}</div>
          <div class="nx-toolbar-hint">Grouped by status, then vendor — click a row's group to expand it.</div>
        </div>
        <div class="nx-toolbar-spacer"></div>
        <input type="text" id="os-search-input" placeholder="Search by part number or PO…" value="${esc(query || "")}">
        <button type="button" class="secondary" id="os-add-manual-btn">+ Add Manual Order</button>
        <button type="button" class="secondary" id="os-bulk-import-btn">Bulk Import (CSV)</button>
        <button type="button" class="secondary" id="os-save-selected-btn" ${selectedTrackedIds.size ? "" : "disabled"}>Save Selected</button>
        <button type="button" class="secondary" id="os-create-shipment-btn" ${selectedTrackedIds.size ? "" : "disabled"}>Create Shipment</button>
        <button type="button" class="btn" id="os-create-po-btn" ${createPoOrAssignScheduleSelectionValid() ? "" : "disabled"}>Create PO / Assign Schedule</button>
      </div>
      ${rows.length ? `<div class="ps-sections">${bucketSections}</div>` : `<div class="nx-empty">${query ? `No tracked orders match "${esc(query)}".` : "No accepted orders yet."}</div>`}
    `;
    wireCollapseToggles(el);
    wireTrackedListEvents(el, rows);
  }

  function wireTrackedListEvents(el, rows) {
    const input = document.getElementById("os-search-input");
    input.addEventListener("input", () => {
      const caret = input.selectionStart;
      trackedSearchQuery = input.value;
      renderTrackedList(trackedRows, trackedSearchQuery);
      const newInput = document.getElementById("os-search-input");
      newInput.focus();
      newInput.setSelectionRange(caret, caret);
    });

    document.getElementById("os-add-manual-btn").addEventListener("click", openManualOrderModal);
    document.getElementById("os-bulk-import-btn").addEventListener("click", openBulkImportModal);
    document.getElementById("os-save-selected-btn").addEventListener("click", saveSelected);
    document.getElementById("os-create-shipment-btn").addEventListener("click", openCreateShipmentModal);
    document.getElementById("os-create-po-btn").addEventListener("click", handleCreatePoOrAssignSchedule);

    el.querySelectorAll(".os-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selectedTrackedIds.add(id); else selectedTrackedIds.delete(id);
      refreshSelectionUi();
    }));
    el.querySelectorAll(".os-bucket-select-all, .os-group-select-all").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        const section = cb.closest(".ps-section");
        section.querySelectorAll(".os-check").forEach((check) => {
          check.checked = cb.checked;
          const id = Number(check.dataset.id);
          if (cb.checked) selectedTrackedIds.add(id); else selectedTrackedIds.delete(id);
        });
        refreshSelectionUi();
      });
    });
    el.querySelectorAll(".os-save-btn").forEach((btn) => btn.addEventListener("click", () => {
      const t = rows.find((x) => String(x.suggestionId) === btn.dataset.id);
      if (t) saveTrackedRow(t, btn);
    }));
    el.querySelectorAll(".os-delete-btn").forEach((btn) => btn.addEventListener("click", () => {
      const t = rows.find((x) => String(x.suggestionId) === btn.dataset.id);
      if (t) deleteTracked(t, btn);
    }));
    el.querySelectorAll(".os-shipment-btn").forEach((btn) => btn.addEventListener("click", () => {
      const t = rows.find((x) => String(x.suggestionId) === btn.dataset.id);
      if (t) openAssignShipmentModal(t);
    }));
    el.querySelectorAll(".os-remove-from-shipment-btn").forEach((btn) => btn.addEventListener("click", () => {
      const t = rows.find((x) => String(x.suggestionId) === btn.dataset.id);
      if (t) openRemoveFromShipmentModal(t);
    }));
    el.querySelectorAll(".os-shipment-link").forEach((btn) => btn.addEventListener("click", () => {
      window.ShipmentDetailModal.open(Number(btn.dataset.shipmentId), { onChange: loadTracked });
    }));
  }

  // Assigned-to-shipment orders can't be edited or unassigned individually —
  // the only way off a booked shipment is to cancel the shipment itself,
  // which unassigns every order on it (back to Ordered, matching how the
  // bucket definitions are purely derived from status+shipmentId). Two-step
  // confirm: first "cancel or leave as is", then — only if the shipment
  // carries other orders too — a second, explicit warning naming how many.
  async function openRemoveFromShipmentModal(t) {
    const shipmentLabel = t.shipmentReference || t.haulier || `shipment #${t.shipmentId}`;
    const wantsCancel = await NexusModal.confirm(
      `${t.material} is assigned to ${shipmentLabel}. There's no way to remove just this one order without cancelling the whole shipment.`,
      { title: "Remove from Shipment", confirmLabel: "Cancel Shipment", cancelLabel: "Leave As Is" });
    if (!wantsCancel) return;

    const others = trackedRows.filter((x) => x.shipmentId === t.shipmentId && x.suggestionId !== t.suggestionId);
    if (others.length) {
      const stillCancel = await NexusModal.confirm(
        `${shipmentLabel} also has ${others.length} other order${others.length === 1 ? "" : "s"} assigned — cancelling it will unassign ${others.length === 1 ? "that one" : "those"} too and return ${others.length === 1 ? "it" : "them"} to Ordered. Still cancel?`,
        { confirmLabel: "Cancel Shipment", danger: true });
      if (!stillCancel) return;
    }

    try {
      await api(`/order-suggestions/shipments/${t.shipmentId}/cancel`, { method: "POST" });
      loadTracked();
    } catch (err) {
      await NexusModal.alert(err.message);
    }
  }

  function refreshSelectionUi() {
    const hint = document.getElementById("os-selection-hint");
    if (hint) hint.textContent = selectedTrackedIds.size
      ? `${selectedTrackedIds.size} order line${selectedTrackedIds.size === 1 ? "" : "s"} selected`
      : `${trackedRows.length} tracked order${trackedRows.length === 1 ? "" : "s"}`;
    const shipBtn = document.getElementById("os-create-shipment-btn");
    if (shipBtn) shipBtn.disabled = selectedTrackedIds.size === 0;
    const saveSelBtn = document.getElementById("os-save-selected-btn");
    if (saveSelBtn) saveSelBtn.disabled = selectedTrackedIds.size === 0;
    const poBtn = document.getElementById("os-create-po-btn");
    if (poBtn) poBtn.disabled = !createPoOrAssignScheduleSelectionValid();
  }

  // Reads the on-screen inputs for one tracked row and PUTs them.
  async function saveOneTracked(t) {
    const id = t.suggestionId;
    const statusSelect = document.querySelector(`.os-status-select[data-id="${id}"]`);
    const poInput = document.querySelector(`.os-po-input[data-id="${id}"]`);
    const poItemInput = document.querySelector(`.os-po-item-input[data-id="${id}"]`);
    const supplierRefInput = document.querySelector(`.os-supplier-ref-input[data-id="${id}"]`);
    const qtyInput = document.querySelector(`.os-qty-input[data-id="${id}"]`);
    const dispatchDateInput = document.querySelector(`.os-dispatch-date-input[data-id="${id}"]`);
    const deliveryDateInput = document.querySelector(`.os-delivery-date-input[data-id="${id}"]`);
    if (!statusSelect || !qtyInput) return { success: false, error: "Row is not on screen (try expanding its group)." };

    const qtyValue = Number(qtyInput.value);
    if (!qtyValue || qtyValue <= 0) return { success: false, error: "Quantity must be greater than 0." };

    const body = {
      status: statusSelect.value,
      poNumber: poInput.value.trim() || null,
      poItemNumber: poItemInput.value.trim() || null,
      supplierReference: supplierRefInput.value.trim() || null,
      notes: t.notes || null,
      orderQty: qtyValue,
    };
    if (dispatchDateInput.value) body.readyToCollectDate = dispatchDateInput.value;
    if (deliveryDateInput.value) body.deliveryDate = deliveryDateInput.value;

    try {
      await api(`/order-suggestions/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function saveTrackedRow(t, btn) {
    btn.disabled = true; btn.textContent = "Saving…";
    const result = await saveOneTracked(t);
    if (!result.success) {
      await NexusModal.alert(result.error);
      btn.disabled = false; btn.textContent = "Save";
      return;
    }
    loadTracked();
  }

  async function deleteTracked(t, btn) {
    const ok = await NexusModal.confirm(
      `Delete this tracked order for ${t.material} — ${t.vendorName}? This permanently removes it, it won't just be marked Cancelled. This cannot be undone.`,
      { confirmLabel: "Delete", danger: true });
    if (!ok) return;
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      await api(`/order-suggestions/${t.suggestionId}`, { method: "DELETE" });
      loadTracked();
    } catch (err) {
      await NexusModal.alert(err.message);
      btn.disabled = false; btn.textContent = "Delete";
    }
  }

  async function saveSelected() {
    const btn = document.getElementById("os-save-selected-btn");
    if (!btn || selectedTrackedIds.size === 0) return;
    const ids = [...selectedTrackedIds];
    const rows = trackedRows.filter((t) => ids.includes(Number(t.suggestionId)));
    btn.disabled = true; btn.textContent = "Saving…";
    const failures = [];
    for (const t of rows) {
      const result = await saveOneTracked(t);
      if (!result.success) failures.push(`${t.material}: ${result.error}`);
    }
    btn.disabled = false; btn.textContent = "Save Selected";
    if (failures.length) await NexusModal.alert(failures.join("\n"), { title: "Some rows failed to save" });
    loadTracked();
  }

  // "Create PO / Assign Schedule" — every selected line must be Accepted
  // with no PoNumber already; lines with a schedule agreement on file are
  // assigned to it directly, everything else needs a real new PO (one PO
  // per vendor, so that subset must span at most one vendor).
  function createPoOrAssignScheduleSelectionValid() {
    if (!selectedTrackedIds.size) return false;
    const rows = trackedRows.filter((t) => selectedTrackedIds.has(Number(t.suggestionId)));
    if (rows.some((t) => t.status !== "Accepted" || t.poNumber)) return false;
    const poVendorIds = new Set(rows.filter((t) => !t.scheduleAgreement).map((t) => t.vendorId));
    return poVendorIds.size <= 1;
  }

  async function assignScheduleAgreementForRows(rows) {
    const lines = rows.map((t) => `${t.material} — ${t.scheduleAgreement}${t.scheduleAgreementItem ? "/" + t.scheduleAgreementItem : ""}`).join("\n");
    const ok = await NexusModal.confirm(
      `${rows.length} order line${rows.length === 1 ? "" : "s"} already have a schedule agreement on file and will be assigned to it — no PO is created in SAP.\n\n${lines}`,
      { confirmLabel: "Assign" });
    if (!ok) return { cancelled: true };
    try {
      await api("/order-suggestions/assign-schedule-agreement", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionIds: rows.map((t) => t.suggestionId) }),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function handleCreatePoOrAssignSchedule() {
    if (!createPoOrAssignScheduleSelectionValid()) return;
    const ids = [...selectedTrackedIds];
    const rows = trackedRows.filter((t) => ids.includes(Number(t.suggestionId)));
    const scheduleRows = rows.filter((t) => t.scheduleAgreement);
    const poRows = rows.filter((t) => !t.scheduleAgreement);

    if (scheduleRows.length) {
      const result = await assignScheduleAgreementForRows(scheduleRows);
      if (result.cancelled) return;
      if (!result.success) { await NexusModal.alert(result.error); return; }
      scheduleRows.forEach((t) => selectedTrackedIds.delete(Number(t.suggestionId)));
    }

    if (poRows.length) {
      openCreatePoModal(poRows);
    } else {
      selectedTrackedIds = new Set();
      loadTracked();
    }
  }

  function openCreatePoModal(rows) {
    if (!rows.length) return;
    const vendorName = rows[0].vendorName;
    const vendorCurrency = rows[0].currency || "";

    const linesHtml = rows.map((t) => `
      <tr>
        <td>${esc(t.material)}</td>
        <td>${esc(t.materialText || "—")}</td>
        <td>${esc(String(t.orderQty))} ${esc(t.uom || "")}</td>
        <td>${fmtDate(t.deliveryDate) || "—"}</td>
        <td><input class="tf-input cpo-price-input" type="number" step="0.01" min="0" placeholder="Auto (SAP)" data-id="${t.suggestionId}" style="width:100px"></td>
      </tr>`).join("");

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Create PO in SAP</div><div class="ps-modal-sub">${esc(vendorName)} · ${rows.length} line${rows.length === 1 ? "" : "s"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <p style="font-size:12px;color:var(--text-muted)">This creates a real purchase order in SAP under your own SAP login (My Account → SAP Credentials). Leave Price blank to let SAP price each line itself.</p>
        <div class="tf-row">
          <div class="tf-field" style="max-width:100px">
            <label class="tf-label">Currency</label>
            <input class="tf-input" type="text" id="cpo-currency" maxlength="3" value="${esc(vendorCurrency)}">
          </div>
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Material</th><th>Description</th><th>Qty</th><th>Delivery Date</th><th>Price (optional)</th></tr></thead>
            <tbody>${linesHtml}</tbody>
          </table>
        </div>
        <div id="cpo-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cpo-cancel">Cancel</button>
        <button type="button" class="btn" id="cpo-confirm-btn">Create PO</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cpo-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cpo-confirm-btn").addEventListener("click", () => submitCreatePo(rows, card));
  }

  async function submitCreatePo(rows, card) {
    const btn = card.querySelector("#cpo-confirm-btn");
    const resultEl = card.querySelector("#cpo-result");
    const currency = card.querySelector("#cpo-currency").value.trim().toUpperCase();
    if (!currency) {
      resultEl.innerHTML = '<div class="tf-inline-error">Currency is required.</div>';
      return;
    }
    const ok = await NexusModal.confirm(
      `Post a real purchase order to SAP for ${rows.length} line(s) from ${rows[0].vendorName}? This cannot be undone from here.`,
      { confirmLabel: "Create PO" });
    if (!ok) return;

    const priceOverrides = rows.map((t) => {
      const input = card.querySelector(`.cpo-price-input[data-id="${t.suggestionId}"]`);
      const val = input && input.value.trim();
      return val ? { suggestionId: t.suggestionId, netPrice: Number(val) } : null;
    }).filter(Boolean);

    btn.disabled = true; btn.textContent = "Creating…";
    resultEl.innerHTML = '<div class="nx-toolbar-hint">Creating PO in SAP…</div>';

    try {
      const { data } = await api("/order-suggestions/create-po", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionIds: rows.map((t) => t.suggestionId), currency, priceOverrides }),
      });
      selectedTrackedIds = new Set();
      resultEl.innerHTML = `<p style="color:var(--success);font-weight:600">Purchase Order <strong>${esc(data.purchaseOrder)}</strong> created and saved against ${data.suggestionIds.length} line(s).</p>`;
      btn.textContent = "Done";
      setTimeout(() => { NexusModal.close(); loadTracked(); }, 1500);
    } catch (err) {
      resultEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Create PO";
    }
  }

  // ── Manual order entry (single + bulk CSV) — records an order that already
  // exists outside the suggestion engine (e.g. placed by phone, or a legacy
  // order being brought into tracking). Backend: POST order-suggestions/manual
  // and .../manual/bulk (PurchaseOrderSuggestionHelper.ManualAsync/ManualBulkAsync).

  const MANUAL_STATUS_OPTIONS = ["Accepted", "Ordered", "Booked", "Received"];

  function openManualOrderModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Add Manual Order</div><div class="ps-modal-sub">Record an order placed outside the suggestion engine</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Vendor</label>
            <select class="tf-input" id="mo-vendor"><option value="">Loading vendors…</option></select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Material</label>
            <select class="tf-input" id="mo-material" disabled><option value="">Select a vendor first</option></select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Order Qty</label>
            <input class="tf-input" type="number" step="0.001" min="0" id="mo-qty">
          </div>
          <div class="tf-field">
            <label class="tf-label">Order Date</label>
            <input class="tf-input" type="date" id="mo-order-date" value="${todayIso()}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Delivery Date</label>
            <input class="tf-input" type="date" id="mo-delivery-date">
          </div>
          <div class="tf-field">
            <label class="tf-label">Status</label>
            <select class="tf-input" id="mo-status">${MANUAL_STATUS_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">PO Number</label>
            <input class="tf-input" type="text" id="mo-po">
          </div>
          <div class="tf-field">
            <label class="tf-label">Supplier Reference</label>
            <input class="tf-input" type="text" id="mo-supplier-ref">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes</label>
            <input class="tf-input" type="text" id="mo-notes">
          </div>
        </div>
        <div id="mo-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="mo-cancel">Cancel</button>
        <button type="button" class="btn" id="mo-save-btn">Add Order</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#mo-cancel").addEventListener("click", () => NexusModal.close());

    const vendorSelect = card.querySelector("#mo-vendor");
    const materialSelect = card.querySelector("#mo-material");

    api("/vendors").then(({ data }) => {
      const vendors = (data || []).filter((v) => Number(v.materialCount) > 0);
      vendorSelect.innerHTML = '<option value="">Select a vendor…</option>' + vendors.map((v) => `<option value="${v.vendorId}">${esc(v.vendorName)}</option>`).join("");
    }).catch(() => { vendorSelect.innerHTML = '<option value="">Failed to load vendors</option>'; });

    vendorSelect.addEventListener("change", async () => {
      const vendorId = vendorSelect.value;
      if (!vendorId) {
        materialSelect.disabled = true;
        materialSelect.innerHTML = '<option value="">Select a vendor first</option>';
        return;
      }
      materialSelect.disabled = true;
      materialSelect.innerHTML = '<option value="">Loading materials…</option>';
      try {
        const { data } = await api(`/vendors/${vendorId}/materials`);
        const materials = data || [];
        materialSelect.innerHTML = materials.length
          ? '<option value="">Select a material…</option>' + materials.map((m) => `<option value="${m.vendorMaterialId}">${esc(m.material)}${m.materialText ? " — " + esc(m.materialText) : ""}</option>`).join("")
          : '<option value="">No materials assigned to this vendor</option>';
        materialSelect.disabled = materials.length === 0;
      } catch {
        materialSelect.innerHTML = '<option value="">Failed to load materials</option>';
      }
    });

    card.querySelector("#mo-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#mo-save-btn");
      const result = card.querySelector("#mo-result");
      result.innerHTML = "";

      const vendorMaterialId = materialSelect.value ? Number(materialSelect.value) : null;
      const orderQty = card.querySelector("#mo-qty").value;
      if (!vendorMaterialId) { result.innerHTML = '<div class="tf-inline-error">Select a vendor and material.</div>'; return; }
      if (!orderQty || Number(orderQty) <= 0) { result.innerHTML = '<div class="tf-inline-error">Enter an order quantity greater than 0.</div>'; return; }

      const body = {
        vendorMaterialId,
        orderQty: Number(orderQty),
        orderDate: card.querySelector("#mo-order-date").value || null,
        deliveryDate: card.querySelector("#mo-delivery-date").value || null,
        poNumber: card.querySelector("#mo-po").value.trim() || null,
        supplierReference: card.querySelector("#mo-supplier-ref").value.trim() || null,
        status: card.querySelector("#mo-status").value,
        notes: card.querySelector("#mo-notes").value.trim() || null,
      };

      btn.disabled = true; btn.textContent = "Adding…";
      try {
        await api("/order-suggestions/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await loadTracked();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Add Order";
      }
    });
  }

  const BULK_IMPORT_HEADERS = ["Vendor", "Material", "OrderQty", "OrderDate", "DeliveryDate", "PoNumber", "SupplierReference", "Notes", "Status"];

  function parseBulkImportCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      const raw = {};
      headers.forEach((h, i) => { raw[h] = cols[i] ?? ""; });
      return {
        vendor: raw.Vendor || null,
        material: raw.Material || null,
        orderQty: raw.OrderQty ? Number(raw.OrderQty) : null,
        orderDate: raw.OrderDate || null,
        deliveryDate: raw.DeliveryDate || null,
        poNumber: raw.PoNumber || null,
        supplierReference: raw.SupplierReference || null,
        notes: raw.Notes || null,
        status: raw.Status || null,
      };
    });
  }

  function openBulkImportModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Bulk Import Orders (CSV)</div><div class="ps-modal-sub">Paste rows with a header line — a mismatched Vendor/Material must already be assigned in Vendor Master Data</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <p style="font-size:12px;color:var(--text-muted)">Header row: <code>${BULK_IMPORT_HEADERS.join(",")}</code>. OrderDate/DeliveryDate as yyyy-mm-dd; Status one of ${MANUAL_STATUS_OPTIONS.join("/")} (defaults to Accepted).</p>
        <textarea class="tf-input" id="bi-order-csv" rows="8" style="width:100%;font-family:monospace;font-size:12px" placeholder="${BULK_IMPORT_HEADERS.join(",")}
Acme Ltd,30007R,500,2026-09-10,2026-09-24,,,,Ordered"></textarea>
        <div id="bi-order-body" style="margin-top:10px"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="bi-order-cancel">Close</button>
        <button type="button" class="secondary" id="bi-order-preview">Preview</button>
        <button type="button" class="btn" id="bi-order-submit" style="display:none">Import</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#bi-order-cancel").addEventListener("click", () => NexusModal.close());

    const bodyEl = card.querySelector("#bi-order-body");
    const submitBtn = card.querySelector("#bi-order-submit");
    let rows = [];

    card.querySelector("#bi-order-preview").addEventListener("click", () => {
      rows = parseBulkImportCsv(card.querySelector("#bi-order-csv").value);
      if (rows.length === 0) {
        bodyEl.innerHTML = '<div class="tf-inline-error">No valid rows found.</div>';
        submitBtn.style.display = "none";
        return;
      }
      bodyEl.innerHTML = `
        <p>${rows.length} row(s) parsed</p>
        <div style="overflow-x:auto"><table><thead><tr><th>Vendor</th><th>Material</th><th>Qty</th><th>Order Date</th><th>Delivery Date</th><th>PO</th><th>Status</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.vendor)}</td><td>${esc(r.material)}</td><td>${esc(r.orderQty)}</td><td>${esc(r.orderDate)}</td><td>${esc(r.deliveryDate)}</td><td>${esc(r.poNumber)}</td><td>${esc(r.status || "Accepted")}</td></tr>`).join("")}</tbody>
        </table></div>`;
      submitBtn.style.display = "";
    });

    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true; submitBtn.textContent = "Importing…";
      try {
        const { data } = await api("/order-suggestions/manual/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
        const failLines = (data.results || []).filter((r) => !r.success).map((r) => `Row ${r.row}: ${esc(r.error)}`).join("<br>");
        bodyEl.innerHTML = `<p>Imported ${data.succeeded} of ${data.total} row(s)${data.failed ? `, ${data.failed} failed` : ""}.</p>${failLines ? `<div class="tf-inline-error">${failLines}</div>` : ""}`;
        submitBtn.style.display = "none";
        if (data.succeeded > 0) await loadTracked();
      } catch (err) {
        bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = "Import";
      }
    });
  }

  function openCreateShipmentModal() {
    const ids = [...selectedTrackedIds];
    if (!ids.length) return;

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Create Shipment</div><div class="ps-modal-sub">${ids.length} order line${ids.length === 1 ? "" : "s"} selected</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Dispatch Date</label>
            <input class="tf-input" type="date" id="cs-dispatch">
          </div>
          <div class="tf-field">
            <label class="tf-label">Expected ETA</label>
            <input class="tf-input" type="date" id="cs-eta">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Haulier</label>
            <select class="tf-input" id="cs-haulier"><option value="">Loading…</option></select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Mode of Transport</label>
            <select class="tf-input" id="cs-mode">
              <option value="">—</option>
              ${["Road", "Groupage", "Sea", "Air", "Rail", "Courier", "Other"].map((m) => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Tracking Number</label>
            <input class="tf-input" type="text" id="cs-tracking">
          </div>
          <div class="tf-field">
            <label class="tf-label">Container Number</label>
            <input class="tf-input" type="text" id="cs-container">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">B/L Number</label>
            <input class="tf-input" type="text" id="cs-bl">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes</label>
            <input class="tf-input" type="text" id="cs-notes">
          </div>
        </div>
        <div id="cs-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cs-cancel">Cancel</button>
        <button type="button" class="btn" id="cs-save-btn">Create Shipment</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cs-cancel").addEventListener("click", () => NexusModal.close());

    loadForwarderOptionsInto(card.querySelector("#cs-haulier"));

    card.querySelector("#cs-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#cs-save-btn");
      const result = card.querySelector("#cs-result");
      result.innerHTML = "";
      btn.disabled = true; btn.textContent = "Creating…";

      const haulierSelect = card.querySelector("#cs-haulier");
      const body = {
        dispatchDate: card.querySelector("#cs-dispatch").value || null,
        expectedEta: card.querySelector("#cs-eta").value || null,
        haulier: haulierSelect.selectedOptions[0]?.textContent || null,
        forwarderId: haulierSelect.value ? Number(haulierSelect.value) : null,
        modeOfTransport: card.querySelector("#cs-mode").value || null,
        trackingNumber: card.querySelector("#cs-tracking").value.trim() || null,
        containerNumber: card.querySelector("#cs-container").value.trim() || null,
        billOfLading: card.querySelector("#cs-bl").value.trim() || null,
        notes: card.querySelector("#cs-notes").value.trim() || null,
        suggestionIds: ids,
      };

      try {
        const { data } = await api("/order-suggestions/shipments", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        selectedTrackedIds = new Set();
        NexusModal.close();
        await NexusModal.alert(`${esc(data.shipmentReference)} created — ${data.orderCount} order${data.orderCount === 1 ? "" : "s"} linked. Manage dispatch/ETA and mark it received once it arrives from the Inbound Log tile.`, { title: "Shipment created" });
        loadTracked();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Create Shipment";
      }
    });
  }

  async function loadForwarderOptionsInto(selectEl) {
    try {
      const r = await fetch("/api/forwarders/approved");
      const json = await r.json();
      const forwarders = (json.success ? json.data : []) || [];
      selectEl.innerHTML = `<option value="">—</option>${forwarders
        .map((f) => `<option value="${f.forwarderId}">${esc(f.forwarderName)}${f.forwarderMode ? " (" + esc(f.forwarderMode) + ")" : ""}</option>`)
        .join("")}`;
    } catch {
      selectEl.innerHTML = '<option value="">—</option>';
    }
  }

  async function openAssignShipmentModal(t) {
    const hasShipment = Boolean(t.shipmentId);
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Assign Shipment</div><div class="ps-modal-sub">${esc(t.material)} — ${esc(t.vendorName)}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-field">
          <label class="tf-label">Shipment</label>
          <select class="tf-input" id="as-existing"><option value="">Loading…</option></select>
        </div>
        <p style="font-size:12px;color:var(--text-muted)">Only existing shipments are listed here — create a new one from the Tracked Orders selection instead.</p>
        <div id="as-result"></div>
      </div>
      <div class="ps-modal-actions">
        ${hasShipment ? '<button type="button" class="secondary" id="as-unassign-btn">Unassign</button>' : ""}
        <button type="button" class="secondary" id="as-cancel">Cancel</button>
        <button type="button" class="btn" id="as-save-btn">Save</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#as-cancel").addEventListener("click", () => NexusModal.close());

    const existingSelect = card.querySelector("#as-existing");
    try {
      const { data } = await api("/order-suggestions/shipments");
      // Only shipments for the same vendor — either already carrying an
      // order from this vendor, or not yet carrying any order at all (not
      // vendor-locked yet, so still a valid target for the first one) —
      // and not cancelled or already marked Received (you can't add a line
      // to a shipment that's already been delivered).
      const candidates = (data || []).filter((s) => {
        if (s.cancelledAtUtc || s.receivedAtUtc) return false;
        if (hasShipment && Number(t.shipmentId) === s.shipmentId) return true;
        const suppliers = (s.suppliers || "").split(",").map((v) => v.trim()).filter(Boolean);
        return suppliers.length === 0 || suppliers.includes(t.vendorName);
      });
      const optionsHtml = candidates.map((s) =>
        `<option value="${s.shipmentId}" ${hasShipment && Number(t.shipmentId) === s.shipmentId ? "selected" : ""}>${esc(s.shipmentReference || `Shipment #${s.shipmentId}`)} — ${esc(s.haulier || "no haulier set")} (${s.orderCount} order${s.orderCount === 1 ? "" : "s"})</option>`
      ).join("");
      existingSelect.innerHTML = `<option value="">— None —</option>${optionsHtml}`;
    } catch {
      existingSelect.innerHTML = '<option value="">Failed to load shipments</option>';
    }

    const unassignBtn = card.querySelector("#as-unassign-btn");
    if (unassignBtn) {
      unassignBtn.addEventListener("click", async () => {
        unassignBtn.disabled = true; unassignBtn.textContent = "Removing…";
        try {
          await api(`/order-suggestions/${t.suggestionId}/shipment`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentId: null }),
          });
          NexusModal.close();
          loadTracked();
        } catch (err) {
          card.querySelector("#as-result").innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
          unassignBtn.disabled = false; unassignBtn.textContent = "Unassign";
        }
      });
    }

    card.querySelector("#as-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#as-save-btn");
      const result = card.querySelector("#as-result");
      result.innerHTML = "";
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const shipmentId = existingSelect.value ? Number(existingSelect.value) : null;
        await api(`/order-suggestions/${t.suggestionId}/shipment`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentId }),
        });
        NexusModal.close();
        loadTracked();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Save";
      }
    });
  }

  async function loadTracked() {
    const el = document.getElementById("os-tracked");
    try {
      const { data } = await api("/order-suggestions/tracked");
      renderTrackedList(data || [], trackedSearchQuery);
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  loadSuggestions();
  loadTracked();
})();
