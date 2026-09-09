// Admin > Permission Group detail — the permission-checkbox grid (grouped
// by category, one "Save Permissions" bulk-set call) and bulk-assign-to-
// users, replacing the earlier one-permission/one-user-at-a-time forms.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const bodyEl = document.getElementById("pgd-body");
  const groupId = bodyEl.dataset.groupId;

  let group = null;
  let allPermissions = [];
  let allUsers = [];

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const [groupRes, permsRes, usersRes] = await Promise.all([
        api(`/permission-groups/${groupId}`),
        api("/permission-groups-options/permissions"),
        api("/permission-groups-options/users"),
      ]);
      group = groupRes.data;
      allPermissions = permsRes.data || [];
      allUsers = usersRes.data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    if (!group) { bodyEl.innerHTML = '<div class="nx-empty">Group not found.</div>'; return; }

    const checked = new Set(group.permissionCodes || []);
    const byCategory = new Map();
    for (const p of allPermissions) {
      const cat = p.category || "Uncategorised";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(p);
    }
    const categoriesHtml = [...byCategory.keys()].sort().map((cat) => `
      <div class="tf-field tf-field--wide" style="margin-bottom:14px">
        <label class="tf-label">${esc(cat)}</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:4px">
          ${byCategory.get(cat).map((p) => `
            <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:400">
              <input type="checkbox" class="pgd-perm-check" value="${esc(p.permissionCode)}" ${checked.has(p.permissionCode) ? "checked" : ""}>
              ${esc(p.permissionCode)} <span style="color:var(--text-muted)">— ${esc(p.permissionName)}</span>
            </label>`).join("")}
        </div>
      </div>`).join("");

    const memberIds = new Set((group.members || []).map((m) => m.userId));
    const assignable = allUsers.filter((u) => !memberIds.has(u.userId));

    bodyEl.innerHTML = `
      <h3 style="margin:0 0 4px">${esc(group.groupName)}</h3>
      <p style="color:var(--text-muted);font-size:12.5px;margin:0 0 16px">${esc(group.description || "")}</p>

      <div class="nx-toolbar" style="margin-bottom:6px"><div class="nx-toolbar-title">Permissions</div></div>
      ${categoriesHtml || '<div class="nx-empty">No permission definitions exist yet.</div>'}
      <button type="button" class="btn" id="pgd-save-perms-btn">Save Permissions</button>
      <div id="pgd-perms-result" style="margin-top:6px"></div>

      <div class="nx-toolbar" style="margin:24px 0 6px"><div class="nx-toolbar-title">Members (${(group.members || []).length})</div></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>User</th><th></th></tr></thead>
        <tbody>${(group.members || []).length === 0
          ? '<tr><td colspan="2" style="color:var(--text-muted)">No members yet.</td></tr>'
          : group.members.map((m) => `
            <tr>
              <td>${esc(m.username)}</td>
              <td><button type="button" class="secondary pgd-remove-user-btn" data-id="${m.userId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Remove</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>

      <div class="nx-toolbar" style="margin:20px 0 6px"><div class="nx-toolbar-title">Assign to users</div></div>
      <select id="pgd-assign-select" class="tf-input" multiple size="8" style="max-width:360px">
        ${assignable.map((u) => `<option value="${u.userId}">${esc(u.username)}</option>`).join("")}
      </select>
      <div style="margin-top:8px">
        <button type="button" class="btn" id="pgd-assign-btn">Assign Selected</button>
      </div>
      <div id="pgd-assign-result" style="margin-top:6px"></div>`;

    document.getElementById("pgd-save-perms-btn").addEventListener("click", saveSelectedPermissions);
    bodyEl.querySelectorAll(".pgd-remove-user-btn").forEach((btn) => btn.addEventListener("click", () => removeUser(btn.dataset.id)));
    document.getElementById("pgd-assign-btn").addEventListener("click", assignSelectedUsers);
  }

  async function saveSelectedPermissions() {
    const btn = document.getElementById("pgd-save-perms-btn");
    const result = document.getElementById("pgd-perms-result");
    const permissionCodes = [...bodyEl.querySelectorAll(".pgd-perm-check:checked")].map((cb) => cb.value);
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api(`/permission-groups/${groupId}/permissions`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionCodes }),
      });
      result.innerHTML = '<span style="color:var(--success,#16A34A);font-size:12.5px">Saved.</span>';
      await load();
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Save Permissions";
    }
  }

  async function removeUser(userId) {
    if (!(await NexusModal.confirm("Remove this user from the group?", { confirmLabel: "Remove" }))) return;
    try {
      await api(`/permission-groups/${groupId}/users/${userId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      await NexusModal.alert(err.message);
    }
  }

  async function assignSelectedUsers() {
    const select = document.getElementById("pgd-assign-select");
    const result = document.getElementById("pgd-assign-result");
    const userIds = [...select.selectedOptions].map((o) => Number(o.value));
    if (!userIds.length) { result.innerHTML = '<div class="tf-inline-error">Select at least one user.</div>'; return; }
    const btn = document.getElementById("pgd-assign-btn");
    btn.disabled = true; btn.textContent = "Assigning…";
    try {
      await api(`/permission-groups/${groupId}/users`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds }),
      });
      await load();
    } catch (err) {
      result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = "Assign Selected";
    }
  }

  load();
})();
