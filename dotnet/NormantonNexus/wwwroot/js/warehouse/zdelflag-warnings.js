// ZDELFLAG Warnings tile — port of runZdelflagWarnings() in private/js/warehouse.js.
// Reprocess is WAREHOUSE_OP-gated; Resolve is LOG_SUPER-gated (server-side,
// DeliveryMainController) — both buttons are shown to everyone, the API's
// 403 is the real gate for whichever action a given user can't take.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("zw-body");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/zdelflag/warnings");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No ZDELFLAG warnings.";
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
      await api(`/${deliveryId}/zdelflag/${action}`, opts);
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  document.getElementById("zw-refresh").addEventListener("click", load);
  load();
})();
