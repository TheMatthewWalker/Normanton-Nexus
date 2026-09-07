// Bin Restrictions tile — port of runStagingBinRestrictions() in private/js/warehouse.js.
// Writes are LOG_SUPER-gated server-side (StagingController) — a
// non-supervisor sees the add form but gets a clear 403 on submit, same
// "API's 403 is the real gate either way" principle used throughout this app.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/staging");
  const bodyEl = document.getElementById("br-body");
  const statusEl = document.getElementById("br-status");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/bin-restrictions");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No bin restrictions.";
      return;
    }
    bodyEl.innerHTML = `
      <table>
        <thead><tr><th>Material</th><th>Storage Type</th><th>Bin</th><th>Notes</th><th>Created By</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.material)}</td>
              <td>${esc(r.storageType)}</td>
              <td>${esc(r.bin)}</td>
              <td>${esc(r.notes)}</td>
              <td>${esc(r.createdBy)}</td>
              <td><button type="button" class="btn secondary" data-id="${r.restrictionId}">Delete</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this restriction?")) return;
        try {
          await api(`/bin-restrictions/${btn.dataset.id}`, { method: "DELETE" });
          await load();
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  }

  document.getElementById("br-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "Adding…";
    try {
      const body = {
        material: document.getElementById("br-material").value.trim(),
        storageType: document.getElementById("br-storage-type").value.trim(),
        bin: document.getElementById("br-bin").value.trim() || null,
        notes: document.getElementById("br-notes").value.trim() || null,
      };
      await api("/bin-restrictions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = "Added.";
      e.target.reset();
      await load();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });

  load();
})();
