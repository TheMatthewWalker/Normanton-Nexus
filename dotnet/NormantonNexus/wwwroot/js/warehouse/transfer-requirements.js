// Transfer Requirements (LT04) tile — port of runTransferRequirements() in
// private/js/warehouse.js. Lists open TRs (LTBK/LTBP) and confirms one via
// LT04. TR Cleanup Assistant is a separate, more advanced supervisor tool
// (routes/sap.js's batch-cleanup-transfer, LOG_SUPER-only) — not built in
// this pass, flagged as a remaining gap.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/warehouse");

  const bodyEl = document.getElementById("tr-body");
  const panel = document.getElementById("lt04-panel");
  const statusEl = document.getElementById("lt04-status");
  let rows = [];

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/open-transfer-requirements");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.textContent = "No open transfer requirements.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} open TR(s)</p>
      <table>
        <thead><tr><th>TR</th><th>Material</th><th>Batch</th><th>Qty</th><th>UoM</th><th>Storage Loc</th><th>MRP Ctrl</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${esc(r.trNumber)}</td>
              <td>${esc(r.material)}</td>
              <td>${esc(r.batch)}</td>
              <td>${esc(r.quantity)}</td>
              <td>${esc(r.uom)}</td>
              <td>${esc(r.storageLocation)}</td>
              <td>${esc(r.mrpController)}</td>
              <td>${esc(r.createdDate)} ${esc(r.createdTime)}</td>
              <td><button type="button" class="btn secondary" data-idx="${i}">LT04</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => openPanel(rows[Number(btn.dataset.idx)]));
    });
  }

  let current = null;
  function openPanel(row) {
    current = row;
    document.getElementById("lt04-tr").value = row.trNumber;
    document.getElementById("lt04-material").value = row.material;
    document.getElementById("lt04-quantity").value = row.quantity;
    document.getElementById("lt04-dest-type").value = "";
    document.getElementById("lt04-dest-bin").value = "";
    document.getElementById("lt04-pallet").value = row.batch || "";
    statusEl.textContent = "";
    panel.style.display = "block";
    panel.scrollIntoView({ behavior: "smooth" });
  }

  document.getElementById("lt04-cancel").addEventListener("click", () => { panel.style.display = "none"; });

  document.getElementById("lt04-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    statusEl.textContent = "Confirming…";
    try {
      const body = {
        trNumber: current.trNumber,
        material: current.material,
        quantity: Number(document.getElementById("lt04-quantity").value),
        destinationType: document.getElementById("lt04-dest-type").value.trim(),
        destinationBin: document.getElementById("lt04-dest-bin").value.trim(),
        palletOrBatch: document.getElementById("lt04-pallet").value.trim(),
        storageLocation: current.storageLocation,
      };
      const { data } = await api("/create-lt04", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = data?.type === "S" ? `LT04 confirmed: ${data.message}` : `Result: ${data?.message || "unknown"}`;
      await load();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });

  document.getElementById("tr-refresh").addEventListener("click", load);
  load();
})();
