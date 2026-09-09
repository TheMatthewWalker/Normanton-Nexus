// Add Picksheet tile — manual single-delivery entry (POST /api/deliverymain).
(function () {
  const api = NexusApi.make("/api/deliverymain");
  const statusEl = document.getElementById("ap-status");

  document.getElementById("ap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "Adding…";
    try {
      const body = {
        deliveryId: Number(document.getElementById("ap-delivery-id").value),
        customerId: document.getElementById("ap-customer-id").value ? Number(document.getElementById("ap-customer-id").value) : null,
        dispatchDate: document.getElementById("ap-dispatch-date").value || null,
        deliveryDate: null,
        completionDate: null,
        completionStatus: false,
        operatorName: null,
        supervisorName: null,
        netWeight: null,
        grossWeight: null,
        palletCount: null,
        deliveryVolume: null,
        picksheetComment: document.getElementById("ap-comment").value || null,
        deliveryCancelled: false,
        deliveryPriority: Number(document.getElementById("ap-delivery-priority").value) || 0,
        deliveryService: document.getElementById("ap-delivery-service").value || null,
        incoterms: document.getElementById("ap-incoterms").value || null,
      };
      await api("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = `Delivery ${body.deliveryId} added.`;
      e.target.reset();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });
})();
