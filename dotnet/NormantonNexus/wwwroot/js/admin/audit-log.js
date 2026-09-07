// Admin > Audit Log — filtered search over dbo.AuditLog.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");

  async function search() {
    const el = document.getElementById("al-results");
    el.textContent = "Loading…";
    const params = new URLSearchParams();
    const event = document.getElementById("al-event").value.trim();
    const username = document.getElementById("al-username").value.trim();
    const detail = document.getElementById("al-detail").value.trim();
    const from = document.getElementById("al-from").value;
    const to = document.getElementById("al-to").value;
    if (event) params.set("event", event);
    if (username) params.set("username", username);
    if (detail) params.set("detail", detail);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const { data } = await api(`/audit?${params.toString()}`);
      const rows = data || [];
      el.innerHTML = rows.length === 0 ? "<p>No matching events.</p>" : `
        <p>${rows.length} event(s)</p>
        <table>
          <thead><tr><th>Time</th><th>Username</th><th>Event</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${new Date(r.eventTime).toLocaleString("en-GB")}</td>
                <td>${esc(r.username)}</td>
                <td>${esc(r.eventType)}</td>
                <td>${esc(r.detail)}</td>
                <td>${esc(r.ipAddress)}</td>
              </tr>`).join("")}
          </tbody>
        </table>`;
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  document.getElementById("al-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search();
  });

  search();
})();
