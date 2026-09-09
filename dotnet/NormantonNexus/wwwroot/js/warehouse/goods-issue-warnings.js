// Goods Issue Warnings tile — port of runGoodsIssueWarnings() in private/js/warehouse.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("gw-body");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/goods-issue/warnings");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No Goods Issue warnings.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} warning(s)</p>
      <table>
        <thead><tr><th>Delivery</th><th>Status</th><th>Messages</th><th>Ran At</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.deliveryId)}</td>
              <td>${esc(r.status)}</td>
              <td>${(r.messages || []).map((m) => esc(m.message)).join("; ")}</td>
              <td>${r.ranAtUtc ? new Date(r.ranAtUtc).toLocaleString("en-GB") : ""}</td>
              <td>
                <button type="button" class="btn secondary" data-id="${r.deliveryId}" data-action="reprocess">Reprocess</button>
                <button type="button" class="btn secondary" data-id="${r.deliveryId}" data-action="resolve">Resolve</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-action='reprocess']").forEach((btn) => {
      btn.addEventListener("click", () => act(btn.dataset.id, "reprocess"));
    });
    bodyEl.querySelectorAll("button[data-action='resolve']").forEach((btn) => {
      btn.addEventListener("click", () => act(btn.dataset.id, "resolve"));
    });
  }

  async function act(deliveryId, action) {
    try {
      const opts = { method: "POST" };
      if (action === "resolve") {
        const note = prompt("Resolution note (optional):") || null;
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify({ note });
      }
      await api(`/${deliveryId}/goods-issue/${action}`, opts);
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  document.getElementById("gw-refresh").addEventListener("click", load);
  load();
})();
