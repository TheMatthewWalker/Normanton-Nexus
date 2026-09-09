// Admin > Permission Groups — list/create/rename/delete. Design approved via
// the /design canvas "Permission Groups Redesign": a searchable card grid
// instead of a plain table, so a group's description isn't truncated and
// its two headline numbers (permissions/members) are scannable at a glance.
// Per-group permission-checkbox grid and bulk-assign-to-users live on the
// detail page (permission-group-detail.js).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const bodyEl = document.getElementById("pg-body");
  const searchInput = document.getElementById("pg-search-input");
  let rows = [];
  let search = "";

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
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((g) => g.groupName.toLowerCase().includes(q) || (g.description || "").toLowerCase().includes(q))
      : rows;

    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No permission groups yet.</div>'; return; }
    if (filtered.length === 0) { bodyEl.innerHTML = `<div class="nx-empty">No groups match "${esc(search)}".</div>`; return; }

    bodyEl.innerHTML = `<div class="pg-grid">${filtered.map((g) => `
      <div class="pg-card">
        <div class="pg-card-name"><a href="/Admin/PermissionGroupDetail/${g.groupId}">${esc(g.groupName)}</a></div>
        <p class="pg-card-desc">${esc(g.description || "No description.")}</p>
        <div class="pg-card-stats">
          <div class="pg-card-stat">${esc(g.permissionCount)} permission${g.permissionCount === 1 ? "" : "s"}</div>
          <div class="pg-card-stat">${esc(g.memberCount)} member${g.memberCount === 1 ? "" : "s"}</div>
        </div>
        <div class="pg-card-actions">
          <a class="secondary pg-card-manage-btn" href="/Admin/PermissionGroupDetail/${g.groupId}">Manage &rarr;</a>
          <button type="button" class="secondary pg-card-icon-btn pg-rename-btn" data-id="${g.groupId}" title="Rename">&#9998;</button>
          <button type="button" class="secondary pg-card-icon-btn pg-delete-btn" data-id="${g.groupId}" title="Delete" style="color:var(--error)">&#128465;</button>
        </div>
      </div>`).join("")}</div>`;

    bodyEl.querySelectorAll(".pg-rename-btn").forEach((btn) => btn.addEventListener("click", () => openGroupModal("Rename Group", rows.find((g) => String(g.groupId) === btn.dataset.id))));
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
          <div class="tf-field tf-field--wide"><label class="tf-label">Name</label><input class="tf-input" type="text" id="pgm-name" value="${esc(group?.groupName || "")}" placeholder="e.g. Warehouse Supervisor"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Description</label><input class="tf-input" type="text" id="pgm-desc" value="${esc(group?.description || "")}" placeholder="What access does this bundle grant?"></div>
        </div>
        <div id="pgm-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="pgm-cancel">Cancel</button>
        <button type="button" class="btn" id="pgm-save-btn">Save</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pgm-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#pgm-name").focus();
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

  document.getElementById("pg-create-btn").addEventListener("click", () => openGroupModal("New Permission Group", null));
  searchInput.addEventListener("input", () => { search = searchInput.value; render(); });

  load();
})();
