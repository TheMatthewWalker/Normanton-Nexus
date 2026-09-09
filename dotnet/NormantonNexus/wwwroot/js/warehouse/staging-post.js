// Staging Post (fulfil) tile — port of runStagingFulfil() in private/js/warehouse.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/staging");
  const bodyEl = document.getElementById("sp-body");
  const panel = document.getElementById("sp-deliver-panel");
  const statusEl = document.getElementById("dv-status");
  let rows = [];
  let current = null;

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/requests/open");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.textContent = "No open staging requests.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} open request(s)</p>
      <table>
        <thead><tr><th>#</th><th>Material</th><th>Qty Requested</th><th>Qty Delivered</th><th>Location</th><th>Due</th><th>Requested By</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${esc(r.requestId)}</td>
              <td>${esc(r.material)} ${esc(r.materialText)}</td>
              <td>${esc(r.quantityRequested)} ${esc(r.uom)}</td>
              <td>${esc(r.quantityDelivered)}</td>
              <td>${esc(r.location)}</td>
              <td>${r.dueAtUtc ? new Date(r.dueAtUtc).toLocaleString("en-GB") : ""}</td>
              <td>${esc(r.requestedBy)}</td>
              <td>
                <button type="button" class="btn secondary" data-idx="${i}" data-action="deliver">Deliver</button>
                <button type="button" class="btn secondary" data-idx="${i}" data-action="cancel">Cancel</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-action='deliver']").forEach((btn) => {
      btn.addEventListener("click", () => openDeliver(rows[Number(btn.dataset.idx)]));
    });
    bodyEl.querySelectorAll("button[data-action='cancel']").forEach((btn) => {
      btn.addEventListener("click", () => cancelRequest(rows[Number(btn.dataset.idx)]));
    });
  }

  async function cancelRequest(row) {
    if (!(await NexusModal.confirm(`Cancel request #${row.requestId}?`, { danger: true, confirmLabel: "Cancel Request", cancelLabel: "Back" }))) return;
    try {
      await api(`/requests/${row.requestId}/cancel`, { method: "POST" });
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  function openDeliver(row) {
    current = row;
    document.getElementById("dv-quantity").value = row.quantityRequested - row.quantityDelivered;
    document.getElementById("dv-batch").value = row.requestedBatch || "";
    document.getElementById("dv-storage-location").value = "";
    document.getElementById("dv-source-type").value = "";
    document.getElementById("dv-source-bin").value = "";
    document.getElementById("dv-dest-type").value = "";
    document.getElementById("dv-dest-bin").value = "";
    statusEl.textContent = "";
    panel.style.display = "block";
    panel.scrollIntoView({ behavior: "smooth" });
  }

  document.getElementById("dv-cancel").addEventListener("click", () => { panel.style.display = "none"; });

  document.getElementById("sp-deliver-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    statusEl.textContent = "Delivering…";
    try {
      const body = {
        quantity: Number(document.getElementById("dv-quantity").value),
        batch: document.getElementById("dv-batch").value || null,
        storageLocation: document.getElementById("dv-storage-location").value || null,
        sourceStorageType: document.getElementById("dv-source-type").value || null,
        sourceBin: document.getElementById("dv-source-bin").value || null,
        destinationStorageType: document.getElementById("dv-dest-type").value || null,
        destinationBin: document.getElementById("dv-dest-bin").value || null,
      };
      const { data } = await api(`/requests/${current.requestId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = `Status: ${data.status}${data.error ? " — " + data.error : ""}`;
      await load();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });

  document.getElementById("sp-refresh").addEventListener("click", load);
  load();
})();
