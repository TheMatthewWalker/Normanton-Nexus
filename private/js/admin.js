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

  // Load permissions when that section is first opened (superadmin only)
  const permNav = document.getElementById('nav-permissions');
  if (permNav) {
    permNav.addEventListener('click', () => { if (!allPermissionsLoaded) loadPermissions(); }, { once: true });
  }
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
  document.getElementById('edit-notes').value          = user.Notes || '';

  // Build role dropdown filtered to what this actor can assign
  const roleEl = document.getElementById('edit-role');
  roleEl.innerHTML = buildRoleOptions(user.Role);
  roleEl.value = user.Role;

  updateToggleLabel('edit-active', 'edit-active-label', 'Active',  'Inactive');
  updateToggleLabel('edit-locked', 'edit-locked-label', 'Locked',  'Unlocked');

  document.getElementById('edit-active').onchange = () =>
    updateToggleLabel('edit-active', 'edit-active-label', 'Active', 'Inactive');
  document.getElementById('edit-locked').onchange = () =>
    updateToggleLabel('edit-locked', 'edit-locked-label', 'Locked', 'Unlocked');

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
  const notes       = document.getElementById('edit-notes').value.trim();
  const departments = getCheckedDepts('edit-depts');

  const payload = { role, isActive, isLocked, notes, departments };

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
let sqlLastRows = [];

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

function exportSqlCsv() {
  if (!sqlLastRows.length) return;
  const cols  = Object.keys(sqlLastRows[0]);
  const lines = [
    cols.map(c  => `"${String(c).replace(/"/g, '""')}"`).join(','),
    ...sqlLastRows.map(row =>
      cols.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sql-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
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

  sqlLastRows = [];
  if (countEl)   { countEl.textContent = ''; countEl.style.display = 'none'; }
  if (exportBtn) exportBtn.style.display = 'none';
  resultEl.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Running…</div>';

  try {
    const res  = await fetch('/query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.success === false) {
      resultEl.innerHTML = `<div class="empty-state error-state">✕ ${esc((data && data.error) || `HTTP ${res.status}`)}</div>`;
      return;
    }

    const rows = data.recordset || [];
    if (rows.length) {
      sqlLastRows = rows;
      resultEl.innerHTML = buildSqlTable(rows);
      if (countEl)   { countEl.textContent = `${rows.length} row(s)`; countEl.style.display = ''; }
      if (exportBtn) exportBtn.style.display = '';
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

  if (inputEl) {
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); }
    });
  }
  if (runBtn)    runBtn.addEventListener('click', runSql);
  if (exportBtn) exportBtn.addEventListener('click', exportSqlCsv);
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (inputEl) inputEl.value = '';
      sqlLastRows = [];
      const resultEl  = document.getElementById('sql-result');
      const countEl   = document.getElementById('sql-row-count');
      const exportBtn2 = document.getElementById('sql-export');
      if (resultEl)   resultEl.innerHTML = '<div class="empty-state">No query executed yet.</div>';
      if (countEl)    countEl.style.display = 'none';
      if (exportBtn2) exportBtn2.style.display = 'none';
    });
  }
}
