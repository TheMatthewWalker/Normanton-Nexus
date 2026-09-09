// Admin > Permission Group detail. Design approved via the /design canvas
// "Permission Groups Redesign" — replaces the old single long scrolling
// page (checkbox grid + members table + a bare native <select multiple>)
// with three tabs, real search/filter on both the permission grid and the
// user picker, and a sticky unsaved-changes save bar that only appears once
// a checkbox actually changes, so the save action is never lost at the
// bottom of a long page.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const bodyEl = document.getElementById("pgd-body");
  const groupId = bodyEl.dataset.groupId;

  let group = null;
  let allPermissions = [];
  let allUsers = [];

  const state = {
    activeTab: "permissions",
    permSearch: "",
    checked: new Set(),
    savedChecked: new Set(),
    collapsed: new Set(),
    memberSearch: "",
    addSearch: "",
    pendingIds: new Set(),
  };

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
      state.checked = new Set(group.permissionCodes || []);
      state.savedChecked = new Set(group.permissionCodes || []);
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  // Reload just the group (members/permissions) after a mutating call —
  // keeps the two directory fetches (allPermissions/allUsers) from being
  // re-fetched every time, since only the group's own state changed.
  async function reloadGroup() {
    const { data } = await api(`/permission-groups/${groupId}`);
    group = data;
    state.checked = new Set(group.permissionCodes || []);
    state.savedChecked = new Set(group.permissionCodes || []);
  }

  function initials(username) {
    const parts = String(username || "").split(/[.\s_-]+/).filter(Boolean);
    return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
  }

  function highlight(text, query) {
    if (!query) return esc(text);
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + '<mark class="pg-hl">' + esc(text.slice(i, i + query.length)) + "</mark>" + esc(text.slice(i + query.length));
  }

  function isDirty() {
    if (state.checked.size !== state.savedChecked.size) return true;
    for (const code of state.checked) if (!state.savedChecked.has(code)) return true;
    return false;
  }

  function render() {
    if (!group) { bodyEl.innerHTML = '<div class="nx-empty">Group not found.</div>'; return; }

    bodyEl.innerHTML = `
      <h3 style="margin:0 0 4px">${esc(group.groupName)}</h3>
      <p style="color:var(--text-muted);font-size:12.5px;margin:0 0 18px">${esc(group.description || "")}</p>

      <div class="pg-tabs">
        <button type="button" class="pg-tab ${state.activeTab === "permissions" ? "pg-tab--active" : ""}" id="pgd-tab-perms">Permissions <span class="pg-tab-count">${group.permissionCodes.length}</span></button>
        <button type="button" class="pg-tab ${state.activeTab === "members" ? "pg-tab--active" : ""}" id="pgd-tab-members">Members <span class="pg-tab-count">${group.members.length}</span></button>
        <button type="button" class="pg-tab ${state.activeTab === "add" ? "pg-tab--active" : ""}" id="pgd-tab-add">+ Add Members</button>
      </div>

      <div id="pgd-tab-body"></div>`;

    document.getElementById("pgd-tab-perms").addEventListener("click", () => { state.activeTab = "permissions"; render(); });
    document.getElementById("pgd-tab-members").addEventListener("click", () => { state.activeTab = "members"; render(); });
    document.getElementById("pgd-tab-add").addEventListener("click", () => { state.activeTab = "add"; render(); });

    if (state.activeTab === "permissions") renderPermissionsTab();
    else if (state.activeTab === "members") renderMembersTab();
    else renderAddTab();

    renderSaveBar();
  }

  function renderSearchBox(id, placeholder, value) {
    return `<div class="pg-search" style="margin-bottom:16px">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="text" id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}">
    </div>`;
  }

  function wireSearchBox(id, onInput) {
    const input = document.getElementById(id);
    input.addEventListener("input", () => {
      const caret = input.selectionStart;
      onInput(input.value);
      document.getElementById(id).focus();
      document.getElementById(id).setSelectionRange(caret, caret);
    });
  }

  // ── Permissions tab ──────────────────────────────────────────────────

  function renderPermissionsTab() {
    const tabBody = document.getElementById("pgd-tab-body");
    const q = state.permSearch.trim().toLowerCase();

    const byCategory = new Map();
    for (const p of allPermissions) {
      const cat = p.category || "Uncategorised";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(p);
    }

    const categoriesHtml = [...byCategory.keys()].sort().map((cat) => {
      const all = byCategory.get(cat);
      const matching = q ? all.filter((p) => p.permissionCode.toLowerCase().includes(q) || p.permissionName.toLowerCase().includes(q)) : all;
      if (matching.length === 0) return "";
      const checkedInCat = all.filter((p) => state.checked.has(p.permissionCode)).length;
      const expanded = q ? true : !state.collapsed.has(cat);
      return `
        <div class="ps-section${expanded ? "" : " ps-section--collapsed"}">
          <div class="ps-section-header pgd-cat-toggle" data-cat="${esc(cat)}">
            <span class="ps-chevron">&#9660;</span>
            <span class="ps-section-title">${esc(cat)}</span>
            <span class="ps-section-count">${checkedInCat} / ${all.length}</span>
          </div>
          <div class="ps-section-body pg-perm-grid">
            ${matching.map((p) => `
              <label class="pg-perm-row">
                <input type="checkbox" class="pg-perm-checkbox pgd-perm-check" data-code="${esc(p.permissionCode)}" ${state.checked.has(p.permissionCode) ? "checked" : ""}>
                <div>
                  <div class="pg-perm-code">${highlight(p.permissionCode, q)}</div>
                  <div class="pg-perm-name">${esc(p.permissionName)}</div>
                </div>
              </label>`).join("")}
          </div>
        </div>`;
    }).join("");

    tabBody.innerHTML = renderSearchBox("pgd-perm-search", "Search permissions by code or name…", state.permSearch)
      + (categoriesHtml || '<div class="nx-empty">No permission definitions match your search.</div>');

    wireSearchBox("pgd-perm-search", (value) => { state.permSearch = value; render(); });
    tabBody.querySelectorAll(".pgd-cat-toggle").forEach((el) => el.addEventListener("click", () => {
      const cat = el.dataset.cat;
      if (state.collapsed.has(cat)) state.collapsed.delete(cat); else state.collapsed.add(cat);
      render();
    }));
    tabBody.querySelectorAll(".pgd-perm-check").forEach((cb) => cb.addEventListener("change", () => {
      const code = cb.dataset.code;
      if (state.checked.has(code)) state.checked.delete(code); else state.checked.add(code);
      render();
    }));
  }

  // ── Members tab ──────────────────────────────────────────────────────

  function renderMembersTab() {
    const tabBody = document.getElementById("pgd-tab-body");
    const q = state.memberSearch.trim().toLowerCase();
    const filtered = q ? group.members.filter((m) => m.username.toLowerCase().includes(q)) : group.members;

    tabBody.innerHTML = renderSearchBox("pgd-member-search", "Search members…", state.memberSearch) + (
      group.members.length === 0
        ? '<div class="nx-empty">No members yet — use + Add Members to assign this group.</div>'
        : filtered.length === 0
          ? `<div class="nx-empty">No members match "${esc(state.memberSearch)}".</div>`
          : `<div style="overflow-x:auto"><table>
              <thead><tr><th>User</th><th style="width:110px"></th></tr></thead>
              <tbody>${filtered.map((m) => `
                <tr>
                  <td>${esc(m.username)}</td>
                  <td><button type="button" class="secondary pgd-remove-btn" data-id="${m.userId}" style="padding:4px 10px;font-size:11px;color:var(--error)">Remove</button></td>
                </tr>`).join("")}</tbody>
            </table></div>`
    );

    wireSearchBox("pgd-member-search", (value) => { state.memberSearch = value; render(); });
    tabBody.querySelectorAll(".pgd-remove-btn").forEach((btn) => btn.addEventListener("click", async () => {
      if (!(await NexusModal.confirm("Remove this user from the group?", { confirmLabel: "Remove" }))) return;
      try {
        await api(`/permission-groups/${groupId}/users/${btn.dataset.id}`, { method: "DELETE" });
        await reloadGroup();
        render();
      } catch (err) {
        await NexusModal.alert(err.message);
      }
    }));
  }

  // ── Add Members tab ──────────────────────────────────────────────────

  function renderAddTab() {
    const tabBody = document.getElementById("pgd-tab-body");
    const memberIds = new Set(group.members.map((m) => m.userId));
    const available = allUsers.filter((u) => !memberIds.has(u.userId));
    const aq = state.addSearch.trim().toLowerCase();
    const filtered = (aq ? available.filter((u) => u.username.toLowerCase().includes(aq)) : available).slice(0, 60);
    const pending = available.filter((u) => state.pendingIds.has(u.userId));

    tabBody.innerHTML = `
      <p style="font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--text-muted);margin:0 0 10px">Search the user directory and pick everyone you want to add — nothing is assigned until you confirm below.</p>
      <div class="pg-chip-tray">
        ${pending.length === 0
          ? '<span class="pg-chip-tray-empty">No users selected yet — click a name below to add it here.</span>'
          : pending.map((u) => `<span class="pg-chip">${esc(u.username)}<span class="pg-chip-x" data-id="${u.userId}">&times;</span></span>`).join("")}
      </div>
      ${renderSearchBox("pgd-add-search", `Search ${available.length} users…`, state.addSearch)}
      <div class="pg-user-list">
        ${filtered.length === 0
          ? `<div class="empty" style="padding:20px;text-align:center;color:var(--text-muted);font-size:12.5px">No one matches "${esc(state.addSearch)}".</div>`
          : filtered.map((u) => `
            <div class="pg-user-row pgd-user-row ${state.pendingIds.has(u.userId) ? "pg-user-row--picked" : ""}" data-id="${u.userId}">
              <div class="pg-user-avatar">${esc(initials(u.username))}</div>
              <div class="pg-user-name">${esc(u.username)}</div>
              ${state.pendingIds.has(u.userId) ? '<span class="pg-user-pick-mark">&#10003; Added</span>' : ""}
            </div>`).join("")}
      </div>
      <div style="margin-top:14px">
        <button type="button" class="btn" id="pgd-confirm-add-btn" ${pending.length === 0 ? "disabled" : ""}>${pending.length === 0 ? "Add Selected" : `Add ${pending.length} Selected`}</button>
      </div>
      <div id="pgd-add-result" style="margin-top:6px"></div>`;

    wireSearchBox("pgd-add-search", (value) => { state.addSearch = value; render(); });
    tabBody.querySelectorAll(".pgd-user-row").forEach((row) => row.addEventListener("click", () => {
      const id = Number(row.dataset.id);
      if (state.pendingIds.has(id)) state.pendingIds.delete(id); else state.pendingIds.add(id);
      render();
    }));
    tabBody.querySelectorAll(".pg-chip-x").forEach((x) => x.addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingIds.delete(Number(x.dataset.id));
      render();
    }));
    const confirmBtn = document.getElementById("pgd-confirm-add-btn");
    if (confirmBtn) confirmBtn.addEventListener("click", async () => {
      const result = document.getElementById("pgd-add-result");
      confirmBtn.disabled = true; confirmBtn.textContent = "Adding…";
      try {
        await api(`/permission-groups/${groupId}/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds: [...state.pendingIds] }) });
        state.pendingIds.clear();
        state.addSearch = "";
        state.activeTab = "members";
        await reloadGroup();
        render();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        confirmBtn.disabled = false; confirmBtn.textContent = "Add Selected";
      }
    });
  }

  // ── Sticky save bar (Permissions tab only) ────────────────────────────

  function renderSaveBar() {
    const existing = document.getElementById("pgd-save-bar");
    if (existing) existing.remove();
    document.getElementById("pgd-saved-toast")?.remove();

    if (state.activeTab !== "permissions" || !isDirty()) return;

    let changed = 0;
    for (const code of state.checked) if (!state.savedChecked.has(code)) changed++;
    for (const code of state.savedChecked) if (!state.checked.has(code)) changed++;

    const bar = document.createElement("div");
    bar.id = "pgd-save-bar";
    bar.className = "pg-save-bar";
    bar.innerHTML = `
      <div class="pg-save-bar-inner">
        <div>
          <div class="pg-save-bar-text">${changed} permission${changed === 1 ? "" : "s"} changed</div>
          <div class="pg-save-bar-sub">Nothing is saved until you confirm</div>
        </div>
        <button type="button" class="pg-discard-btn" id="pgd-discard-btn">Discard</button>
        <button type="button" class="pg-save-btn" id="pgd-save-btn">Save Permissions</button>
      </div>`;
    document.body.appendChild(bar);

    document.getElementById("pgd-discard-btn").addEventListener("click", () => {
      state.checked = new Set(state.savedChecked);
      render();
    });
    document.getElementById("pgd-save-btn").addEventListener("click", async () => {
      const btn = document.getElementById("pgd-save-btn");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api(`/permission-groups/${groupId}/permissions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionCodes: [...state.checked] }) });
        await reloadGroup();
        render();
        const toast = document.createElement("div");
        toast.id = "pgd-saved-toast";
        toast.className = "pg-saved-toast";
        toast.textContent = "✓ Permissions saved";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1800);
      } catch (err) {
        await NexusModal.alert(err.message);
        render();
      }
    });
  }

  load();
})();
