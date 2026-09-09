// Update Packaging Data tile — GET/PUT /api/packagingdata, split out of the
// old combined Reference Data page to match Node's own separate-tile
// grouping. View + edit-in-place only — no create/delete (a fixed master set).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const el = document.getElementById("upa-list");

  async function load() {
    el.textContent = "Loading…";
    try {
      const { data } = await api("/packagingdata");
      render(data || []);
    } catch (err) {
      el.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No packaging data.</div>'; return; }
    el.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Pack ID</th><th>Material</th><th>Description</th><th>Weight</th><th>L</th><th>W</th><th>H</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-row="${esc(r.packId)}">
              <td>${esc(r.packId)}</td>
              <td><input class="tf-input" type="text" value="${esc(r.packMaterial)}" data-f="packMaterial" style="width:8em"></td>
              <td><input class="tf-input" type="text" value="${esc(r.packDescription)}" data-f="packDescription" style="width:10em"></td>
              <td><input class="tf-input" type="number" step="0.01" value="${r.packWeight ?? ""}" data-f="packWeight" style="width:6em"></td>
              <td><input class="tf-input" type="number" value="${r.packLength ?? ""}" data-f="packLength" style="width:5em"></td>
              <td><input class="tf-input" type="number" value="${r.packWidth ?? ""}" data-f="packWidth" style="width:5em"></td>
              <td><input class="tf-input" type="number" value="${r.packHeight ?? ""}" data-f="packHeight" style="width:5em"></td>
              <td><button type="button" class="secondary" data-save="${esc(r.packId)}">Save</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>`;
    el.querySelectorAll("button[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = el.querySelector(`tr[data-row="${btn.dataset.save}"]`);
        const body = {
          packMaterial: tr.querySelector('[data-f="packMaterial"]').value || null,
          packDescription: tr.querySelector('[data-f="packDescription"]').value || null,
          packWeight: tr.querySelector('[data-f="packWeight"]').value ? Number(tr.querySelector('[data-f="packWeight"]').value) : null,
          packLength: tr.querySelector('[data-f="packLength"]').value ? Number(tr.querySelector('[data-f="packLength"]').value) : null,
          packWidth: tr.querySelector('[data-f="packWidth"]').value ? Number(tr.querySelector('[data-f="packWidth"]').value) : null,
          packHeight: tr.querySelector('[data-f="packHeight"]').value ? Number(tr.querySelector('[data-f="packHeight"]').value) : null,
        };
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          await api(`/packagingdata/${encodeURIComponent(btn.dataset.save)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          btn.textContent = "Saved";
          setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 1200);
        } catch (err) {
          await NexusModal.alert(err.message);
          btn.disabled = false; btn.textContent = "Save";
        }
      });
    });
  }

  load();
})();
