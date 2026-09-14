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
        if (r) openForm(r);
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

  const FIELDS = [
    { key: "code", label: "Code" },
    { key: "name", label: "Name" },
    { key: "description", label: "Description" },
    { key: "category", label: "Category" },
  ];

  function openForm(existing) {
    const fields = existing ? FIELDS.map((f) => (f.key === "code" ? { ...f, readonly: true } : f)) : FIELDS;
    const record = existing
      ? { code: existing.permissionCode, name: existing.permissionName || "", description: existing.description || "", category: existing.category || "" }
      : { code: "", name: "", description: "", category: "" };

    AdminEditModal.open(existing ? `Edit ${existing.permissionCode}` : "Add Permission", "", fields, record, async (values) => {
      const description = values.description || null;
      const category = values.category || null;

      if (existing) {
        await api(`/permissions/${encodeURIComponent(existing.permissionCode)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissionName: values.name, description, category }),
        });
      } else {
        const code = values.code.trim();
        if (!code) throw new Error("Code is required.");
        await api("/permissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissionCode: code, permissionName: values.name, description, category }),
        });
      }
      await load();
    });
  }

  const addBtn = document.getElementById("pd-add-btn");
  if (addBtn) addBtn.addEventListener("click", () => openForm(null));

  load();
})();
