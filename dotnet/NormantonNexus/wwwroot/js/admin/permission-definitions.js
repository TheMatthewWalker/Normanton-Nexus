// Admin > Permission Definitions — the PortalPermissions code registry.
// List is visible to any admin; create/edit/delete only render (and are
// only accepted server-side) for a superadmin.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const isSuperadmin = window.NexusIsSuperadmin === true;

  let rows = [];

  async function load() {
    const el = document.getElementById("pd-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/permissions");
      rows = data || [];
      render();
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    const el = document.getElementById("pd-list");
    el.innerHTML = rows.length === 0 ? "<p>No permission definitions.</p>" : `
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Category</th>${isSuperadmin ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.permissionCode)}</td><td>${esc(r.permissionName)}</td><td>${esc(r.description)}</td><td>${esc(r.category)}</td>
              ${isSuperadmin ? `<td>
                <button type="button" class="btn secondary" data-edit="${esc(r.permissionCode)}">Edit</button>
                <button type="button" class="btn secondary" data-delete="${esc(r.permissionCode)}">Delete</button>
              </td>` : ""}
            </tr>`).join("")}
        </tbody>
      </table>`;
    if (!isSuperadmin) return;
    el.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = rows.find((x) => x.permissionCode === btn.dataset.edit);
        if (!r) return;
        document.getElementById("pd-form-title").textContent = `Edit ${r.permissionCode}`;
        document.getElementById("pd-code-hidden").value = r.permissionCode;
        document.getElementById("pd-code").value = r.permissionCode;
        document.getElementById("pd-code").disabled = true;
        document.getElementById("pd-name").value = r.permissionName || "";
        document.getElementById("pd-desc").value = r.description || "";
        document.getElementById("pd-category").value = r.category || "";
      });
    });
    el.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm(`Delete permission ${btn.dataset.delete}? This also removes it from every user/group holding it.`, { danger: true, confirmLabel: "Delete" }))) return;
        try {
          await api(`/permissions/${encodeURIComponent(btn.dataset.delete)}`, { method: "DELETE" });
          await load();
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  }

  const form = document.getElementById("pd-form");
  if (form) {
    document.getElementById("pd-cancel").addEventListener("click", resetForm);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const editingCode = document.getElementById("pd-code-hidden").value;
      try {
        if (editingCode) {
          await api(`/permissions/${encodeURIComponent(editingCode)}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              permissionName: document.getElementById("pd-name").value,
              description: document.getElementById("pd-desc").value || null,
              category: document.getElementById("pd-category").value || null,
            }),
          });
        } else {
          await api("/permissions", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              permissionCode: document.getElementById("pd-code").value,
              permissionName: document.getElementById("pd-name").value,
              description: document.getElementById("pd-desc").value || null,
              category: document.getElementById("pd-category").value || null,
            }),
          });
        }
        resetForm();
        await load();
      } catch (err) {
        alert("Error: " + err.message);
      }
    });
  }

  function resetForm() {
    if (!form) return;
    form.reset();
    document.getElementById("pd-form-title").textContent = "Add Permission";
    document.getElementById("pd-code-hidden").value = "";
    document.getElementById("pd-code").disabled = false;
  }

  load();
})();
