// Awaiting Booking tile — GET /api/shipmentmain/queue/awaiting-booking, split
// out of the old combined shipment-queue.js. Selection is locked to one
// haulier group at a time, matching Node's own getBookingSelectionKey rule
// ("only shipments for the same haulier can be booked together") — an
// unassigned-haulier row can be checked alongside another unassigned row,
// but not alongside an assigned one. Rows render grouped into the shared
// `.ps-section` collapsible-bucket pattern by haulier (with an "Unassigned"
// bucket) — a natural fit since booking is already haulier-locked; see
// order-suggestions.js's Tracked Orders for the original pattern.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("ab-body");
  const bookBtn = document.getElementById("ab-book-btn");
  let rows = [];
  const selected = new Set();

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

  function normalizeHaulierName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function hasAssignedHaulier(row) { return Boolean(String(row?.forwarderName || "").trim()); }
  function selectionKey(row) { return hasAssignedHaulier(row) ? normalizeHaulierName(row.forwarderName) : "__unassigned__"; }

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    updateHint();
    try {
      const { data } = await api("/queue/awaiting-booking");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function selectedRows() {
    return rows.filter((r) => selected.has(r.shipmentId));
  }

  function updateHint() {
    const sel = selectedRows();
    bookBtn.disabled = sel.length === 0;
    const lockedRow = sel[0];
    document.getElementById("ab-hint").textContent = sel.length
      ? `${sel.length} shipment(s) selected for ${hasAssignedHaulier(lockedRow) ? lockedRow.forwarderName : "an unassigned haulier"}.`
      : `${rows.length} shipment(s) awaiting booking — select one or more for the same haulier, then Book.`;
  }

  function render() {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No shipments are currently awaiting booking.</div>'; updateHint(); return; }

    const buckets = new Map();
    for (const r of rows) {
      const key = selectionKey(r);
      if (!buckets.has(key)) buckets.set(key, { label: hasAssignedHaulier(r) ? r.forwarderName : "Unassigned", rows: [] });
      buckets.get(key).rows.push(r);
    }

    const sectionsWrap = document.createElement("div");
    sectionsWrap.className = "ps-sections";
    let first = true;
    for (const { label, rows: bucketRows } of buckets.values()) {
      const section = document.createElement("div");
      section.className = "ps-section" + (first ? "" : " ps-section--collapsed");
      section.innerHTML = `
        <div class="ps-section-header">
          <span class="ps-section-dot ps-section-dot--${label === "Unassigned" ? "other" : "week"}"></span>
          <span class="ps-section-title">${esc(label)}</span>
          <span class="ps-section-count">${bucketRows.length}</span>
          <span class="ps-chevron">&#9660;</span>
        </div>
        <div class="ps-section-body"><div style="overflow-x:auto">
        <table>
          <thead><tr><th></th><th>Shipment</th><th>Destination</th><th>Planned Movement</th><th>Incoterms</th></tr></thead>
          <tbody>${bucketRows.map((r) => `
            <tr>
              <td><input type="checkbox" class="ab-check" data-id="${r.shipmentId}"></td>
              <td><a href="#" class="ab-open" data-id="${r.shipmentId}">${esc(String(r.shipmentId).padStart(8, "0"))}</a></td>
              <td>${esc(r.destinationName || "")}, ${esc(r.destinationCountry || "")}</td>
              <td>${r.plannedMovement ? new Date(r.plannedMovement).toLocaleDateString("en-GB") : "—"}</td>
              <td>${esc(r.incoTerms || "—")}</td>
            </tr>`).join("")}</tbody>
        </table>
        </div></div>`;
      sectionsWrap.appendChild(section);
      first = false;
    }

    bodyEl.innerHTML = "";
    bodyEl.appendChild(sectionsWrap);
    wireCollapseToggles(bodyEl);

    bodyEl.querySelectorAll(".ab-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      const row = rows.find((r) => r.shipmentId === id);
      const lockedRow = selectedRows()[0];
      if (e.target.checked && lockedRow && selectionKey(lockedRow) !== selectionKey(row)) {
        e.target.checked = false;
        document.getElementById("ab-hint").textContent = "Only shipments for the same haulier can be booked together.";
        return;
      }
      if (e.target.checked) selected.add(id); else selected.delete(id);
      updateHint();
    }));
    bodyEl.querySelectorAll(".ab-open").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      OutboundShipmentDetail.open(Number(a.dataset.id), load);
    }));
    updateHint();
  }

  bookBtn.addEventListener("click", () => {
    const sel = selectedRows();
    if (!sel.length) return;
    ShipmentBooking.open(sel, load);
  });

  load();
})();
