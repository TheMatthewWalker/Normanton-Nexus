// Stock Management tile — port of private/js/warehouse.js's runStockManagement().
// Search LQUA stock, pick a row, create a Transfer Order (L_TO_CREATE_SINGLE).
//
// Velocity note: unlike Finance/Quality's earlier pages (pure createElement,
// no innerHTML), this file and the rest of Phase 10's frontend catch-up use
// template-literal innerHTML with the shared window.NexusApi.esc() escape
// helper instead — still XSS-safe (every interpolated value goes through
// esc()), just faster to author at the volume this catch-up needed
// (Warehouse/Logistics/Admin/Management, ~50+ pages). A deliberate,
// documented tradeoff, not an oversight — see dotnet/CLAUDE.md's Phase 10 notes.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/warehouse");

  const resultsEl = document.getElementById("sm-results");

  document.getElementById("sm-search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const params = new URLSearchParams();
    const material = document.getElementById("sm-material").value.trim();
    const storageType = document.getElementById("sm-storage-type").value.trim();
    const bin = document.getElementById("sm-bin").value.trim();
    const batch = document.getElementById("sm-batch").value.trim();
    const storageLocation = document.getElementById("sm-storage-location").value.trim();
    if (material) params.set("material", material);
    if (storageType) params.set("storageType", storageType);
    if (bin) params.set("bin", bin);
    if (batch) params.set("batch", batch);
    if (storageLocation) params.set("storageLocation", storageLocation);

    resultsEl.textContent = "Searching…";
    try {
      const { data } = await api(`/stock?${params.toString()}`);
      renderResults(data || []);
    } catch (err) {
      resultsEl.textContent = "Error: " + err.message;
    }
  });

  function renderResults(rows) {
    if (rows.length === 0) {
      resultsEl.textContent = "No stock found.";
      return;
    }
    resultsEl.innerHTML = `
      <p>${rows.length} row(s)</p>
      <table>
        <thead><tr><th>Material</th><th>Batch</th><th>Storage Type</th><th>Bin</th><th>Available Qty</th><th>Storage Location</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${esc(r.material)}</td>
              <td>${esc(r.batch)}</td>
              <td>${esc(r.storageType)}</td>
              <td>${esc(r.bin)}</td>
              <td>${esc(r.availableQty)}</td>
              <td>${esc(r.storageLocation)}</td>
              <td><button type="button" class="btn secondary" data-idx="${i}">Transfer</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    resultsEl.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => openTransferPanel(rows[Number(btn.dataset.idx)]));
    });
  }

  const TRANSFER_FIELDS = [
    { key: "material", label: "Material", readonly: true },
    { key: "batch", label: "Batch", readonly: true },
    { key: "quantity", label: "Quantity" },
    { key: "sourceType", label: "Source Type", readonly: true },
    { key: "sourceBin", label: "Source Bin", readonly: true },
    { key: "storageLocation", label: "Storage Location", readonly: true },
    { key: "destType", label: "Destination Type" },
    { key: "destBin", label: "Destination Bin" },
  ];

  function openTransferPanel(row) {
    const record = {
      material: row.material,
      batch: row.batch || "",
      quantity: String(row.availableQty),
      sourceType: row.storageType,
      sourceBin: row.bin,
      storageLocation: row.storageLocation,
      destType: "",
      destBin: "",
    };

    AdminEditModal.open("Create Transfer Order", `${row.material} — Batch ${row.batch || "N/A"}`, TRANSFER_FIELDS, record, async (values) => {
      const body = {
        storageLocation: row.storageLocation,
        material: row.material,
        quantity: Number(values.quantity),
        sourceType: row.storageType,
        sourceBin: row.bin,
        destinationType: values.destType.trim(),
        destinationBin: values.destBin.trim(),
        batch: row.batch || null,
      };
      const { data } = await api("/transfer-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!data?.success) throw new Error("Transfer order did not succeed — check messages.");
    });
  }
})();
