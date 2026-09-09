// Admin > Users — pending approvals, full user list + inline edit, bulk ops,
// and per-user permission grant/revoke.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin");
  const DEPARTMENTS = ["engineering", "quality", "sales", "finance", "production", "warehouse", "logistics", "management"];

  let usersRows = [];

  // ── Pending approvals ────────────────────────────────────────────
  async function loadPending() {
    const el = document.getElementById("ua-pending");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/pending");
      const rows = data || [];
      el.innerHTML = rows.length === 0 ? "<p>No pending approvals.</p>" : `
        <table>
          <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Requested</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.username)}</td><td>${esc(r.firstName)} ${esc(r.lastName)}</td><td>${esc(r.email)}</td>
                <td>${new Date(r.createdAt).toLocaleString("en-GB")}</td>
                <td>
                  <select data-role-for="${r.userId}"><option value="operator">operator</option><option value="admin">admin</option><option value="superadmin">superadmin</option></select>
                  <input type="text" data-depts-for="${r.userId}" placeholder="dept,dept" style="width:8em;">
                  <button type="button" class="btn secondary" data-approve="${r.userId}">Approve</button>
                  <button type="button" class="btn secondary" data-reject="${r.userId}">Reject</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-approve]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.approve;
          const role = el.querySelector(`select[data-role-for="${id}"]`).value;
          const deptsRaw = el.querySelector(`input[data-depts-for="${id}"]`).value;
          const departments = deptsRaw ? deptsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
          try {
            await api(`/users/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, departments }) });
            await Promise.all([loadPending(), loadUsers()]);
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });
      el.querySelectorAll("button[data-reject]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!(await NexusModal.confirm("Reject this user?", { danger: true, confirmLabel: "Reject" }))) return;
          try {
            await api(`/users/${btn.dataset.reject}/reject`, { method: "POST" });
            await loadPending();
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  // ── All users ────────────────────────────────────────────────────
  async function loadUsers() {
    const el = document.getElementById("ua-users");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/users");
      usersRows = data || [];
      renderUsers();
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderUsers() {
    const q = document.getElementById("ua-search").value.trim().toLowerCase();
    const rows = q ? usersRows.filter((u) => [u.username, u.firstName, u.lastName, u.email].some((f) => (f || "").toLowerCase().includes(q))) : usersRows;
    const el = document.getElementById("ua-users");
    el.innerHTML = rows.length === 0 ? "<p>No users.</p>" : `
      <table>
        <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Departments</th><th>Active</th><th>Locked</th><th>Last Login</th><th></th></tr></thead>
        <tbody>
          ${rows.map((u) => `
            <tr>
              <td>${esc(u.username)}</td><td>${esc(u.firstName)} ${esc(u.lastName)}</td><td>${esc(u.role)}</td>
              <td>${esc((u.departments || []).join(", "))}</td><td>${u.isActive ? "Yes" : "No"}</td><td>${u.isLocked ? "Yes" : "No"}</td>
              <td>${u.lastLogin ? new Date(u.lastLogin).toLocaleString("en-GB") : "—"}</td>
              <td><button type="button" class="btn secondary" data-open="${u.userId}">Manage</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => openDetail(Number(btn.dataset.open)));
    });
  }

  document.getElementById("ua-search").addEventListener("input", renderUsers);

  function openDetail(userId) {
    const u = usersRows.find((x) => x.userId === userId);
    if (!u) return;
    const el = document.getElementById("ua-detail");
    el.style.display = "";
    el.innerHTML = `
      <div class="card">
        <h4>Edit ${esc(u.username)}</h4>
        <button type="button" class="btn" id="ua-detail-close">Close</button>
        <form id="ua-edit-form" style="margin-top:0.5rem;">
          <label>Username<input type="text" id="uae-username" value="${esc(u.username)}"></label>
          <label>First Name<input type="text" id="uae-first" value="${esc(u.firstName)}"></label>
          <label>Last Name<input type="text" id="uae-last" value="${esc(u.lastName)}"></label>
          <label>Email<input type="email" id="uae-email" value="${esc(u.email)}"></label>
          <label>Role<select id="uae-role">
            <option value="operator" ${u.role === "operator" ? "selected" : ""}>operator</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
            <option value="superadmin" ${u.role === "superadmin" ? "selected" : ""}>superadmin</option>
          </select></label>
          <label>Active <input type="checkbox" id="uae-active" ${u.isActive ? "checked" : ""}></label>
          <label>Locked <input type="checkbox" id="uae-locked" ${u.isLocked ? "checked" : ""}></label>
          <label>Short Idle Timeout <input type="checkbox" id="uae-idle" ${u.shortIdleTimeout ? "checked" : ""}></label>
          <fieldset>
            <legend>Departments</legend>
            ${DEPARTMENTS.map((d) => `<label style="display:inline-block; margin-right:0.75rem;"><input type="checkbox" value="${d}" class="uae-dept" ${(u.departments || []).includes(d) ? "checked" : ""}> ${d}</label>`).join("")}
          </fieldset>
          <label>Notes<textarea id="uae-notes" rows="2" style="width:100%;">${esc(u.notes)}</textarea></label>
          <button type="submit" class="btn secondary">Save</button>
        </form>

        <h4 style="margin-top:1rem;">Permissions</h4>
        <div id="ua-perms">Loading…</div>
        <form id="ua-grant-form" style="margin-top:0.5rem;">
          <label>Permission Code<input type="text" id="uae-grant-code" required></label>
          <button type="submit" class="btn secondary">Grant</button>
        </form>
      </div>`;

    document.getElementById("ua-detail-close").addEventListener("click", () => { el.style.display = "none"; el.innerHTML = ""; });

    document.getElementById("ua-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const departments = Array.from(el.querySelectorAll(".uae-dept:checked")).map((c) => c.value);
      try {
        await api(`/users/${userId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: document.getElementById("uae-role").value,
            isActive: document.getElementById("uae-active").checked,
            isLocked: document.getElementById("uae-locked").checked,
            notes: document.getElementById("uae-notes").value || null,
            departments,
            username: document.getElementById("uae-username").value || null,
            firstName: document.getElementById("uae-first").value || null,
            lastName: document.getElementById("uae-last").value || null,
            email: document.getElementById("uae-email").value || null,
            shortIdleTimeout: document.getElementById("uae-idle").checked,
          }),
        });
        await loadUsers();
        openDetail(userId);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    loadUserPermissions(userId);

    document.getElementById("ua-grant-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("uae-grant-code").value.trim();
      if (!code) return;
      try {
        await api(`/users/${userId}/permissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionCode: code }) });
        e.target.reset();
        await loadUserPermissions(userId);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });
  }

  async function loadUserPermissions(userId) {
    const el = document.getElementById("ua-perms");
    if (!el) return;
    try {
      const { data } = await api(`/users/${userId}/permissions`);
      const rows = data || [];
      el.innerHTML = rows.length === 0 ? "<p>No direct permission grants.</p>" : `
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Granted</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.permissionCode)}</td><td>${esc(r.permissionName)}</td><td>${esc(r.category)}</td>
                <td>${new Date(r.grantedAt).toLocaleDateString("en-GB")}</td>
                <td><button type="button" class="btn secondary" data-revoke="${esc(r.permissionCode)}">Revoke</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-revoke]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!(await NexusModal.confirm(`Revoke ${btn.dataset.revoke}?`, { danger: true, confirmLabel: "Revoke" }))) return;
          try {
            await api(`/users/${userId}/permissions/${encodeURIComponent(btn.dataset.revoke)}`, { method: "DELETE" });
            await loadUserPermissions(userId);
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function parseIds(raw) {
    return raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }

  // ── Bulk: Grant Departments ─────────────────────────────────────
  document.getElementById("ua-bulk-dept-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById("ua-bd-result");
    const userIds = parseIds(document.getElementById("ua-bd-ids").value);
    const departments = document.getElementById("ua-bd-depts").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const { data } = await api("/users/bulk-departments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds, departments }) });
      resultEl.textContent = `Granted ${data.summary.granted}, already had ${data.summary.alreadyHad}, failed ${data.summary.failed}.`;
      await loadUsers();
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
    }
  });

  // ── Bulk: Set Status ─────────────────────────────────────────────
  function parseTri(id) {
    const v = document.getElementById(id).value;
    return v === "" ? null : v === "true";
  }

  document.getElementById("ua-bulk-status-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById("ua-bs-result");
    const userIds = parseIds(document.getElementById("ua-bs-ids").value);
    try {
      const { data } = await api("/users/bulk-status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds, isActive: parseTri("ua-bs-active"), isLocked: parseTri("ua-bs-locked"), shortIdleTimeout: parseTri("ua-bs-idle") }),
      });
      resultEl.textContent = `Succeeded ${data.summary.succeeded}, failed ${data.summary.failed}.`;
      await loadUsers();
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
    }
  });

  // ── Bulk: Grant Permission Codes ─────────────────────────────────
  document.getElementById("ua-bulk-perm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById("ua-bp-result");
    const userIds = parseIds(document.getElementById("ua-bp-ids").value);
    const permissionCodes = document.getElementById("ua-bp-codes").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const { data } = await api("/users/bulk-permissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds, permissionCodes }) });
      resultEl.textContent = `Granted ${data.summary.granted}, already had ${data.summary.alreadyHad}, failed ${data.summary.failed}.`;
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
    }
  });

  // ── Bulk Create Users (superadmin) ────────────────────────────────
  const bulkCreateForm = document.getElementById("ua-bulk-create-form");
  if (bulkCreateForm) {
    bulkCreateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const resultEl = document.getElementById("ua-bc-result");
      const lines = document.getElementById("ua-bc-rows").value.split("\n").map((l) => l.trim()).filter(Boolean);
      const rows = lines.map((line) => {
        const [role, username, email, firstName, lastName, password, approved, unlocked, permissionCode] = line.split(",").map((s) => s.trim());
        return {
          role: role || null, username: username || null, email: email || null, firstName: firstName || null, lastName: lastName || null,
          password: password || null, approved: approved ? approved.toLowerCase() === "true" : null, unlocked: unlocked ? unlocked.toLowerCase() === "true" : null,
          permissionCode: permissionCode || null,
        };
      });
      try {
        const { data } = await api("/users/bulk-create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ department: document.getElementById("ua-bc-dept").value || null, rows }),
        });
        resultEl.innerHTML = `<p>Total ${data.summary.total}, succeeded ${data.summary.succeeded}, failed ${data.summary.failed}.</p>` +
          (data.results.some((r) => !r.success) ? `<ul>${data.results.filter((r) => !r.success).map((r) => `<li>Row ${r.row} (${esc(r.username)}): ${esc(r.error)}</li>`).join("")}</ul>` : "");
        await loadUsers();
      } catch (err) {
        resultEl.textContent = "Error: " + err.message;
      }
    });
  }

  loadPending();
  loadUsers();
})();
