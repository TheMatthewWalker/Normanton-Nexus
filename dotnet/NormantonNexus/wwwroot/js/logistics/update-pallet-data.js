// Update Pallet Data tile — GET/PUT /api/palletdata, split out of the old
// combined Reference Data page to match Node's own separate-tile grouping.
// View + edit-in-place only — no create/delete (a fixed master set).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const el = document.getElementById("upd-list");

  async function load() {
    el.textContent = "Loading…";
    try {
      const { data } = await api("/palletdata");
      render(data || []);
    } catch (err) {
      el.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No pallet data.</div>'; return; }
    el.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Pallet ID</th><th>Description</th><th>Weight</th><th>L</th><th>W</th><th>H</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-row="${esc(r.palletId)}">
              <td>${esc(r.palletId)}</td>
              <td><input class="tf-input" type="text" value="${esc(r.palletDescription)}" data-f="palletDescription" style="width:10em"></td>
              <td><input class="tf-input" type="number" step="0.01" value="${r.palletWeight ?? ""}" data-f="palletWeight" style="width:6em"></td>
              <td><input class="tf-input" type="number" value="${r.palletLength ?? ""}" data-f="palletLength" style="width:5em"></td>
              <td><input class="tf-input" type="number" value="${r.palletWidth ?? ""}" data-f="palletWidth" style="width:5em"></td>
              <td><input class="tf-input" type="number" value="${r.palletHeight ?? ""}" data-f="palletHeight" style="width:5em"></td>
              <td><button type="button" class="secondary" data-save="${esc(r.palletId)}">Save</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>`;
    el.querySelectorAll("button[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = el.querySelector(`tr[data-row="${btn.dataset.save}"]`);
        const body = {
          palletDescription: tr.querySelector('[data-f="palletDescription"]').value || null,
          palletWeight: tr.querySelector('[data-f="palletWeight"]').value ? Number(tr.querySelector('[data-f="palletWeight"]').value) : null,
          palletLength: tr.querySelector('[data-f="palletLength"]').value ? Number(tr.querySelector('[data-f="palletLength"]').value) : null,
          palletWidth: tr.querySelector('[data-f="palletWidth"]').value ? Number(tr.querySelector('[data-f="palletWidth"]').value) : null,
          palletHeight: tr.querySelector('[data-f="palletHeight"]').value ? Number(tr.querySelector('[data-f="palletHeight"]').value) : null,
        };
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          await api(`/palletdata/${encodeURIComponent(btn.dataset.save)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
