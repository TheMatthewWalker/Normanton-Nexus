// Shipment Search tile — port of the Search half of private/js/logistics.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("ss-body");

  document.getElementById("ss-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    const ref_ = document.getElementById("ss-ref").value.trim();
    const forwarder = document.getElementById("ss-forwarder").value.trim();
    const customer = document.getElementById("ss-customer").value.trim();
    const tracking = document.getElementById("ss-tracking").value.trim();
    if (ref_) params.set("shipmentRef", ref_);
    if (forwarder) params.set("forwarder", forwarder);
    if (customer) params.set("customer", customer);
    if (tracking) params.set("tracking", tracking);

    bodyEl.textContent = "Searching…";
    try {
      const { data } = await api(`/search?${params.toString()}`);
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  });

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No matching shipments.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} result(s)</p>
      <table>
        <thead><tr><th>Ref</th><th>Direction</th><th>Customer</th><th>Forwarder</th><th>Tracking</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.refDisplay)}</td>
              <td>${esc(r.direction)}</td>
              <td>${esc(r.customer)}</td>
              <td>${esc(r.forwarderName)}</td>
              <td>${esc(r.trackingNumber)}</td>
              <td>${r.shipmentCancelled ? "Cancelled" : r.deliveryStatus ? "Delivered" : r.collectionStatus ? "Collected" : r.bookingStatus ? "Booked" : "Open"}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }
})();
