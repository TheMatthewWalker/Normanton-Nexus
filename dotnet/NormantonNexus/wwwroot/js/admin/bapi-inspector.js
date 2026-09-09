// Admin > BAPI Inspector — superadmin-only SAP RFC/BAPI function metadata lookup.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin/bapi-inspector");

  document.getElementById("bi-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const el = document.getElementById("bi-result");
    const functionName = document.getElementById("bi-function").value.trim();
    if (!functionName) return;
    el.textContent = "Looking up…";
    try {
      const { data } = await api("/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ functionName }) });
      if (!data) {
        el.innerHTML = "<p>Not found.</p>";
        return;
      }
      el.innerHTML = `<pre style="white-space:pre-wrap; overflow-x:auto;">${esc(JSON.stringify(data, null, 2))}</pre>`;
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  });
})();
