/**
 * js/admin.js
 * Kongsberg Portal — User Administration UI
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const DEPARTMENTS = [
  'production','logistics','warehouse',
  'finance','sales','quality','engineering','management',
];

const DEPT_LABELS = {
  production:  'Production',  logistics:   'Logistics',
  warehouse:   'Warehouse',   finance:     'Finance',
  sales:       'Sales',       quality:     'Quality',
  engineering: 'Engineering', management:  'Management',
};

const ROLE_LEVEL = { operator: 1, admin: 2, superadmin: 3 };

// ── State ─────────────────────────────────────────────────────────────────────
let editingUserID     = null;
let approvingUserID   = null;
let allUsers          = [];
let allPermissions    = [];
let sessionRole       = '';
let sessionUserID     = null;
let permEditingCode   = null; // null = creating, string = editing

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSession();
  await Promise.all([loadPending(), loadUsers()]);
  setupNav();
  setupSearch();
  setupSqlConsole();

  // Load audit when that section is first opened
  document.querySelector('[data-section="audit"]')
    .addEventListener('click', () => { if (!allAuditLoaded) loadAudit(); }, { once: true });

  // Load notification history when that section is first opened
  document.querySelector('[data-section="notifications"]')
    .addEventListener('click', () => { loadNotifHistory(); setupNotifSend(); }, { once: true });

  // Load permissions when that section is first opened (superadmin only)
  const permNav = document.getElementById('nav-permissions');
  if (permNav) {
    permNav.addEventListener('click', () => { if (!allPermissionsLoaded) loadPermissions(); }, { once: true });
  }

  // Load scheduled deployments when that section is first opened (superadmin only)
  const deployNav = document.getElementById('nav-deployments');
  if (deployNav) {
    deployNav.addEventListener('click', () => { setupDeploySection(); }, { once: true });
  }

  // Load DB Explorer when that section is first opened (superadmin only)
  const dbxNav = document.getElementById('nav-dbexplorer');
  if (dbxNav) {
    dbxNav.addEventListener('click', () => { setupDbExplorer(); }, { once: true });
  }

  // Set up Bulk Create Users when that section is first opened (superadmin only)
  const bulkCreateNav = document.getElementById('nav-bulk-create');
  if (bulkCreateNav) {
    bulkCreateNav.addEventListener('click', () => { setupBulkCreate(); }, { once: true });
  }

  // Set up Mass Apply Permissions when that section is first opened
  document.querySelector('[data-section="mass-permissions"]')
    .addEventListener('click', () => { setupMassPermissions(); }, { once: true });
});

// ── Session ───────────────────────────────────────────────────────────────────
async function loadSession() {
  try {
    const data = await api('/session-check');
    if (!data.loggedIn) { location.href = '/'; return; }
    document.getElementById('session-user').textContent = data.username;
    document.getElementById('session-role').textContent = data.role;
    sessionRole   = data.role;
    sessionUserID = data.userID || null;
    applyRoleVisibility();
  } catch { location.href = '/'; }
}

function applyRoleVisibility() {
  // Show permissions nav only for superadmin
  const permNav = document.getElementById('nav-permissions');
  if (permNav) permNav.style.display = (sessionRole === 'superadmin') ? '' : 'none';

  // Show Bulk Create Users nav only for superadmin — client-side convenience
  // only; the real gate is server-side (routes/useradmin.js's requireSuperadmin
  // on POST /users/bulk-create).
  const bulkCreateNav = document.getElementById('nav-bulk-create');
  if (bulkCreateNav) bulkCreateNav.style.display = (sessionRole === 'superadmin') ? '' : 'none';

  // Show deployments nav only for superadmin
  const deployNav = document.getElementById('nav-deployments');
  if (deployNav) deployNav.style.display = (sessionRole === 'superadmin') ? '' : 'none';

  // Show DB Explorer nav only for superadmin — this is a client-side
  // convenience only; the real gate is server-side (routes/dbexplorer.js's
  // own requireSuperadmin), same as every other superadmin-only nav item
  // here.
  const dbxNav = document.getElementById('nav-dbexplorer');
  if (dbxNav) dbxNav.style.display = (sessionRole === 'superadmin') ? '' : 'none';

  // Show SQL Console nav only for superadmin — same client-side convenience
  // as above. The real gate is server-side: routes/sqlqueries.js only lets
  // superadmin bypass the destructive-keyword block (plain admin no longer
  // can), since /sql/query is shared infrastructure other department pages
  // also use for plain SELECTs and can't be locked to superadmin outright.
  const sqlNav = document.getElementById('nav-sql');
  if (sqlNav) sqlNav.style.display = (sessionRole === 'superadmin') ? '' : 'none';
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      item.classList.add('active');
      document.getElementById('section-' + item.dataset.section).classList.add('active');
    });
  });
}

// ── Pending Approvals ─────────────────────────────────────────────────────────
async function loadPending() {
  const list = document.getElementById('pending-list');
  list.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Loading…</div>';

  try {
    const data  = await api('/api/admin/pending');
    const badge = document.getElementById('pending-count');

    if (!data.users || data.users.length === 0) {
      badge.textContent = '0';
      badge.classList.add('zero');
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✓</div>
          No pending registration requests
        </div>`;
      return;
    }

    badge.textContent = data.users.length;
    badge.classList.remove('zero');

    list.innerHTML = data.users.map((u, i) => {
      const displayName = (u.FirstName && u.LastName)
        ? `${esc(u.FirstName)} ${esc(u.LastName)}`
        : esc(u.Username);
      return `
        <div class="pending-card" style="animation-delay:${i * 0.05}s">
          <div class="pending-avatar">${esc(u.Username.charAt(0).toUpperCase())}</div>
          <div class="pending-info">
            <div class="pending-name">${displayName}</div>
            <div class="pending-email">
              <span style="font-family:'JetBrains Mono',monospace;font-size:10px;opacity:.7">@${esc(u.Username)}</span>
              &nbsp;·&nbsp; ${esc(u.Email)}
            </div>
            <div class="pending-meta">Registered ${formatDate(u.CreatedAt)}</div>
          </div>
          <div class="pending-actions">
            <button class="btn-primary" onclick="openApproveModal(${u.UserID}, '${esc(u.Username)}', '${esc(u.Email)}')">
              Review &amp; Approve
            </button>
          </div>
        </div>`;
    }).join('');

  } catch (err) {
    list.innerHTML = `<div class="empty-state">✕ ${esc(err.message)}</div>`;
  }
}

// ── All Users ─────────────────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="10" class="loading-cell"><div class="spinner"></div> Loading…</td></tr>';

  try {
    const data = await api('/api/admin/users');
    allUsers = data.users || [];
    document.getElementById('users-count').textContent = allUsers.length;
    renderUsersTable(allUsers);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-cell">✕ ${esc(err.message)}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-tbody');

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-cell">No users found</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const statusBadge = u.IsLocked
      ? '<span class="badge badge--locked">Locked</span>'
      : u.IsActive
        ? '<span class="badge badge--active">Active</span>'
        : '<span class="badge badge--pending">Pending</span>';

    const deptTags = (u.departments || [])
      .map(d => `<span class="dept-tag">${esc(DEPT_LABELS[d] || d)}</span>`)
      .join('');

    const permTags = (u.permissions || [])
      .map(p => `<span class="perm-code" style="font-size:9px;padding:2px 5px">${esc(p)}</span>`)
      .join(' ');

    return `
      <tr>
        <td><strong>${esc(u.Username)}</strong></td>
        <td>${esc(u.FirstName || '—')}</td>
        <td>${esc(u.LastName  || '—')}</td>
        <td>${esc(u.Email)}</td>
        <td><span class="badge badge--${u.Role}">${esc(u.Role)}</span></td>
        <td>${statusBadge}</td>
        <td>${u.LastLogin ? formatDate(u.LastLogin) : '<span style="color:var(--text-muted)">Never</span>'}</td>
        <td><div class="dept-tags">${deptTags || '<span style="color:var(--text-muted);font-size:11px">None</span>'}</div></td>
        <td><div class="dept-tags">${permTags || '<span style="color:var(--text-muted);font-size:11px">None</span>'}</div></td>
        <td style="text-align:center">
          <button class="btn-icon btn-icon--edit" title="Edit user"
            onclick="openEditModal(${u.UserID})">✎</button>
        </td>
      </tr>`;
  }).join('');
}

// ── Search ────────────────────────────────────────────────────────────────────
function setupSearch() {
  document.getElementById('user-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const filtered = allUsers.filter(u =>
      u.Username.toLowerCase().includes(q) ||
      u.Email.toLowerCase().includes(q)
    );
    renderUsersTable(filtered);
  });
}

// ── Edit User Modal ───────────────────────────────────────────────────────────
async function openEditModal(userID) {
  const user = allUsers.find(u => u.UserID === userID);
  if (!user) return;

  editingUserID = userID;
  document.getElementById('edit-username').textContent = user.Username;
  document.getElementById('edit-active').checked       = !!user.IsActive;
  document.getElementById('edit-locked').checked       = !!user.IsLocked;
  document.getElementById('edit-short-timeout').checked = !!user.ShortIdleTimeout;
  document.getElementById('edit-notes').value          = user.Notes || '';

  // Build role dropdown filtered to what this actor can assign
  const roleEl = document.getElementById('edit-role');
  roleEl.innerHTML = buildRoleOptions(user.Role);
  roleEl.value = user.Role;

  updateToggleLabel('edit-active', 'edit-active-label', 'Active',  'Inactive');
  updateToggleLabel('edit-locked', 'edit-locked-label', 'Locked',  'Unlocked');
  updateToggleLabel('edit-short-timeout', 'edit-short-timeout-label', 'Short (5 min)', 'Standard (30 min)');

  document.getElementById('edit-active').onchange = () =>
    updateToggleLabel('edit-active', 'edit-active-label', 'Active', 'Inactive');
  document.getElementById('edit-locked').onchange = () =>
    updateToggleLabel('edit-locked', 'edit-locked-label', 'Locked', 'Unlocked');
  document.getElementById('edit-short-timeout').onchange = () =>
    updateToggleLabel('edit-short-timeout', 'edit-short-timeout-label', 'Short (5 min)', 'Standard (30 min)');

  // Identity section — superadmin only
  const identitySection = document.getElementById('edit-identity-section');
  if (sessionRole === 'superadmin') {
    identitySection.style.display = '';
    document.getElementById('edit-username-input').value = user.Username || '';
    document.getElementById('edit-firstname').value      = user.FirstName || '';
    document.getElementById('edit-lastname').value       = user.LastName  || '';
    document.getElementById('edit-email-input').value    = user.Email     || '';
  } else {
    identitySection.style.display = 'none';
  }

  renderDeptGrid('edit-depts', user.departments || []);

  // Load user permissions and populate the tags + select
  await loadUserPermissionsForModal(userID, user.permissions || []);

  document.getElementById('edit-overlay').classList.add('open');
}

function buildRoleOptions(currentRole) {
  // Admin can only assign up to operator; superadmin can assign anything
  const allRoles = [
    { val: 'operator',   label: 'Operator — standard access' },
    { val: 'admin',      label: 'Admin — user approval &amp; department assignment' },
    { val: 'superadmin', label: 'Superadmin — full access + raw SQL' },
  ];
  const actorLevel = ROLE_LEVEL[sessionRole] ?? 0;
  return allRoles
    .filter(r => sessionRole === 'superadmin' || ROLE_LEVEL[r.val] < actorLevel)
    .map(r => `<option value="${r.val}">${r.label}</option>`)
    .join('');
}

async function loadUserPermissionsForModal(userID, currentPerms) {
  // Populate permission tags
  renderPermTags('edit-perms-tags', currentPerms, userID);

  // Populate "add permission" dropdown with all perms not already assigned
  const selectEl = document.getElementById('edit-perm-select');
  if (!allPermissions.length) {
    try {
      const data = await api('/api/admin/permissions');
      allPermissions = data.permissions || [];
    } catch {
      allPermissions = [];
    }
  }
  const available = allPermissions.filter(p => !currentPerms.includes(p.PermissionCode));
  selectEl.innerHTML = '<option value="">— Grant a permission —</option>' +
    available.map(p => `<option value="${esc(p.PermissionCode)}">${esc(p.PermissionCode)} — ${esc(p.PermissionName)}</option>`).join('');
}

function renderPermTags(containerId, perms, userID) {
  const el = document.getElementById(containerId);
  if (!perms.length) {
    el.innerHTML = '<span class="perm-tag--empty">No permissions assigned</span>';
    return;
  }
  el.innerHTML = perms.map(code => `
    <span class="perm-tag">
      ${esc(code)}
      <button type="button" title="Revoke ${esc(code)}"
        onclick="removeUserPermission(${userID}, '${esc(code)}')">×</button>
    </span>`).join('');
}

function closeEditModal() {
  editingUserID = null;
  document.getElementById('edit-overlay').classList.remove('open');
}

async function saveUser() {
  if (!editingUserID) return;

  const role        = document.getElementById('edit-role').value;
  const isActive    = document.getElementById('edit-active').checked ? 1 : 0;
  const isLocked    = document.getElementById('edit-locked').checked ? 1 : 0;
  const shortIdleTimeout = document.getElementById('edit-short-timeout').checked ? 1 : 0;
  const notes       = document.getElementById('edit-notes').value.trim();
  const departments = getCheckedDepts('edit-depts');

  const payload = { role, isActive, isLocked, shortIdleTimeout, notes, departments };

  // Include identity fields for superadmins
  if (sessionRole === 'superadmin') {
    payload.username   = document.getElementById('edit-username-input').value.trim();
    payload.firstName  = document.getElementById('edit-firstname').value.trim();
    payload.lastName   = document.getElementById('edit-lastname').value.trim();
    payload.email      = document.getElementById('edit-email-input').value.trim();
  }

  try {
    await api('/api/admin/users/' + editingUserID, 'PUT', payload);
    closeEditModal();
    await loadUsers();
    showToast('User updated successfully', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── User Permission Add / Remove ──────────────────────────────────────────────
async function addUserPermission() {
  if (!editingUserID) return;
  const selectEl = document.getElementById('edit-perm-select');
  const code = selectEl.value;
  if (!code) return;

  try {
    await api('/api/admin/users/' + editingUserID + '/permissions', 'POST', { permissionCode: code });

    // Update local state
    const user = allUsers.find(u => u.UserID === editingUserID);
    if (user) {
      if (!user.permissions) user.permissions = [];
      user.permissions.push(code);
      await loadUserPermissionsForModal(editingUserID, user.permissions);
    }
    showToast(`Permission ${code} granted`, 'success');
  } catch (err) {
    showToast('Grant failed: ' + err.message, 'error');
  }
}

async function removeUserPermission(userID, code) {
  try {
    await api(`/api/admin/users/${userID}/permissions/${encodeURIComponent(code)}`, 'DELETE');

    const user = allUsers.find(u => u.UserID === userID);
    if (user) {
      user.permissions = (user.permissions || []).filter(p => p !== code);
      await loadUserPermissionsForModal(userID, user.permissions);
    }
    showToast(`Permission ${code} revoked`, 'success');
  } catch (err) {
    showToast('Revoke failed: ' + err.message, 'error');
  }
}

// ── Approve Modal ─────────────────────────────────────────────────────────────
function openApproveModal(userID, username, email) {
  approvingUserID = userID;
  document.getElementById('approve-info').innerHTML =
    `<strong>${esc(username)}</strong><br>${esc(email)}`;

  // Build approve role dropdown
  const roleEl = document.getElementById('approve-role');
  roleEl.innerHTML = buildApproveRoleOptions();
  roleEl.value = 'operator';

  renderDeptGrid('approve-depts', []);
  document.getElementById('approve-overlay').classList.add('open');
}

function buildApproveRoleOptions() {
  const actorLevel = ROLE_LEVEL[sessionRole] ?? 0;
  const opts = [{ val: 'operator', label: 'Operator' }];
  if (actorLevel >= ROLE_LEVEL.admin) opts.push({ val: 'admin', label: 'Admin' });
  return opts.map(o => `<option value="${o.val}">${o.label}</option>`).join('');
}

function closeApproveModal() {
  approvingUserID = null;
  document.getElementById('approve-overlay').classList.remove('open');
}

async function approveUser() {
  if (!approvingUserID) return;

  const role        = document.getElementById('approve-role').value;
  const departments = getCheckedDepts('approve-depts');

  try {
    await api('/api/admin/users/' + approvingUserID + '/approve', 'POST', {
      role, departments,
    });
    closeApproveModal();
    await Promise.all([loadPending(), loadUsers()]);
    showToast('User approved and activated', 'success');
  } catch (err) {
    showToast('Approval failed: ' + err.message, 'error');
  }
}

async function rejectUser() {
  if (!approvingUserID) return;
  if (!confirm('Are you sure you want to reject and delete this registration request?')) return;

  try {
    await api('/api/admin/users/' + approvingUserID + '/reject', 'POST');
    closeApproveModal();
    await loadPending();
    showToast('Registration request rejected', 'error');
  } catch (err) {
    showToast('Rejection failed: ' + err.message, 'error');
  }
}

// ── Audit Log ─────────────────────────────────────────────────────────────────
let allAuditLoaded = false;

async function loadAudit() {
  const tbody  = document.getElementById('audit-tbody');
  const filter = document.getElementById('audit-filter').value;
  tbody.innerHTML = '<tr><td colspan="5" class="loading-cell"><div class="spinner"></div> Loading…</td></tr>';

  try {
    const url  = '/api/admin/audit' + (filter ? '?event=' + encodeURIComponent(filter) : '');
    const data = await api(url);
    allAuditLoaded = true;

    if (!data.rows || data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">No audit records found</td></tr>';
      return;
    }

    tbody.innerHTML = data.rows.map(r => `
      <tr>
        <td>${formatDateTime(r.EventTime)}</td>
        <td>${r.Username ? esc(r.Username) : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td><span class="event-badge event--${esc(r.EventType)}">${esc(r.EventType)}</span></td>
        <td>${r.Detail ? esc(r.Detail) : '—'}</td>
        <td><span style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.IPAddress ? esc(r.IPAddress) : '—'}</span></td>
      </tr>`).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">✕ ${esc(err.message)}</td></tr>`;
  }
}

document.getElementById('audit-filter')?.addEventListener('change', () => {
  if (allAuditLoaded) loadAudit();
});

// ── Permission Definitions (superadmin only) ──────────────────────────────────
let allPermissionsLoaded = false;

async function loadPermissions() {
  const tbody = document.getElementById('perms-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="loading-cell"><div class="spinner"></div> Loading…</td></tr>';

  try {
    const data   = await api('/api/admin/permissions');
    allPermissions = data.permissions || [];
    allPermissionsLoaded = true;
    renderPermissionsTable(allPermissions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">✕ ${esc(err.message)}</td></tr>`;
  }
}

function renderPermissionsTable(perms) {
  const tbody = document.getElementById('perms-tbody');

  if (!perms.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">No permissions defined yet</td></tr>';
    return;
  }

  tbody.innerHTML = perms.map(p => `
    <tr>
      <td><span class="perm-code">${esc(p.PermissionCode)}</span></td>
      <td>${esc(p.PermissionName)}</td>
      <td><span class="badge badge--operator" style="font-size:9px">${esc(p.Category)}</span></td>
      <td style="color:var(--text-dim)">${p.Description ? esc(p.Description) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="text-align:center">
        <button class="btn-icon btn-icon--edit" title="Edit" style="margin-right:4px"
          onclick="openEditPermModal('${esc(p.PermissionCode)}')">✎</button>
        <button class="btn-icon btn-icon--delete" title="Delete"
          onclick="confirmDeletePermission('${esc(p.PermissionCode)}')">✕</button>
      </td>
    </tr>`).join('');
}

function openCreatePermModal() {
  permEditingCode = null;
  document.getElementById('perm-modal-title').textContent = 'New Permission';
  document.getElementById('perm-code-input').value       = '';
  document.getElementById('perm-code-input').disabled    = false;
  document.getElementById('perm-code-hint').style.display = '';
  document.getElementById('perm-name-input').value        = '';
  document.getElementById('perm-category-input').value    = '';
  document.getElementById('perm-description-input').value = '';
  document.getElementById('perm-overlay').classList.add('open');
}

function openEditPermModal(code) {
  const perm = allPermissions.find(p => p.PermissionCode === code);
  if (!perm) return;

  permEditingCode = code;
  document.getElementById('perm-modal-title').textContent = 'Edit Permission';
  document.getElementById('perm-code-input').value        = perm.PermissionCode;
  document.getElementById('perm-code-input').disabled     = true;
  document.getElementById('perm-code-hint').style.display = 'none';
  document.getElementById('perm-name-input').value        = perm.PermissionName;
  document.getElementById('perm-category-input').value    = perm.Category;
  document.getElementById('perm-description-input').value = perm.Description || '';
  document.getElementById('perm-overlay').classList.add('open');
}

function closePermModal() {
  permEditingCode = null;
  document.getElementById('perm-overlay').classList.remove('open');
}

async function savePermission() {
  const code        = document.getElementById('perm-code-input').value.trim().toUpperCase();
  const name        = document.getElementById('perm-name-input').value.trim();
  const category    = document.getElementById('perm-category-input').value.trim();
  const description = document.getElementById('perm-description-input').value.trim();

  if (!name || !category) {
    showToast('Display name and category are required', 'error');
    return;
  }

  try {
    if (permEditingCode) {
      await api(`/api/admin/permissions/${encodeURIComponent(permEditingCode)}`, 'PUT', {
        permissionName: name, description, category,
      });
    } else {
      if (!code) { showToast('Permission code is required', 'error'); return; }
      await api('/api/admin/permissions', 'POST', {
        permissionCode: code, permissionName: name, description, category,
      });
    }

    closePermModal();
    allPermissionsLoaded = false;
    allPermissions = [];
    await loadPermissions();
    showToast(permEditingCode ? 'Permission updated' : 'Permission created', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function confirmDeletePermission(code) {
  if (!confirm(`Delete permission "${code}"?\n\nThis will also remove it from all users who currently hold it.`)) return;

  try {
    await api(`/api/admin/permissions/${encodeURIComponent(code)}`, 'DELETE');
    allPermissionsLoaded = false;
    allPermissions = [];
    await loadPermissions();
    showToast(`Permission ${code} deleted`, 'success');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Bulk Create Users (superadmin only) ───────────────────────────────────────
// Client-side CSV parsing (tab- or comma-delimited — a straight paste from
// Excel into a .csv is tab-delimited) into the row shape expected by
// routes/useradmin.js's POST /users/bulk-create. Real gating is server-side
// (requireSuperadmin on that route); the nav item is hidden client-side too
// (see applyRoleVisibility) purely for UX.
let bulkCreateSetup = false;
let bulkParsedRows  = []; // canonical rows, same order as the preview table

const BULK_HEADER_MAP = {
  level: 'role', role: 'role',
  approved: 'approved',
  unlocked: 'unlocked',
  permission: 'permissionCode', permissioncode: 'permissionCode',
  firstname: 'firstName',
  lastname: 'lastName',
  username: 'username',
  email: 'email',
  password: 'password',
};

function setupBulkCreate() {
  if (bulkCreateSetup) return;
  bulkCreateSetup = true;

  const deptSelect = document.getElementById('bulk-department');
  deptSelect.innerHTML = '<option value="">— No department —</option>' +
    DEPARTMENTS.map(d => `<option value="${d}">${DEPT_LABELS[d]}</option>`).join('');

  document.getElementById('bulk-csv-input').addEventListener('change', handleBulkCsvSelected);
  document.getElementById('bulk-create-btn').addEventListener('click', submitBulkCreate);
}

function bulkParseYN(v) {
  return ['y', 'yes', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());
}

function parseDelimited(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  // Pick whichever candidate splits the header row into the most fields —
  // handles a straight paste from Excel (tab-delimited), a plain CSV
  // (comma), and Excel's "Save As CSV" output on European-locale systems
  // (semicolon, since comma is the decimal separator there).
  const delim = [';', '\t', ','].reduce((best, d) =>
    lines[0].split(d).length > lines[0].split(best).length ? d : best
  );
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^﻿/, ''));
  const rows = lines.slice(1).map(line => {
    const cells = line.split(delim);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function handleBulkCsvSelected(e) {
  const file       = e.target.files[0];
  const summaryEl  = document.getElementById('bulk-parse-summary');
  const btn        = document.getElementById('bulk-create-btn');
  document.getElementById('bulk-create-result').textContent = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const { headers, rows: rawRows } = parseDelimited(String(reader.result));

    // Map each raw header to a canonical field name, case-insensitively
    const fieldByHeader = {};
    headers.forEach(h => {
      const key = h.toLowerCase().replace(/[^a-z]/g, '');
      if (BULK_HEADER_MAP[key]) fieldByHeader[h] = BULK_HEADER_MAP[key];
    });

    bulkParsedRows = rawRows.map(raw => {
      const row = {};
      for (const [header, field] of Object.entries(fieldByHeader)) {
        row[field] = raw[header] ?? '';
      }
      return {
        role:           (row.role || 'operator').trim().toLowerCase(),
        approved:       row.approved === undefined ? true : bulkParseYN(row.approved),
        unlocked:       row.unlocked === undefined ? true : bulkParseYN(row.unlocked),
        permissionCode: (row.permissionCode || '').trim().toUpperCase() || null,
        firstName:      (row.firstName || '').trim(),
        lastName:       (row.lastName || '').trim(),
        username:       (row.username || '').trim(),
        email:          (row.email || '').trim().toLowerCase(),
        password:       row.password || '',
      };
    });

    if (!bulkParsedRows.length) {
      summaryEl.style.color = 'var(--error)';
      summaryEl.textContent = 'No rows found in that file.';
      btn.disabled = true;
      renderBulkPreview();
      return;
    }

    summaryEl.style.color = 'var(--text-dim)';
    summaryEl.textContent = `Parsed ${bulkParsedRows.length} row(s). Review below, then click Create Users.`;
    btn.disabled = false;
    renderBulkPreview();
  };
  reader.onerror = () => {
    summaryEl.style.color = 'var(--error)';
    summaryEl.textContent = 'Failed to read that file.';
  };
  reader.readAsText(file);
}

function renderBulkPreview(results) {
  const tbody = document.getElementById('bulk-preview-tbody');
  if (!bulkParsedRows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="loading-cell">Choose a CSV file to preview its rows.</td></tr>';
    return;
  }

  tbody.innerHTML = bulkParsedRows.map((r, i) => {
    const result = results && results[i];
    const status = result
      ? (result.success
          ? '<span class="badge badge--active">Created</span>'
          : `<span class="badge badge--locked" title="${esc(result.error || '')}">${esc(result.error || 'Failed')}</span>`)
      : '<span style="color:var(--text-muted)">Pending</span>';
    return `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${esc(r.username)}</strong></td>
        <td>${esc(r.email)}</td>
        <td>${esc(r.firstName)} ${esc(r.lastName)}</td>
        <td><span class="badge badge--${esc(r.role)}">${esc(r.role)}</span></td>
        <td>${r.approved ? 'Y' : 'N'}</td>
        <td>${r.unlocked ? 'Y' : 'N'}</td>
        <td>${r.permissionCode ? esc(r.permissionCode) : '—'}</td>
        <td>${status}</td>
      </tr>`;
  }).join('');
}

async function submitBulkCreate() {
  if (!bulkParsedRows.length) return;

  const department = document.getElementById('bulk-department').value || null;
  const btn         = document.getElementById('bulk-create-btn');
  const resultEl     = document.getElementById('bulk-create-result');

  if (!confirm(`Create ${bulkParsedRows.length} user account(s)? Each will be forced to change its password on first login.`)) return;

  btn.disabled = true;
  btn.textContent = 'Creating…';
  resultEl.textContent = '';

  const rows = bulkParsedRows.map(r => ({
    role: r.role, approved: r.approved, unlocked: r.unlocked,
    permissionCode: r.permissionCode, firstName: r.firstName, lastName: r.lastName,
    username: r.username, email: r.email, password: r.password,
  }));

  try {
    const data = await api('/api/admin/users/bulk-create', 'POST', { department, rows });
    renderBulkPreview(data.results);
    const { succeeded, failed } = data.summary;
    resultEl.style.color = failed ? 'var(--error)' : 'var(--accent)';
    resultEl.textContent = `✓ Created ${succeeded} user(s)` + (failed ? `, ${failed} failed — see Status column.` : '.');
    showToast(`Bulk create: ${succeeded} created, ${failed} failed`, failed ? 'error' : 'success');
    await loadUsers();
  } catch (err) {
    resultEl.style.color = 'var(--error)';
    resultEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Users';
  }
}

// ── Mass Apply Permissions ─────────────────────────────────────────────────────
// Admin or superadmin (routes/useradmin.js's POST /users/bulk-permissions has
// no requireSuperadmin gate, same as the single-user grant endpoint it
// reuses). Built on the already-loaded allUsers/allPermissions arrays rather
// than fetching its own copies.
let massPermSetup = false;
let massPermSelectedUserIDs = new Set();

function setupMassPermissions() {
  if (massPermSetup) return;
  massPermSetup = true;

  document.getElementById('mass-perm-search').addEventListener('input', () => renderMassPermUsersTable());
  document.getElementById('mass-perm-select-all').addEventListener('change', e => {
    massPermVisibleUsers().forEach(u => {
      if (e.target.checked) massPermSelectedUserIDs.add(u.UserID);
      else massPermSelectedUserIDs.delete(u.UserID);
    });
    renderMassPermUsersTable();
  });
  document.getElementById('mass-perm-apply-btn').addEventListener('click', submitMassPermissions);

  loadMassPermPermissions();
  renderMassPermUsersTable();
}

async function loadMassPermPermissions() {
  if (!allPermissions.length) {
    try {
      const data = await api('/api/admin/permissions');
      allPermissions = data.permissions || [];
    } catch {
      allPermissions = [];
    }
  }
  renderMassPermCodesGrid();
}

function renderMassPermCodesGrid() {
  const el = document.getElementById('mass-perm-codes');
  if (!allPermissions.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No permissions defined yet.</div>';
    return;
  }
  el.innerHTML = allPermissions.map(p => `
    <label class="dept-check" data-code="${esc(p.PermissionCode)}">
      <input type="checkbox">
      <span class="dept-check-name">${esc(p.PermissionCode)} <span style="color:var(--text-muted);font-weight:400">— ${esc(p.PermissionName)}</span></span>
      <span class="dept-check-tick">✓</span>
    </label>`).join('');

  el.querySelectorAll('.dept-check').forEach(label => {
    label.addEventListener('click', () => {
      const cb = label.querySelector('input');
      cb.checked = !cb.checked;
      label.classList.toggle('checked', cb.checked);
      updateMassPermSummary();
    });
  });
}

function getMassPermCheckedCodes() {
  return [...document.querySelectorAll('#mass-perm-codes .dept-check.checked')].map(el => el.dataset.code);
}

function massPermVisibleUsers() {
  const q = document.getElementById('mass-perm-search').value.trim().toLowerCase();
  if (!q) return allUsers;
  return allUsers.filter(u => u.Username.toLowerCase().includes(q) || u.Email.toLowerCase().includes(q));
}

function renderMassPermUsersTable() {
  const tbody = document.getElementById('mass-perm-users-tbody');
  const users = massPermVisibleUsers();

  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">No users found</td></tr>';
    updateMassPermSummary();
    return;
  }

  tbody.innerHTML = users.map(u => {
    const checked = massPermSelectedUserIDs.has(u.UserID);
    const permTags = (u.permissions || [])
      .map(p => `<span class="perm-code" style="font-size:9px;padding:2px 5px">${esc(p)}</span>`)
      .join(' ');
    return `
      <tr>
        <td><input type="checkbox" class="mass-perm-user-check" data-user-id="${u.UserID}" ${checked ? 'checked' : ''} aria-label="Select ${esc(u.Username)}"></td>
        <td><strong>${esc(u.Username)}</strong></td>
        <td>${esc(u.FirstName || '—')} ${esc(u.LastName || '')}</td>
        <td>${esc(u.Email)}</td>
        <td><span class="badge badge--${esc(u.Role)}">${esc(u.Role)}</span></td>
        <td><div class="dept-tags">${permTags || '<span style="color:var(--text-muted);font-size:11px">None</span>'}</div></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.mass-perm-user-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.userId);
      if (cb.checked) massPermSelectedUserIDs.add(id);
      else massPermSelectedUserIDs.delete(id);
      updateMassPermSummary();
    });
  });

  // Reflect current selection state onto the header "select all" checkbox
  const selectAll = document.getElementById('mass-perm-select-all');
  selectAll.checked = users.length > 0 && users.every(u => massPermSelectedUserIDs.has(u.UserID));

  updateMassPermSummary();
}

function updateMassPermSummary() {
  const summaryEl = document.getElementById('mass-perm-summary');
  const btn       = document.getElementById('mass-perm-apply-btn');
  const userCount = massPermSelectedUserIDs.size;
  const codeCount = getMassPermCheckedCodes().length;
  summaryEl.textContent = `${userCount} user${userCount !== 1 ? 's' : ''} selected, ${codeCount} permission${codeCount !== 1 ? 's' : ''} chosen`;
  btn.disabled = userCount === 0 || codeCount === 0;
}

async function submitMassPermissions() {
  const userIDs         = [...massPermSelectedUserIDs];
  const permissionCodes = getMassPermCheckedCodes();
  if (!userIDs.length || !permissionCodes.length) return;

  if (!confirm(`Grant ${permissionCodes.join(', ')} to ${userIDs.length} user(s)?`)) return;

  const btn      = document.getElementById('mass-perm-apply-btn');
  const resultEl = document.getElementById('mass-perm-result');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  resultEl.textContent = '';

  try {
    const data = await api('/api/admin/users/bulk-permissions', 'POST', { userIDs, permissionCodes });
    const { granted, alreadyHad, failed } = data.summary;

    resultEl.style.color = failed ? 'var(--error)' : 'var(--accent)';
    resultEl.textContent = `✓ ${granted} new grant(s), ${alreadyHad} already held` + (failed ? `, ${failed} user(s) not found.` : '.');
    showToast(`Mass apply: ${granted} new grant(s)`, failed ? 'error' : 'success');

    // Refresh from the server so both this table and the main Users table
    // reflect the grant with authoritative data, rather than patching the
    // local cache by hand.
    await loadUsers();
    renderMassPermUsersTable();
  } catch (err) {
    resultEl.style.color = 'var(--error)';
    resultEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply to Selected Users';
  }
}

// ── Department Grid Helper ────────────────────────────────────────────────────
function renderDeptGrid(containerId, checked) {
  const el = document.getElementById(containerId);
  el.innerHTML = DEPARTMENTS.map(dept => `
    <label class="dept-check ${checked.includes(dept) ? 'checked' : ''}" data-dept="${dept}">
      <input type="checkbox" ${checked.includes(dept) ? 'checked' : ''}>
      <span class="dept-check-name">${DEPT_LABELS[dept]}</span>
      <span class="dept-check-tick">✓</span>
    </label>`).join('');

  el.querySelectorAll('.dept-check').forEach(label => {
    label.addEventListener('click', () => {
      const cb = label.querySelector('input');
      cb.checked = !cb.checked;
      label.classList.toggle('checked', cb.checked);
    });
  });
}

function getCheckedDepts(containerId) {
  return [...document.querySelectorAll(`#${containerId} .dept-check.checked`)]
    .map(el => el.dataset.dept);
}

// ── Toggle Label Helper ───────────────────────────────────────────────────────
function updateToggleLabel(checkboxId, labelId, trueText, falseText) {
  const checked = document.getElementById(checkboxId).checked;
  document.getElementById(labelId).textContent = checked ? trueText : falseText;
}

// ── API Helper ────────────────────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok || data.success === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ── Toast Notification ────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position: fixed; bottom: 28px; right: 28px; z-index: 9999;
    padding: 12px 20px; border-radius: 8px; font-family: 'Manrope', sans-serif;
    font-size: 13px; font-weight: 600; color: #fff;
    box-shadow: 0 4px 16px rgba(30,45,69,0.2);
    animation: fadeUp 0.25s ease;
    background: ${type === 'success' ? '#059669' : type === 'error' ? '#DC2626' : '#2563EB'};
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatDateTime(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── SQL Console ───────────────────────────────────────────────────────────────
// One entry per SELECT statement in the last-run batch — exportSqlCsv(index)
// reads whichever one the user clicked "Export" next to.
let sqlLastRecordsets = [];

function buildSqlTable(rows) {
  const cols = Object.keys(rows[0]);
  let h = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach(c => { h += `<th>${esc(c)}</th>`; });
  h += '</tr></thead><tbody>';
  rows.forEach(row => {
    h += '<tr>';
    cols.forEach(c => { h += `<td>${esc(String(row[c] ?? ''))}</td>`; });
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  return h;
}

// Renders every non-empty recordset from a (possibly multi-statement) batch
// as its own labelled section, reusing buildSqlTable() per result — a query
// with several SELECTs separated by semicolons comes back as one entry per
// SELECT, in order.
function buildSqlResultsHTML(recordsets) {
  const nonEmpty = recordsets
    .map((rows, i) => ({ rows, i }))
    .filter(r => r.rows && r.rows.length > 0);

  if (!nonEmpty.length) return '';

  const multi = nonEmpty.length > 1;
  let h = '';
  nonEmpty.forEach(({ rows, i }) => {
    h += '<div class="sql-result-block">';
    if (multi) {
      h += `<div class="sql-result-heading">`
        + `<span>Result ${i + 1} — ${rows.length} row(s)</span>`
        + `<button type="button" class="btn-secondary" data-sql-export-index="${i}">Export CSV</button>`
        + `</div>`;
    }
    h += buildSqlTable(rows);
    h += '</div>';
  });
  return h;
}

function exportSqlCsv(index) {
  const rows = index == null ? sqlLastRecordsets.find(r => r && r.length) : sqlLastRecordsets[index];
  if (!rows || !rows.length) return;
  const cols  = Object.keys(rows[0]);
  const lines = [
    cols.map(c  => `"${String(c).replace(/"/g, '""')}"`).join(','),
    ...rows.map(row =>
      cols.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const suffix = sqlLastRecordsets.filter(r => r && r.length).length > 1 && index != null ? `-result${index + 1}` : '';
  a.download = `sql${suffix}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function runSql() {
  const inputEl   = document.getElementById('sql-input');
  const resultEl  = document.getElementById('sql-result');
  const countEl   = document.getElementById('sql-row-count');
  const exportBtn = document.getElementById('sql-export');
  if (!inputEl || !resultEl) return;

  const query = inputEl.value.trim();
  if (!query) return;

  sqlLastRecordsets = [];
  if (countEl)   { countEl.textContent = ''; countEl.style.display = 'none'; }
  if (exportBtn) exportBtn.style.display = 'none';
  resultEl.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Running…</div>';

  try {
    const res  = await fetch('/sql/query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.success === false) {
      resultEl.innerHTML = `<div class="empty-state error-state">✕ ${esc((data && data.error) || `HTTP ${res.status}`)}</div>`;
      return;
    }

    // recordsets covers every SELECT in the batch, in order; recordset
    // (older shape, still sent for back-compat) is just recordsets[0].
    const recordsets = Array.isArray(data.recordsets) && data.recordsets.length
      ? data.recordsets
      : [data.recordset || []];
    sqlLastRecordsets = recordsets;

    const nonEmptyCount = recordsets.filter(r => r && r.length > 0).length;
    if (nonEmptyCount > 0) {
      resultEl.innerHTML = buildSqlResultsHTML(recordsets);
      const totalRows = recordsets.reduce((sum, r) => sum + (r ? r.length : 0), 0);
      if (nonEmptyCount === 1) {
        // Single result: keep the original single-table UX — the toolbar's
        // own Export button drives the one table directly.
        if (countEl)   { countEl.textContent = `${totalRows} row(s)`; countEl.style.display = ''; }
        if (exportBtn) { exportBtn.style.display = ''; exportBtn.onclick = () => exportSqlCsv(recordsets.findIndex(r => r && r.length)); }
      } else {
        // Multiple results: each block has its own Export button (wired via
        // delegation in setupSqlConsole) — the toolbar-level one doesn't map
        // to a single table, so hide it rather than silently export the wrong one.
        if (countEl)   { countEl.textContent = `${nonEmptyCount} result sets, ${totalRows} row(s) total`; countEl.style.display = ''; }
        if (exportBtn) exportBtn.style.display = 'none';
      }
    } else {
      const affected = Array.isArray(data.rowsAffected)
        ? data.rowsAffected.reduce((s, v) => s + (v || 0), 0)
        : (data.rowsAffected || 0);
      resultEl.innerHTML = `<div class="empty-state">Query OK — ${affected} row(s) affected.</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="empty-state error-state">✕ ${esc(err.message)}</div>`;
  }
}

function setupSqlConsole() {
  const inputEl   = document.getElementById('sql-input');
  const runBtn    = document.getElementById('sql-run');
  const clearBtn  = document.getElementById('sql-clear');
  const exportBtn = document.getElementById('sql-export');
  const resultEl  = document.getElementById('sql-result');

  if (inputEl) {
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); }
    });
  }
  if (runBtn) runBtn.addEventListener('click', runSql);
  // exportBtn's click handler is (re)assigned per run in runSql() for the
  // single-result case, since which recordset it should export changes each
  // time. Per-result-block export buttons (multi-result case) are handled
  // here via delegation, since they're recreated on every run.
  if (resultEl) {
    resultEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-sql-export-index]');
      if (btn) exportSqlCsv(Number(btn.dataset.sqlExportIndex));
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (inputEl) inputEl.value = '';
      sqlLastRecordsets = [];
      const countEl   = document.getElementById('sql-row-count');
      const exportBtn2 = document.getElementById('sql-export');
      if (resultEl)   resultEl.innerHTML = '<div class="empty-state">No query executed yet.</div>';
      if (countEl)    countEl.style.display = 'none';
      if (exportBtn2) exportBtn2.style.display = 'none';
    });
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

const SEV_LABELS = { 1: 'Info', 2: 'Warning', 3: 'Critical' };
const SEV_COLOURS = { 1: 'var(--accent,#3b82f6)', 2: '#D97706', 3: '#DC2626' };
let notifTargetDataLoaded = false;

async function loadNotifHistory() {
  const wrap = document.getElementById('notif-history-wrap');
  wrap.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Loading…</div>';
  try {
    const data = await api('/api/notifications/admin');
    if (!data.success) throw new Error(data.error);
    const rows = data.data || [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty-state">No notifications sent yet.</div>';
      return;
    }

    const tbody = rows.map(n => {
      const pct = n.TotalSent > 0 ? Math.round((n.TotalRead / n.TotalSent) * 100) : 0;
      const sev = `<span style="display:inline-flex;align-items:center;gap:5px">
        <span style="width:8px;height:8px;border-radius:50%;background:${SEV_COLOURS[n.Severity] || '#888'};flex-shrink:0"></span>
        ${esc(SEV_LABELS[n.Severity] || n.Severity)}
      </span>`;
      const target = n.TargetType === 'all'
        ? 'All users'
        : `${n.TargetType}: ${n.TargetValue || '—'}`;
      const expire = n.ExpiresAt ? fmtDate(n.ExpiresAt) : '—';
      return `<tr>
        <td style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--text-dim);white-space:nowrap">${fmtDate(n.CreatedAt)}</td>
        <td><strong style="font-size:13px">${esc(n.Title)}</strong>${n.Category ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(n.Category)}</span>` : ''}</td>
        <td>${sev}</td>
        <td style="font-size:12px;color:var(--text-dim)">${esc(target)}</td>
        <td style="font-size:13px;text-align:center">${n.TotalSent}</td>
        <td style="font-size:13px;text-align:center">${n.TotalRead} <span style="font-size:11px;color:var(--text-muted)">(${pct}%)</span></td>
        <td style="font-size:12px;color:var(--text-dim)">${expire}</td>
        <td>
          <button class="btn-secondary notif-expire-btn" data-id="${n.NotificationID}"
            style="font-size:11.5px;padding:4px 10px;color:#DC2626;border-color:rgba(220,38,38,0.3)"
            ${n.ExpiresAt && new Date(n.ExpiresAt) < new Date() ? 'disabled title="Already expired"' : ''}>
            Expire
          </button>
        </td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `<div class="nh-table-wrap">
      <table class="nh-table">
        <thead><tr>
          <th>Sent</th><th>Title</th><th>Severity</th><th>Target</th>
          <th style="text-align:center">Sent To</th><th style="text-align:center">Read</th>
          <th>Expires</th><th></th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

    wrap.querySelectorAll('.notif-expire-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Expire this notification immediately? It will disappear from all trays.')) return;
        btn.disabled = true; btn.textContent = '…';
        try {
          const r = await api(`/api/notifications/admin/${btn.dataset.id}`, 'DELETE');
          if (!r.success) throw new Error(r.error);
          loadNotifHistory();
        } catch (err) { btn.disabled = false; btn.textContent = 'Expire'; alert(err.message); }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state" style="color:var(--error)">${esc(err.message)}</div>`;
  }
}

async function setupNotifSend() {
  if (notifTargetDataLoaded) return;
  notifTargetDataLoaded = true;

  // Load departments + permissions for dropdowns
  try {
    const data = await api('/api/notifications/admin/targets');
    if (data.success) {
      const { departments, permissions } = data.data;

      const deptOpts = departments.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      const permOpts = permissions.map(p => `<option value="${esc(p.PermissionCode)}">${esc(p.PermissionName)} (${esc(p.PermissionCode)})</option>`).join('');

      document.getElementById('notif-target-type').addEventListener('change', function () {
        const tv     = document.getElementById('notif-target-value');
        const ts     = document.getElementById('notif-target-select');
        const tLabel = document.querySelector('#notif-target-value-wrap label');

        tv.style.display = 'none'; ts.style.display = 'none'; tv.value = ''; ts.innerHTML = '';

        switch (this.value) {
          case 'all':
            tLabel.textContent = '—';
            break;
          case 'role':
            ts.innerHTML = '<option value="operator">Operator</option><option value="admin">Admin</option><option value="superadmin">Superadmin</option>';
            ts.style.display = ''; tLabel.textContent = 'Role';
            break;
          case 'department':
            ts.innerHTML = deptOpts;
            ts.style.display = ''; tLabel.textContent = 'Department';
            break;
          case 'permission':
            ts.innerHTML = permOpts;
            ts.style.display = ''; tLabel.textContent = 'Permission';
            break;
          case 'user':
            tv.placeholder = 'Username'; tv.style.display = ''; tLabel.textContent = 'Username';
            break;
        }
      });
    }
  } catch (_) {}

  document.getElementById('notif-refresh-btn').addEventListener('click', loadNotifHistory);

  document.getElementById('notif-send-btn').addEventListener('click', async () => {
    const btn    = document.getElementById('notif-send-btn');
    const result = document.getElementById('notif-send-result');
    const type   = document.getElementById('notif-target-type').value;
    const tv     = document.getElementById('notif-target-value');
    const ts     = document.getElementById('notif-target-select');
    const value  = type === 'all' ? null : (tv.style.display !== 'none' ? tv.value.trim() : ts.value);

    const body = {
      title:       document.getElementById('notif-title').value.trim(),
      body:        document.getElementById('notif-body').value.trim(),
      severity:    Number(document.getElementById('notif-severity').value),
      category:    document.getElementById('notif-category').value.trim() || null,
      actionLabel: document.getElementById('notif-action-label').value.trim() || null,
      actionURL:   document.getElementById('notif-action-url').value.trim()   || null,
      expiresAt:   document.getElementById('notif-expires').value             || null,
      target:      { type, value },
    };

    if (!body.title || !body.body) {
      result.style.color = 'var(--error)'; result.textContent = 'Title and message body are required.'; return;
    }
    if (type !== 'all' && !value) {
      result.style.color = 'var(--error)'; result.textContent = 'Select or enter a target value.'; return;
    }

    btn.disabled = true; btn.textContent = 'Sending…'; result.textContent = '';
    try {
      const r = await api('/api/notifications/admin', 'POST', body);
      if (!r.success) throw new Error(r.error);
      result.style.color = 'var(--accent)';
      result.textContent = `✓ Sent to ${r.data.recipients} recipient${r.data.recipients !== 1 ? 's' : ''}`;
      // Reset form
      ['notif-title','notif-body','notif-category','notif-action-label','notif-action-url','notif-expires'].forEach(id => {
        document.getElementById(id).value = '';
      });
      loadNotifHistory();
    } catch (err) {
      result.style.color = 'var(--error)'; result.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Send Notification';
    }
  });
}

// ── Scheduled Deployments (superadmin only) ──────────────────────────────────
let deploySectionSetup = false;

async function loadDeployments() {
  const tbody = document.getElementById('deploy-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="loading-cell"><div class="spinner"></div> Loading…</td></tr>';
  try {
    const data = await api('/api/deploy');
    renderDeployments(data.deployments || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">✕ ${esc(err.message)}</td></tr>`;
  }
}

function renderDeployments(rows) {
  const tbody = document.getElementById('deploy-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">No deployments scheduled yet</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(d => {
    const result = d.Status === 'failed'
      ? `<span style="color:var(--error)">${esc((d.ErrorMessage || '').slice(0, 120))}</span>`
      : d.Status === 'completed'
        ? '<span style="color:var(--success)">OK</span>'
        : '—';

    const cancelBtn = d.Status === 'pending'
      ? `<button class="btn-icon btn-icon--delete" title="Cancel" onclick="cancelDeployment(${d.DeploymentID})">✕</button>`
      : '';

    return `
      <tr>
        <td>${formatDateTime(d.ScheduledAt)}</td>
        <td><span style="font-family:'JetBrains Mono',monospace">${esc(d.GitRef)}</span></td>
        <td><span class="badge dep-status--${esc(d.Status)}">${esc(d.Status)}</span></td>
        <td style="max-width:260px">${d.Notes ? esc(d.Notes) : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td>${esc(d.CreatedByUsername || '—')}</td>
        <td style="max-width:220px;font-size:11px">${result}</td>
        <td style="text-align:center">${cancelBtn}</td>
      </tr>`;
  }).join('');
}

async function scheduleDeployment() {
  const btn    = document.getElementById('deploy-schedule-btn');
  const result = document.getElementById('deploy-schedule-result');
  const whenEl = document.getElementById('deploy-when');

  const scheduledAt    = whenEl.value;
  const gitRef          = document.getElementById('deploy-branch').value.trim() || 'main';
  const warningMinutes  = document.getElementById('deploy-warning').value;
  const notes           = document.getElementById('deploy-notes').value.trim();

  if (!scheduledAt) {
    result.style.color = 'var(--error)'; result.textContent = 'Pick a date and time.'; return;
  }

  btn.disabled = true; btn.textContent = 'Scheduling…'; result.textContent = '';
  try {
    await api('/api/deploy', 'POST', {
      // Sent as the raw "YYYY-MM-DDTHH:mm" value straight from the datetime-
      // local input — NOT converted via toISOString(), which would shift it to
      // UTC and cause it to trigger at the wrong local time server-side (SQL
      // Server's GETDATE(), which the cron checker compares against, has no
      // timezone concept and just returns the server's local wall-clock time).
      scheduledAt,
      gitRef, warningMinutes: Number(warningMinutes) || 15, notes: notes || null,
    });
    result.style.color = 'var(--accent)';
    result.textContent = '✓ Deployment scheduled';
    whenEl.value = '';
    document.getElementById('deploy-notes').value = '';
    await loadDeployments();
  } catch (err) {
    result.style.color = 'var(--error)';
    result.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Schedule Deployment';
  }
}

async function cancelDeployment(id) {
  if (!confirm('Cancel this scheduled deployment?')) return;
  try {
    await api(`/api/deploy/${id}/cancel`, 'POST');
    showToast('Deployment cancelled', 'success');
    await loadDeployments();
  } catch (err) {
    showToast('Cancel failed: ' + err.message, 'error');
  }
}

function setupDeploySection() {
  if (deploySectionSetup) return;
  deploySectionSetup = true;
  document.getElementById('deploy-schedule-btn').addEventListener('click', scheduleDeployment);
  document.getElementById('deploy-refresh-btn').addEventListener('click', loadDeployments);
  loadDeployments();
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── DB Explorer ────────────────────────────────────────────────────────────
// SSMS-lite schema/data browser: Databases -> Tables -> Columns / Keys &
// Constraints / Preview Data. All calls go to routes/dbexplorer.js, which is
// gated superadmin-only server-side regardless of what's shown here.
let dbxSectionSetup  = false;
let dbxTablesCache   = [];   // last-loaded table list, for the client-side filter
let dbxCurrentDb     = null;
let dbxCurrentSchema = null;
let dbxCurrentTable  = null;

function setupDbExplorer() {
  if (dbxSectionSetup) return;
  dbxSectionSetup = true;

  document.getElementById('dbx-refresh-databases').addEventListener('click', loadDbxDatabases);
  document.getElementById('dbx-table-search').addEventListener('input', filterDbxTables);
  document.getElementById('dbx-preview-btn').addEventListener('click', loadDbxPreview);
  document.getElementById('dbx-breadcrumb').addEventListener('click', (e) => {
    const crumb = e.target.closest('[data-dbx-crumb]');
    if (!crumb || crumb.classList.contains('dbx-crumb--active')) return;
    const step = crumb.dataset.dbxCrumb;
    if (step === 'databases') showDbxPanel('databases');
    else if (step === 'tables') showDbxPanel('tables');
  });

  loadDbxDatabases();
}

function showDbxPanel(step) {
  document.getElementById('dbx-panel-databases').style.display = step === 'databases' ? '' : 'none';
  document.getElementById('dbx-panel-tables').style.display    = step === 'tables'    ? '' : 'none';
  document.getElementById('dbx-panel-detail').style.display    = step === 'detail'    ? '' : 'none';
  renderDbxBreadcrumb(step);
}

function renderDbxBreadcrumb(step) {
  const parts = [{ key: 'databases', label: 'Databases' }];
  if (dbxCurrentDb) parts.push({ key: 'tables', label: dbxCurrentDb });
  if (dbxCurrentDb && dbxCurrentSchema && dbxCurrentTable) {
    parts.push({ key: 'detail', label: `${dbxCurrentSchema}.${dbxCurrentTable}` });
  }
  const html = parts.map((p, i) => {
    const isActive = p.key === step;
    const crumb = `<span class="dbx-crumb${isActive ? ' dbx-crumb--active' : ''}" data-dbx-crumb="${p.key}">${esc(p.label)}</span>`;
    return i === 0 ? crumb : `<span class="dbx-crumb-sep">/</span>${crumb}`;
  }).join('');
  document.getElementById('dbx-breadcrumb').innerHTML = html;
}

// ── Step 1: databases ────────────────────────────────────────────────────
async function loadDbxDatabases() {
  const body = document.getElementById('dbx-databases-body');
  body.innerHTML = '<tr><td colspan="5" class="loading-cell"><div class="spinner"></div>Loading…</td></tr>';
  try {
    const { data } = await api('/api/admin/dbexplorer/databases');
    renderDbxDatabases(data);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="loading-cell">Failed to load databases: ${esc(err.message)}</td></tr>`;
  }
}

function renderDbxDatabases(rows) {
  const body = document.getElementById('dbx-databases-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="loading-cell">No databases visible to this login.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => `
    <tr class="dbx-row-clickable" data-db="${esc(r.name)}">
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.state_desc)}</td>
      <td>${esc(r.recovery_model_desc)}</td>
      <td>${esc(r.compatibility_level)}</td>
      <td>${formatDate(r.create_date)}</td>
    </tr>
  `).join('');
  body.querySelectorAll('tr[data-db]').forEach(row => {
    row.addEventListener('click', () => selectDbxDatabase(row.dataset.db));
  });
}

// ── Step 2: tables in selected database ─────────────────────────────────
function selectDbxDatabase(dbName) {
  dbxCurrentDb     = dbName;
  dbxCurrentSchema = null;
  dbxCurrentTable  = null;
  document.getElementById('dbx-table-search').value = '';
  showDbxPanel('tables');
  loadDbxTables(dbName);
}

async function loadDbxTables(dbName) {
  const body = document.getElementById('dbx-tables-body');
  body.innerHTML = '<tr><td colspan="3" class="loading-cell"><div class="spinner"></div>Loading…</td></tr>';
  try {
    const { data } = await api(`/api/admin/dbexplorer/${encodeURIComponent(dbName)}/tables`);
    dbxTablesCache = data;
    renderDbxTables(data);
  } catch (err) {
    dbxTablesCache = [];
    body.innerHTML = `<tr><td colspan="3" class="loading-cell">Failed to load tables: ${esc(err.message)}</td></tr>`;
  }
}

function renderDbxTables(rows) {
  const body = document.getElementById('dbx-tables-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="3" class="loading-cell">No tables found.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => `
    <tr class="dbx-row-clickable" data-schema="${esc(r.SchemaName)}" data-table="${esc(r.TableName)}">
      <td>${esc(r.SchemaName)}</td>
      <td><strong>${esc(r.TableName)}</strong></td>
      <td>${r.ApproxRowCount != null ? Number(r.ApproxRowCount).toLocaleString('en-GB') : '—'}</td>
    </tr>
  `).join('');
  body.querySelectorAll('tr[data-table]').forEach(row => {
    row.addEventListener('click', () => selectDbxTable(row.dataset.schema, row.dataset.table));
  });
}

function filterDbxTables() {
  const q = document.getElementById('dbx-table-search').value.trim().toLowerCase();
  if (!q) { renderDbxTables(dbxTablesCache); return; }
  renderDbxTables(dbxTablesCache.filter(r =>
    r.SchemaName.toLowerCase().includes(q) || r.TableName.toLowerCase().includes(q)
  ));
}

// ── Step 3: table detail — columns, keys & constraints, preview ─────────
function selectDbxTable(schema, table) {
  dbxCurrentSchema = schema;
  dbxCurrentTable  = table;
  showDbxPanel('detail');

  document.getElementById('dbx-preview-wrap').style.display = 'none';
  document.getElementById('dbx-preview-wrap').innerHTML = '';
  document.getElementById('dbx-preview-empty').style.display = '';
  document.getElementById('dbx-preview-empty').textContent = 'Click Preview to load the first rows of this table.';

  loadDbxColumns();
  loadDbxConstraints();
}

function dbxTablePath() {
  return `/api/admin/dbexplorer/${encodeURIComponent(dbxCurrentDb)}/${encodeURIComponent(dbxCurrentSchema)}/${encodeURIComponent(dbxCurrentTable)}`;
}

async function loadDbxColumns() {
  const body = document.getElementById('dbx-columns-body');
  body.innerHTML = '<tr><td colspan="7" class="loading-cell"><div class="spinner"></div>Loading…</td></tr>';
  try {
    const { data } = await api(`${dbxTablePath()}/columns`);
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="7" class="loading-cell">No columns found.</td></tr>';
      return;
    }
    body.innerHTML = data.map(c => `
      <tr>
        <td>${c.ColumnID}</td>
        <td><strong>${esc(c.ColumnName)}</strong></td>
        <td>${esc(dbxFormatType(c))}</td>
        <td>${c.IsNullable ? 'YES' : 'no'}</td>
        <td>${c.IsIdentity ? 'YES' : ''}</td>
        <td>${c.IsPrimaryKey ? 'PK' : ''}</td>
        <td>${c.DefaultValue ? esc(c.DefaultValue) : ''}</td>
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="loading-cell">Failed to load columns: ${esc(err.message)}</td></tr>`;
  }
}

function dbxFormatType(c) {
  const t = c.DataType;
  if (['nvarchar', 'nchar'].includes(t) && c.MaxLength !== -1) return `${t}(${c.MaxLength / 2})`;
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t) && c.MaxLength !== -1) return `${t}(${c.MaxLength})`;
  if (['nvarchar', 'varchar', 'varbinary'].includes(t) && c.MaxLength === -1) return `${t}(max)`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.Precision},${c.Scale})`;
  return t;
}

async function loadDbxConstraints() {
  const wrap = document.getElementById('dbx-constraints-body');
  wrap.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Loading…</div>';
  try {
    const { data } = await api(`${dbxTablePath()}/constraints`);
    wrap.innerHTML = renderDbxConstraints(data);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load constraints: ${esc(err.message)}</div>`;
  }
}

function renderDbxConstraints(data) {
  const groups = [];

  if (data.keys.length) {
    groups.push(dbxConstraintGroup('Primary / Unique Keys', data.keys.map(k =>
      `${esc(k.ConstraintName)} (${k.ConstraintType === 'PRIMARY_KEY_CONSTRAINT' ? 'PRIMARY KEY' : 'UNIQUE'}) — ${esc(k.Columns)}`
    )));
  }
  if (data.foreignKeysOut.length) {
    groups.push(dbxConstraintGroup('Foreign Keys (from this table)', data.foreignKeysOut.map(fk =>
      `${esc(fk.ConstraintName)}: ${esc(fk.ColumnName)} &rarr; ${esc(fk.ReferencedSchema)}.${esc(fk.ReferencedTable)}.${esc(fk.ReferencedColumn)} ` +
      `<span class="dbx-preview-null">(ON DELETE ${esc(fk.OnDelete)}, ON UPDATE ${esc(fk.OnUpdate)})</span>`
    )));
  }
  if (data.foreignKeysIn.length) {
    groups.push(dbxConstraintGroup('Referenced by (foreign keys pointing here)', data.foreignKeysIn.map(fk =>
      `${esc(fk.ConstraintName)}: ${esc(fk.SourceSchema)}.${esc(fk.SourceTable)}.${esc(fk.SourceColumn)} &rarr; this.${esc(fk.ColumnName)}`
    )));
  }
  if (data.checkConstraints.length) {
    groups.push(dbxConstraintGroup('Check Constraints', data.checkConstraints.map(cc =>
      `${esc(cc.ConstraintName)}: ${esc(cc.Definition)}${cc.IsDisabled ? ' <span class="dbx-preview-null">(disabled)</span>' : ''}`
    )));
  }
  if (data.indexes.length) {
    groups.push(dbxConstraintGroup('Indexes', data.indexes.map(ix =>
      `${esc(ix.IndexName)} (${esc(ix.IndexType)}${ix.IsUnique ? ', unique' : ''}${ix.IsPrimaryKey ? ', primary key' : ''}) — ${esc(ix.Columns)}`
    )));
  }

  if (!groups.length) return '<div class="empty-state">No keys, constraints or indexes on this table.</div>';
  return groups.join('');
}

function dbxConstraintGroup(title, lines) {
  return `
    <div class="dbx-constraint-group">
      <div class="dbx-constraint-group-title">${esc(title)}</div>
      ${lines.map(l => `<div>${l}</div>`).join('')}
    </div>
  `;
}

async function loadDbxPreview() {
  const wrap  = document.getElementById('dbx-preview-wrap');
  const empty = document.getElementById('dbx-preview-empty');
  const top   = document.getElementById('dbx-preview-top').value;

  empty.style.display = '';
  empty.textContent = 'Loading…';
  wrap.style.display = 'none';

  try {
    const { data } = await api(`${dbxTablePath()}/preview?top=${encodeURIComponent(top)}`);
    if (!data.length) {
      empty.textContent = 'This table has no rows.';
      return;
    }
    wrap.innerHTML = buildSqlTable(data);
    wrap.style.display = '';
    empty.style.display = 'none';
  } catch (err) {
    empty.textContent = `Failed to load preview: ${err.message}`;
  }
}
