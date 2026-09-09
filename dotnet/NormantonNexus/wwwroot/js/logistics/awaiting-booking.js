// Awaiting Booking tile — GET /api/shipmentmain/queue/awaiting-booking, split
// out of the old combined shipment-queue.js. Selection is locked to one
// haulier group at a time, matching Node's own getBookingSelectionKey rule
// ("only shipments for the same haulier can be booked together") — an
// unassigned-haulier row can be checked alongside another unassigned row,
// but not alongside an assigned one.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("ab-body");
  const bookBtn = document.getElementById("ab-book-btn");
  let rows = [];
  const selected = new Set();

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
    bodyEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Planned Movement</th><th>Incoterms</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><input type="checkbox" class="ab-check" data-id="${r.shipmentId}"></td>
            <td><a href="#" class="ab-open" data-id="${r.shipmentId}">${esc(String(r.shipmentId).padStart(8, "0"))}</a></td>
            <td>${esc(r.destinationName || "")}, ${esc(r.destinationCountry || "")}</td>
            <td>${esc(r.forwarderName || "Unassigned")}</td>
            <td>${r.plannedMovement ? new Date(r.plannedMovement).toLocaleDateString("en-GB") : "—"}</td>
            <td>${esc(r.incoTerms || "—")}</td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

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
