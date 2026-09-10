// Shipment Search tile — port of the Search half of private/js/logistics.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("ss-body");
  const toolbarEl = document.getElementById("ss-toolbar");
  const toolbarTitleEl = document.getElementById("ss-toolbar-title");
  const formEl = document.getElementById("ss-form");

  function statusBadge(r) {
    if (r.shipmentCancelled) return `<span class="badge badge--error">Cancelled</span>`;
    if (r.deliveryStatus) return `<span class="badge badge--success">Delivered</span>`;
    if (r.collectionStatus) return `<span class="badge badge--accent">Collected</span>`;
    if (r.bookingStatus) return `<span class="badge badge--warn">Booked</span>`;
    return `<span class="badge">Open</span>`;
  }

  function directionBadge(direction) {
    const cls = direction === "outbound" ? "badge--accent" : "badge";
    return `<span class="badge ${cls}">${esc(direction)}</span>`;
  }

  formEl.addEventListener("submit", async (e) => {
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

    renderLoading();
    try {
      const { data } = await api(`/search?${params.toString()}`);
      render(data || []);
    } catch (err) {
      toolbarEl.classList.add("hidden");
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  });

  document.getElementById("ss-clear").addEventListener("click", () => {
    formEl.reset();
    toolbarEl.classList.add("hidden");
    bodyEl.innerHTML = "";
  });

  function renderLoading() {
    toolbarEl.classList.add("hidden");
    bodyEl.innerHTML = `<div class="nx-empty">Searching…</div>`;
  }

  function render(rows) {
    if (rows.length === 0) {
      toolbarEl.classList.add("hidden");
      bodyEl.innerHTML = `<div class="nx-empty">No matching shipments.</div>`;
      return;
    }

    toolbarTitleEl.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
    toolbarEl.classList.remove("hidden");

    bodyEl.innerHTML = `
      <table>
        <thead><tr><th>Ref</th><th>Direction</th><th>Customer</th><th>Forwarder</th><th>Tracking</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.direction === "outbound" ? `<a href="#" class="ss-open" data-id="${r.shipmentId}">${esc(r.refDisplay)}</a>` : esc(r.refDisplay)}</td>
              <td>${directionBadge(r.direction)}</td>
              <td>${esc(r.customer)}</td>
              <td>${esc(r.forwarderName)}</td>
              <td>${esc(r.trackingNumber)}</td>
              <td>${statusBadge(r)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    bodyEl.querySelectorAll(".ss-open").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      OutboundShipmentDetail.open(Number(a.dataset.id), () => formEl.requestSubmit());
    }));
  }
})();
