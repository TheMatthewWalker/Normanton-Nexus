// Inbound Log tile — port of private/js/logistics.js's renderInboundLog/
// openManualInboundShipmentModal family: bucket grouping (Late/Today/
// Upcoming/Completed/Cancelled) and a modal-based Manual Shipment creation
// form (searchable Origin against Destinations, Haulier filtered by Mode of
// Transport). The shipment DETAIL modal itself (header edit, order lines,
// Mark/Undo Received, Manual Items/Documents/Costs) lives in the shared
// wwwroot/js/logistics/shipment-detail.js module, since Order Suggestions'
// Tracked Orders also opens it (from a shipment reference link) — see that
// file for the full behavior, including its read-only-plus-Undo-Received-
// only treatment of an already-Received shipment.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance/order-suggestions/shipments");
  const refApi = NexusApi.make("/api");

  const TRANSPORT_MODES = ["Road", "Groupage", "Sea", "Air", "Rail", "Courier", "Other"];

  let rows = [];
  let searchQuery = "";
  let forwarders = [];

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }
  function fmtDateTime(d) {
    return d ? new Date(d).toLocaleString("en-GB") : "";
  }

  function bucketFor(s) {
    if (s.cancelledAtUtc) return "cancelled";
    if (s.receivedAtUtc) return "completed";
    if (!s.expectedEta) return "upcoming";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const eta = new Date(s.expectedEta); eta.setHours(0, 0, 0, 0);
    if (eta.getTime() < today.getTime()) return "late";
    if (eta.getTime() === today.getTime()) return "today";
    return "upcoming";
  }

  const BUCKET_DEFS = [
    { key: "late", label: "Late", dot: "backlog", defaultOpen: true },
    { key: "today", label: "Today", dot: "today", defaultOpen: true },
    { key: "upcoming", label: "Upcoming", dot: "week", defaultOpen: true },
    { key: "completed", label: "Completed", dot: "month", defaultOpen: false },
    { key: "cancelled", label: "Cancelled", dot: "other", defaultOpen: false },
  ];

  function matchesSearch(s, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return [s.shipmentReference, s.haulier, s.trackingNumber, s.containerNumber, s.billOfLading,
      s.orderMaterials, s.manualMaterials, s.poNumbers, s.supplierReferences, s.suppliers]
      .some((f) => String(f || "").toLowerCase().includes(needle));
  }

  async function loadList() {
    const el = document.getElementById("il-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("");
      rows = data || [];
      renderList();
    } catch (err) {
      el.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function renderList() {
    const el = document.getElementById("il-list");
    const q = searchQuery.trim();
    const filtered = q ? rows.filter((r) => matchesSearch(r, q)) : rows;
    document.getElementById("il-count").textContent = q ? `${filtered.length} of ${rows.length} matching` : `${rows.length} shipment${rows.length === 1 ? "" : "s"}`;

    if (!rows.length) {
      el.innerHTML = '<div class="nx-empty">No inbound shipments yet — create one from Tracked Orders by selecting order lines, or add a Manual Shipment above.</div>';
      return;
    }
    if (!filtered.length) {
      el.innerHTML = `<div class="nx-empty">No shipments match "${esc(q)}".</div>`;
      return;
    }

    const tableHead = "<thead><tr><th>Reference</th><th>Supplier</th><th>Haulier</th><th>Mode</th><th>Dispatch</th><th>ETA</th><th>Tracking</th><th>Orders</th><th>Status</th></tr></thead>";
    const renderRow = (s) => `
      <tr class="il-row" data-id="${s.shipmentId}" style="cursor:pointer">
        <td><strong>${esc(s.shipmentReference || `#${s.shipmentId}`)}</strong></td>
        <td>${s.isManual ? `<span style="color:var(--text-muted)">Manual — ${esc(s.originName || "no origin")}</span>` : esc(s.suppliers || "—")}</td>
        <td>${esc(s.haulier || "—")}</td>
        <td>${esc(s.modeOfTransport || "—")}</td>
        <td>${fmtDate(s.dispatchDate)}</td>
        <td>${fmtDate(s.expectedEta)}</td>
        <td>${esc(s.trackingNumber || "—")}</td>
        <td>${s.orderCount}</td>
        <td>${s.cancelledAtUtc
          ? `<span style="color:var(--text-muted)">Cancelled ${fmtDate(s.cancelledAtUtc)}</span>`
          : (s.receivedAtUtc ? `<span class="badge badge--success">Received ${fmtDate(s.receivedAtUtc)}</span>` : '<span class="badge">Pending</span>')}</td>
      </tr>`;

    const sections = BUCKET_DEFS.map((bd) => {
      const bucketRows = filtered.filter((s) => bucketFor(s) === bd.key);
      if (!bucketRows.length) return "";
      const collapsed = (bd.defaultOpen || q) ? "" : " ps-section--collapsed";
      return `<div class="ps-section${collapsed}">
        <div class="ps-section-header">
          <span class="ps-section-dot ps-section-dot--${bd.dot}"></span>
          <span class="ps-section-title">${bd.label}</span>
          <span class="ps-section-count">${bucketRows.length}</span>
          <span class="ps-chevron">&#9660;</span>
        </div>
        <div class="ps-section-body"><div style="overflow-x:auto">
          <table>${tableHead}<tbody>${bucketRows.map(renderRow).join("")}</tbody></table>
        </div></div>
      </div>`;
    }).join("");

    el.innerHTML = `<div class="ps-sections">${sections}</div>`;
    wireCollapseToggles(el);
    el.querySelectorAll(".il-row").forEach((row) => {
      row.addEventListener("click", () => window.ShipmentDetailModal.open(Number(row.dataset.id), { onChange: loadList }));
    });
  }

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", () => h.closest(".ps-section").classList.toggle("ps-section--collapsed"));
    });
  }

  document.getElementById("il-search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderList();
  });

  async function loadForwarders() {
    try {
      const { data } = await refApi("/forwarders/approved");
      forwarders = data || [];
    } catch { /* reference data best-effort */ }
  }

  function populateHaulierSelect(selectEl, mode, preselectId) {
    const matching = mode ? forwarders.filter((f) => (f.forwarderMode || "").toLowerCase() === mode.toLowerCase()) : forwarders;
    selectEl.disabled = false;
    selectEl.innerHTML = '<option value="">—</option>' + matching.map((f) =>
      `<option value="${f.forwarderId}" ${preselectId && Number(preselectId) === f.forwarderId ? "selected" : ""}>${esc(f.forwarderName)}</option>`).join("");
  }

  // ── Manual Shipment creation modal ──────────────────────────────────

  document.getElementById("il-manual-btn").addEventListener("click", openManualShipmentModal);

  function openManualShipmentModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Manual Inbound Shipment</div><div class="ps-modal-sub">Not linked to a tracked order — e.g. a customer return</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field tf-field--wide" style="position:relative">
            <label class="tf-label">Origin</label>
            <input class="tf-input" type="text" id="mi-origin-search" placeholder="Start typing a destination name…" autocomplete="off">
            <input type="hidden" id="mi-origin-id">
            <div id="mi-origin-results" class="hidden" style="position:absolute;top:100%;left:0;right:0;z-index:20;background:var(--surface);border:1px solid var(--border);border-radius:0 0 8px 8px;max-height:200px;overflow-y:auto;box-shadow:var(--shadow-lg)"></div>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Mode of Transport</label>
            <select class="tf-input" id="mi-mode"><option value="">— Select mode —</option>${TRANSPORT_MODES.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Haulier</label>
            <select class="tf-input" id="mi-haulier" disabled><option value="">Select mode of transport first</option></select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Dispatch Date</label>
            <input class="tf-input" type="date" id="mi-dispatch">
          </div>
          <div class="tf-field">
            <label class="tf-label">Expected ETA</label>
            <input class="tf-input" type="date" id="mi-eta">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Tracking Number</label>
            <input class="tf-input" type="text" id="mi-tracking">
          </div>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin:14px 0 8px">Cost (optional)</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Price (£)</label>
            <input class="tf-input" type="number" step="0.01" id="mi-price">
          </div>
          <div class="tf-field">
            <label class="tf-label">Cost Centre</label>
            <select class="tf-input" id="mi-costcentre"><option value="">Loading…</option></select>
          </div>
          <div class="tf-field">
            <label class="tf-label">GL Tier</label>
            <select class="tf-input" id="mi-tier">
              <option value="standard">Standard (602200)</option>
              <option value="premium">Premium (602100)</option>
            </select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes</label>
            <input class="tf-input" type="text" id="mi-notes">
          </div>
        </div>
        <div id="mi-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="mi-cancel">Cancel</button>
        <button type="button" class="btn" id="mi-save-btn">Create Shipment</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#mi-cancel").addEventListener("click", () => NexusModal.close());

    const originInput = card.querySelector("#mi-origin-search");
    const originIdInput = card.querySelector("#mi-origin-id");
    const originResults = card.querySelector("#mi-origin-results");
    let originDebounce = null;

    function renderOriginResults(destinations) {
      if (!destinations.length) {
        originResults.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">No matches</div>';
      } else {
        originResults.innerHTML = destinations.map((d) =>
          `<div class="mi-origin-row" data-id="${d.destinationId}" data-name="${esc(d.destinationName || "")}" style="padding:7px 10px;font-size:13px;cursor:pointer">${esc(d.destinationName || "")}${d.destinationCountry ? " — " + esc(d.destinationCountry) : ""}</div>`
        ).join("");
        originResults.querySelectorAll(".mi-origin-row").forEach((row) => {
          row.addEventListener("mouseenter", () => { row.style.background = "var(--surface2)"; });
          row.addEventListener("mouseleave", () => { row.style.background = ""; });
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            originIdInput.value = row.dataset.id;
            originInput.value = row.dataset.name;
            originResults.classList.add("hidden");
          });
        });
      }
      originResults.classList.remove("hidden");
    }

    originInput.addEventListener("input", () => {
      originIdInput.value = "";
      clearTimeout(originDebounce);
      const q = originInput.value.trim();
      if (!q) { originResults.classList.add("hidden"); return; }
      originDebounce = setTimeout(async () => {
        try {
          const { data } = await refApi(`/destinations?search=${encodeURIComponent(q)}`);
          renderOriginResults(data || []);
        } catch {
          originResults.innerHTML = '<div class="tf-inline-error" style="padding:8px 10px">Search failed</div>';
          originResults.classList.remove("hidden");
        }
      }, 250);
    });
    originInput.addEventListener("focus", () => {
      if (originInput.value.trim() && originResults.innerHTML) originResults.classList.remove("hidden");
    });
    originInput.addEventListener("blur", () => setTimeout(() => originResults.classList.add("hidden"), 150));

    card.querySelector("#mi-mode").addEventListener("change", (e) => populateHaulierSelect(card.querySelector("#mi-haulier"), e.target.value));

    const costCentreSelect = card.querySelector("#mi-costcentre");
    refApi("/costcenters").then(({ data }) => {
      costCentreSelect.innerHTML = '<option value="">— Select cost centre —</option>' + (data || []).map((c) =>
        `<option value="${esc(c.centerCode)}" ${c.centerCode === "0000002012" ? "selected" : ""}>${esc(c.centerDescription)} (${esc(c.centerCode)})</option>`).join("");
    }).catch(() => { costCentreSelect.innerHTML = '<option value="">Failed to load cost centres</option>'; });

    card.querySelector("#mi-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#mi-save-btn");
      const result = card.querySelector("#mi-result");
      result.innerHTML = "";

      if (originInput.value.trim() && !originIdInput.value) {
        result.innerHTML = '<div class="tf-inline-error">Select an origin from the dropdown list.</div>';
        return;
      }

      const price = card.querySelector("#mi-price").value;
      const body = {
        originDestinationId: originIdInput.value ? Number(originIdInput.value) : null,
        forwarderId: card.querySelector("#mi-haulier").value ? Number(card.querySelector("#mi-haulier").value) : null,
        modeOfTransport: card.querySelector("#mi-mode").value || null,
        dispatchDate: card.querySelector("#mi-dispatch").value || null,
        expectedEta: card.querySelector("#mi-eta").value || null,
        trackingNumber: card.querySelector("#mi-tracking").value.trim() || null,
        notes: card.querySelector("#mi-notes").value.trim() || null,
        price: price ? Number(price) : null,
        costCentre: costCentreSelect.value || null,
        tier: card.querySelector("#mi-tier").value,
      };

      btn.disabled = true; btn.textContent = "Creating…";
      try {
        await api("/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await loadList();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Create Shipment";
      }
    });
  }

  loadForwarders();
  loadList();
})();
