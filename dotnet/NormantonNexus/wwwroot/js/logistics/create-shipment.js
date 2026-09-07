// Create Outbound Shipment tile — port of the create-from-deliveries half
// of private/js/logistics.js's shipment creation flow.
(function () {
  const api = NexusApi.make("/api/shipmentmain");
  const statusEl = document.getElementById("cs-status");

  document.getElementById("cs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "Creating…";
    try {
      const deliveryIds = document.getElementById("cs-deliveries").value
        .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
      const body = {
        deliveryIds,
        destinationName: document.getElementById("cs-dest-name").value || null,
        destinationCountry: document.getElementById("cs-dest-country").value || null,
        forwarderId: document.getElementById("cs-forwarder-id").value ? Number(document.getElementById("cs-forwarder-id").value) : null,
        plannedCollection: document.getElementById("cs-planned-collection").value || null,
        incoTerms: document.getElementById("cs-incoterms").value || null,
        customsRequired: document.getElementById("cs-customs-required").checked,
      };
      const { data } = await api("/create-from-deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = `Shipment ${data.shipmentId} created.`;
      e.target.reset();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });
})();
