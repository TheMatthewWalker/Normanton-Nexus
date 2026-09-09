// Admin > Permission Groups — list/create/edit/delete, replacing the
// earlier one-row-at-a-time Razor Page handler version. Per-group
// permission-checkbox-grid and bulk-assign-to-users live on the detail
// page (permission-group-detail.js) — this page is just the list + the
// group-level CRUD.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const bodyEl = document.getElementById("pg-body");
  let rows = [];

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const { data } = await api("/permission-groups");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    document.getElementById("pg-hint").textContent = `${rows.length} group(s)`;
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No permission groups yet.</div>'; return; }
    bodyEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Group</th><th>Description</th><th>Permissions</th><th>Members</th><th></th></tr></thead>
        <tbody>${rows.map((g) => `
          <tr>
            <td><a href="/Admin/PermissionGroupDetail/${g.groupId}">${esc(g.groupName)}</a></td>
            <td>${esc(g.description || "—")}</td>
            <td>${esc(g.permissionCount)}</td>
            <td>${esc(g.memberCount)}</td>
            <td>
              <button type="button" class="secondary pg-edit-btn" data-id="${g.groupId}" style="padding:3px 8px;font-size:11px">Rename</button>
              <button type="button" class="secondary pg-delete-btn" data-id="${g.groupId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".pg-edit-btn").forEach((btn) => btn.addEventListener("click", () => openEditModal(rows.find((g) => String(g.groupId) === btn.dataset.id))));
    bodyEl.querySelectorAll(".pg-delete-btn").forEach((btn) => btn.addEventListener("click", async () => {
      const group = rows.find((g) => String(g.groupId) === btn.dataset.id);
      if (!(await NexusModal.confirm(`Delete "${group.groupName}"? This removes it from every member who holds it.`, { danger: true, confirmLabel: "Delete" }))) return;
      try {
        await api(`/permission-groups/${btn.dataset.id}`, { method: "DELETE" });
        await load();
      } catch (err) {
        await NexusModal.alert(err.message);
      }
    }));
  }

  function openGroupModal(title, group) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${esc(title)}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Name</label><input class="tf-input" type="text" id="pgm-name" value="${esc(group?.groupName || "")}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Description</label><input class="tf-input" type="text" id="pgm-desc" value="${esc(group?.description || "")}"></div>
        </div>
        <div id="pgm-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="pgm-cancel">Cancel</button>
        <button type="button" class="btn" id="pgm-save-btn">Save</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pgm-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pgm-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#pgm-save-btn");
      const result = card.querySelector("#pgm-result");
      const groupName = card.querySelector("#pgm-name").value.trim();
      const description = card.querySelector("#pgm-desc").value.trim() || null;
      if (!groupName) { result.innerHTML = '<div class="tf-inline-error">Name is required.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (group) {
          await api(`/permission-groups/${group.groupId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupName, description }) });
          NexusModal.close();
          await load();
        } else {
          const { data } = await api("/permission-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupName, description }) });
          NexusModal.close();
          window.location.href = `/Admin/PermissionGroupDetail/${data.groupId}`;
        }
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Save";
      }
    });
  }

  function openEditModal(group) { openGroupModal("Rename Group", group); }

  document.getElementById("pg-create-btn").addEventListener("click", () => openGroupModal("New Permission Group", null));

  load();
})();
