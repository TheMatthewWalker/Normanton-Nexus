/**
 * routes/useradmin.js
 *
 * Admin API endpoints for user and permission management.
 *
 * All routes require: requireLogin + requireRole('admin')
 * Permission CRUD routes additionally require superadmin.
 *
 * Mount in server.js:
 *   import adminRoutes from './routes/useradmin.js';
 *   app.use('/api/useradmin', requireLogin, requireRole('admin'), adminRoutes);
 *
 * User endpoints:
 *   GET  /pending                      — list users with IsActive = 0
 *   GET  /users                        — list all users with departments + permissions
 *   PUT  /users/:id                    — update role, status, departments, notes
 *   POST /users/:id/approve            — activate a pending user
 *   POST /users/:id/reject             — delete a pending registration
 *   POST /users/bulk-create            — mass-create accounts from an imported list (superadmin only)
 *   POST /users/bulk-departments       — grant one or more departments to many users at once
 *   POST /users/bulk-status            — set active/locked/idle-timeout status on many users at once
 *   GET  /audit                        — audit log, optionally filtered by event type
 *
 * Permission definition endpoints (superadmin only):
 *   GET    /permissions                — list all permission definitions
 *   POST   /permissions                — create a new permission
 *   PUT    /permissions/:code          — update a permission's display name / description
 *   DELETE /permissions/:code          — delete a permission (cascades from users)
 *
 * User ↔ permission endpoints (admin or superadmin):
 *   GET    /users/:id/permissions      — list permissions granted to a user
 *   POST   /users/:id/permissions      — grant a permission  { permissionCode }
 *   DELETE /users/:id/permissions/:code — revoke a permission
 *   POST   /users/bulk-permissions     — grant one or more permissions to many users at once
 */

import express from 'express';
import sql     from 'mssql';
import bcrypt  from 'bcrypt';
import { sqlConfig } from '../config.js';

const router = express.Router();

const ROLE_LEVEL = { operator: 1, admin: 2, superadmin: 3 };
const VALID_ROLES = ['operator', 'admin', 'superadmin'];
const VALID_DEPTS = ['production','logistics','warehouse','finance','sales','quality','engineering','management'];

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(eventType, actorUsername, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  actorUsername || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[admin audit]', err.message);
  }
}

// ── GET /pending ──────────────────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  try {
    const pool   = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT UserID, Username, FirstName, LastName, Email, CreatedAt
      FROM kongsberg.dbo.PortalUsers
      WHERE IsActive = 0
      ORDER BY CreatedAt ASC
    `);
    res.json({ success: true, users: result.recordset });
  } catch (err) {
    console.error('[admin/pending]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /users ────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);

    const [usersResult, deptsResult, permsResult] = await Promise.all([
      pool.request().query(`
        SELECT
          UserID, Username, FirstName, LastName, Email, Role,
          IsActive, IsLocked, FailedLogins, ShortIdleTimeout,
          CreatedAt, LastLogin, Notes
        FROM kongsberg.dbo.PortalUsers
        ORDER BY CreatedAt DESC
      `),
      pool.request().query(`
        SELECT UserID, Department FROM kongsberg.dbo.PortalUserDepartments
      `),
      pool.request().query(`
        SELECT UserID, PermissionCode FROM kongsberg.dbo.PortalUserPermissions
      `).catch(() => ({ recordset: [] })),
    ]);

    const deptMap = {};
    for (const row of deptsResult.recordset) {
      if (!deptMap[row.UserID]) deptMap[row.UserID] = [];
      deptMap[row.UserID].push(row.Department);
    }

    const permMap = {};
    for (const row of permsResult.recordset) {
      if (!permMap[row.UserID]) permMap[row.UserID] = [];
      permMap[row.UserID].push(row.PermissionCode);
    }

    const users = usersResult.recordset.map(u => ({
      ...u,
      departments: deptMap[u.UserID] || [],
      permissions: permMap[u.UserID] || [],
    }));

    res.json({ success: true, users });

  } catch (err) {
    console.error('[admin/users]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /users/:id ────────────────────────────────────────────────────────────
router.put('/users/:id', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  const { role, isActive, isLocked, notes, departments,
          username, firstName, lastName, email, shortIdleTimeout } = req.body;

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }
  if (departments && !departments.every(d => VALID_DEPTS.includes(d))) {
    return res.status(400).json({ success: false, error: 'Invalid department in list' });
  }

  const actorRole  = req.session.user.role;
  const actorLevel = ROLE_LEVEL[actorRole] ?? 0;

  // Identity fields (username, name, email) — superadmin only
  const hasIdentityChange = username !== undefined || firstName !== undefined
                         || lastName !== undefined || email !== undefined;
  if (hasIdentityChange && actorRole !== 'superadmin') {
    return res.status(403).json({
      success: false,
      error: 'Only superadmins can edit username, name and email.',
    });
  }

  // Validate new username format if provided
  const newUsername = username?.trim() || null;
  if (newUsername && !/^[a-z0-9._-]{1,80}$/.test(newUsername)) {
    return res.status(400).json({
      success: false,
      error: 'Username must be 1–80 chars: lowercase letters, digits, dots, hyphens, underscores.',
    });
  }

  // Validate email format if provided
  const newEmail = email?.trim().toLowerCase() || null;
  if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ success: false, error: 'Invalid email address.' });
  }

  try {
    const pool = await sql.connect(sqlConfig);

    const current = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`SELECT Username, FirstName, LastName, Email, Role, IsActive, IsLocked, ShortIdleTimeout
              FROM kongsberg.dbo.PortalUsers WHERE UserID = @userID`);

    if (!current.recordset[0]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const prev       = current.recordset[0];
    const targetLevel = ROLE_LEVEL[prev.Role] ?? 0;

    if (actorRole !== 'superadmin') {
      if (targetLevel >= actorLevel) {
        return res.status(403).json({
          success: false,
          error: 'You cannot edit a user with an equal or higher role.',
        });
      }
      if (role && (ROLE_LEVEL[role] ?? 0) >= actorLevel) {
        return res.status(403).json({
          success: false,
          error: 'You cannot assign a role equal to or higher than your own.',
        });
      }
    }

    // Check username uniqueness
    if (newUsername && newUsername !== prev.Username) {
      const taken = await pool.request()
        .input('u',      sql.NVarChar(80), newUsername)
        .input('userID', sql.Int,          userID)
        .query(`SELECT 1 FROM kongsberg.dbo.PortalUsers
                WHERE Username = @u AND UserID != @userID`);
      if (taken.recordset.length) {
        return res.status(409).json({ success: false, error: 'That username is already taken.' });
      }
    }

    // Check email uniqueness
    if (newEmail && newEmail !== prev.Email) {
      const taken = await pool.request()
        .input('e',      sql.NVarChar(160), newEmail)
        .input('userID', sql.Int,           userID)
        .query(`SELECT 1 FROM kongsberg.dbo.PortalUsers
                WHERE Email = @e AND UserID != @userID`);
      if (taken.recordset.length) {
        return res.status(409).json({ success: false, error: 'That email address is already in use.' });
      }
    }

    // ── Update the user record ────────────────────────────────────────────────
    await pool.request()
      .input('userID',    sql.Int,          userID)
      .input('role',      sql.NVarChar(20),  role      ?? prev.Role)
      .input('isActive',  sql.Bit,           isActive  ?? prev.IsActive)
      .input('isLocked',  sql.Bit,           isLocked  ?? prev.IsLocked)
      .input('notes',     sql.NVarChar(500), notes     ?? null)
      .input('uname',     sql.NVarChar(80),  newUsername ?? prev.Username)
      .input('fname',     sql.NVarChar(80),  firstName !== undefined ? (firstName?.trim() || null) : prev.FirstName)
      .input('lname',     sql.NVarChar(80),  lastName  !== undefined ? (lastName?.trim()  || null) : prev.LastName)
      .input('email',     sql.NVarChar(160), newEmail  ?? prev.Email)
      .input('shortTimeout', sql.Bit,        shortIdleTimeout !== undefined ? (shortIdleTimeout ? 1 : 0) : prev.ShortIdleTimeout)
      .query(`
        UPDATE kongsberg.dbo.PortalUsers
        SET Role       = @role,
            IsActive   = @isActive,
            IsLocked   = @isLocked,
            Notes      = @notes,
            Username   = @uname,
            FirstName  = @fname,
            LastName   = @lname,
            Email      = @email,
            ShortIdleTimeout = @shortTimeout,
            FailedLogins = CASE WHEN @isLocked = 0 THEN 0 ELSE FailedLogins END
        WHERE UserID = @userID
      `);

    // ── Cascade username rename across all referencing tables ─────────────────
    const oldUsername = prev.Username;
    if (newUsername && newUsername !== oldUsername) {
      // Audit log entries made by this user
      await pool.request()
        .input('old', sql.NVarChar(80), oldUsername)
        .input('new', sql.NVarChar(80), newUsername)
        .query(`UPDATE kongsberg.dbo.PortalAuditLog
                SET Username = @new WHERE Username = @old`);

      // ApprovedBy field on other user records
      await pool.request()
        .input('old', sql.NVarChar(80), oldUsername)
        .input('new', sql.NVarChar(80), newUsername)
        .query(`UPDATE kongsberg.dbo.PortalUsers
                SET ApprovedBy = @new WHERE ApprovedBy = @old`);

      // GrantedBy in department assignments
      await pool.request()
        .input('old', sql.NVarChar(80), oldUsername)
        .input('new', sql.NVarChar(80), newUsername)
        .query(`UPDATE kongsberg.dbo.PortalUserDepartments
                SET GrantedBy = @new WHERE GrantedBy = @old`);
    }

    // ── Replace department access ─────────────────────────────────────────────
    if (Array.isArray(departments)) {
      await pool.request()
        .input('userID', sql.Int, userID)
        .query('DELETE FROM kongsberg.dbo.PortalUserDepartments WHERE UserID = @userID');

      for (const dept of departments) {
        await pool.request()
          .input('userID',    sql.Int,         userID)
          .input('dept',      sql.NVarChar(50), dept)
          .input('grantedBy', sql.NVarChar(80), req.session.user.username)
          .query(`INSERT INTO kongsberg.dbo.PortalUserDepartments (UserID, Department, GrantedBy)
                  VALUES (@userID, @dept, @grantedBy)`);
      }
    }

    // ── Audit ─────────────────────────────────────────────────────────────────
    const actor = req.session.user.username;
    if (newUsername && newUsername !== oldUsername) {
      await audit('USERNAME_CHANGE', actor,
        `Renamed ${oldUsername} → ${newUsername}`, req);
    }
    if ((firstName !== undefined && (firstName?.trim() || '') !== (prev.FirstName || ''))
     || (lastName  !== undefined && (lastName?.trim()  || '') !== (prev.LastName  || ''))
     || (newEmail && newEmail !== prev.Email)) {
      await audit('PROFILE_CHANGE', actor,
        `Updated profile details for ${newUsername ?? oldUsername}`, req);
    }
    if (role && role !== prev.Role) {
      await audit('ROLE_CHANGE', actor,
        `Changed ${newUsername ?? oldUsername} role: ${prev.Role} → ${role}`, req);
    }
    if (Array.isArray(departments)) {
      await audit('DEPT_CHANGE', actor,
        `Updated ${newUsername ?? oldUsername} departments: ${departments.join(', ') || 'none'}`, req);
    }
    if (isLocked !== undefined && !!isLocked !== !!prev.IsLocked) {
      await audit(isLocked ? 'LOCKED' : 'UNLOCKED', actor,
        `${isLocked ? 'Locked' : 'Unlocked'} account: ${newUsername ?? oldUsername}`, req);
    }
    if (shortIdleTimeout !== undefined && !!shortIdleTimeout !== !!prev.ShortIdleTimeout) {
      await audit('IDLE_TIMEOUT_CHANGE', actor,
        `${shortIdleTimeout ? 'Enabled' : 'Disabled'} 5-minute idle timeout for ${newUsername ?? oldUsername}`, req);
    }

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/users PUT]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/:id/approve ───────────────────────────────────────────────────
router.post('/users/:id/approve', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  const { role = 'operator', departments = [] } = req.body;

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }

  const actorRole  = req.session.user.role;
  const actorLevel = ROLE_LEVEL[actorRole] ?? 0;
  if (actorRole !== 'superadmin' && (ROLE_LEVEL[role] ?? 0) >= actorLevel) {
    return res.status(403).json({
      success: false,
      error: 'You cannot approve a user into a role equal to or higher than your own.',
    });
  }
  if (!departments.every(d => VALID_DEPTS.includes(d))) {
    return res.status(400).json({ success: false, error: 'Invalid department in list' });
  }

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('userID',     sql.Int,         userID)
      .input('role',       sql.NVarChar(20), role)
      .input('approvedBy', sql.NVarChar(80), actor)
      .query(`
        UPDATE kongsberg.dbo.PortalUsers
        SET IsActive   = 1,
            Role       = @role,
            ApprovedBy = @approvedBy,
            ApprovedAt = GETDATE()
        OUTPUT INSERTED.Username
        WHERE UserID = @userID AND IsActive = 0
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, error: 'Pending user not found' });
    }
    const approvedUsername = result.recordset[0].Username;

    for (const dept of departments) {
      await pool.request()
        .input('userID',    sql.Int,         userID)
        .input('dept',      sql.NVarChar(50), dept)
        .input('grantedBy', sql.NVarChar(80), actor)
        .query(`
          INSERT INTO kongsberg.dbo.PortalUserDepartments (UserID, Department, GrantedBy)
          VALUES (@userID, @dept, @grantedBy)
        `);
    }

    await audit('APPROVED', actor,
      `Approved ${approvedUsername} as ${role} — depts: ${departments.join(', ') || 'none'}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/approve]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/:id/reject ────────────────────────────────────────────────────
router.post('/users/:id/reject', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        DELETE FROM kongsberg.dbo.PortalUsers
        OUTPUT DELETED.Username
        WHERE UserID = @userID AND IsActive = 0
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, error: 'Pending user not found' });
    }

    await audit('REJECTED', actor,
      `Rejected registration for ${result.recordset[0].Username}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/reject]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/bulk-create ───────────────────────────────────────────────────
// Superadmin only. Mass-creates accounts from an imported list (e.g. a CSV
// of new starters), parsed to JSON client-side.
//
// Body: { department: string|null, rows: [{
//   role, username, email, firstName, lastName, password,
//   approved, unlocked, permissionCode
// }] }
//
// Every row gets MustChangePassword = 1 — the whole point of this endpoint
// is importing many accounts that share one known initial password, so
// each new user is forced through POST /api/profile/change-password (see
// routes/profile.js) before they can use anything past the landing page
// (see server.js's /private/:page route and private/js/landing.js).
//
// Each row is validated and inserted independently in its own transaction
// so one bad row (duplicate username, bad password, etc.) doesn't abort
// the rest of the batch — the response is a per-row result array plus a
// summary count.
router.post('/users/bulk-create', requireSuperadmin, async (req, res) => {
  const { department = null, rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, error: 'No rows provided.' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ success: false, error: 'Maximum 500 rows per batch.' });
  }
  if (department && !VALID_DEPTS.includes(department)) {
    return res.status(400).json({ success: false, error: 'Invalid department.' });
  }

  const actor      = req.session.user.username;
  const actorID    = req.session.user.userID;
  const results    = [];
  const hashCache  = new Map();
  const seenUsernames = new Set();
  const seenEmails    = new Set();

  try {
    const pool = await sql.connect(sqlConfig);

    for (let i = 0; i < rows.length; i++) {
      const raw    = rows[i] || {};
      const rowNum = i + 1;

      const role           = String(raw.role || 'operator').trim().toLowerCase();
      const username       = String(raw.username || '').trim();
      const email          = String(raw.email || '').trim().toLowerCase();
      const firstName      = String(raw.firstName || '').trim();
      const lastName       = String(raw.lastName || '').trim();
      const password       = String(raw.password || '');
      const approved       = raw.approved === undefined ? true : !!raw.approved;
      const isLocked       = raw.unlocked === undefined ? false : !raw.unlocked;
      const permissionCode = raw.permissionCode ? String(raw.permissionCode).trim().toUpperCase() : null;

      const fail = (error) => results.push({ row: rowNum, username, success: false, error });

      if (!VALID_ROLES.includes(role))                                     { fail(`Invalid role "${role}"`); continue; }
      if (!username || !/^[a-z0-9._-]{1,80}$/.test(username))              { fail('Invalid username — use lowercase letters, digits, dots, hyphens, underscores.'); continue; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))             { fail('Invalid email address.'); continue; }
      if (!firstName || !lastName)                                         { fail('First and last name are required.'); continue; }
      if (password.length < 10 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        fail('Password must be at least 10 characters with one uppercase letter and one number.'); continue;
      }
      if (permissionCode && !/^[A-Z0-9_]{2,50}$/.test(permissionCode))     { fail(`Invalid permission code "${permissionCode}".`); continue; }

      const usernameKey = username.toLowerCase();
      if (seenUsernames.has(usernameKey)) { fail('Duplicate username within this batch.'); continue; }
      if (seenEmails.has(email))          { fail('Duplicate email within this batch.'); continue; }

      const taken = await pool.request()
        .input('u', sql.NVarChar(80),  username)
        .input('e', sql.NVarChar(160), email)
        .query(`SELECT Username, Email FROM kongsberg.dbo.PortalUsers WHERE Username = @u OR Email = @e`);
      if (taken.recordset.length) {
        fail(taken.recordset[0].Username === username ? 'Username already exists.' : 'Email already registered.');
        continue;
      }

      if (permissionCode) {
        const permExists = await pool.request()
          .input('code', sql.NVarChar(50), permissionCode)
          .query(`SELECT 1 FROM kongsberg.dbo.PortalPermissions WHERE PermissionCode = @code`);
        if (!permExists.recordset.length) { fail(`Permission code "${permissionCode}" does not exist.`); continue; }
      }

      seenUsernames.add(usernameKey);
      seenEmails.add(email);

      let hash = hashCache.get(password);
      if (!hash) {
        hash = await bcrypt.hash(password, 12);
        hashCache.set(password, hash);
      }

      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const insertResult = await tx.request()
          .input('username',    sql.NVarChar(80),  username)
          .input('firstName',   sql.NVarChar(80),  firstName)
          .input('lastName',    sql.NVarChar(80),  lastName)
          .input('email',       sql.NVarChar(160), email)
          .input('hash',        sql.NVarChar(256), hash)
          .input('role',        sql.NVarChar(20),  role)
          .input('isActive',    sql.Bit,           approved ? 1 : 0)
          .input('isLocked',    sql.Bit,           isLocked ? 1 : 0)
          .input('approvedBy',  sql.NVarChar(80),  approved ? actor : null)
          .query(`
            INSERT INTO kongsberg.dbo.PortalUsers
              (Username, FirstName, LastName, Email, PasswordHash, Role,
               IsActive, IsLocked, MustChangePassword, ApprovedBy, ApprovedAt)
            OUTPUT INSERTED.UserID
            VALUES (@username, @firstName, @lastName, @email, @hash, @role,
                    @isActive, @isLocked, 1, @approvedBy,
                    CASE WHEN @isActive = 1 THEN GETDATE() ELSE NULL END)
          `);

        const newUserID = insertResult.recordset[0].UserID;

        if (department) {
          await tx.request()
            .input('userID',    sql.Int,          newUserID)
            .input('dept',      sql.NVarChar(50), department)
            .input('grantedBy', sql.NVarChar(80), actor)
            .query(`INSERT INTO kongsberg.dbo.PortalUserDepartments (UserID, Department, GrantedBy)
                    VALUES (@userID, @dept, @grantedBy)`);
        }

        if (permissionCode) {
          await tx.request()
            .input('userID',       sql.Int,          newUserID)
            .input('code',         sql.NVarChar(50), permissionCode)
            .input('grantedByID',  sql.Int,          actorID)
            .query(`INSERT INTO kongsberg.dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID)
                    VALUES (@userID, @code, @grantedByID)`);
        }

        await tx.commit();
        results.push({ row: rowNum, username, success: true, userID: newUserID });
      } catch (err) {
        await tx.rollback();
        fail(err.message);
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.length - succeeded;

    await audit('BULK_CREATE', actor,
      `Bulk-created ${succeeded} user(s)${failed ? `, ${failed} failed` : ''}` +
      `${department ? ` — department: ${department}` : ''}`, req);

    res.json({ success: true, results, summary: { total: rows.length, succeeded, failed } });

  } catch (err) {
    console.error('[admin/users bulk-create]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/bulk-departments ────────────────────────────────────────────────
// Admin or superadmin. Grants one or more departments to many users at once —
// e.g. fixing a bulk-created batch that missed picking a department the
// first time round. Body: { userIDs: [1,2,3], departments: ['production'] }
// A (userID, department) pair the user already holds is silently skipped,
// not treated as an error — relies on the real DB-level uniqueness
// (UX_UserDept on PortalUserDepartments) to detect the duplicate, same
// pattern as POST /users/bulk-permissions above.
router.post('/users/bulk-departments', async (req, res) => {
  const { userIDs, departments } = req.body;

  if (!Array.isArray(userIDs) || !userIDs.length) {
    return res.status(400).json({ success: false, error: 'Select at least one user.' });
  }
  if (!Array.isArray(departments) || !departments.length) {
    return res.status(400).json({ success: false, error: 'Select at least one department.' });
  }
  if (userIDs.length > 500) {
    return res.status(400).json({ success: false, error: 'Maximum 500 users per batch.' });
  }

  const ids = [...new Set(userIDs.map(id => parseInt(id, 10)))];
  if (ids.some(id => !id || isNaN(id))) {
    return res.status(400).json({ success: false, error: 'Invalid user ID in selection.' });
  }

  const depts = [...new Set(departments)];
  if (!depts.every(d => VALID_DEPTS.includes(d))) {
    return res.status(400).json({ success: false, error: 'Invalid department in selection.' });
  }

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    // Fetch usernames for every selected user in one round trip
    const userReq = pool.request();
    ids.forEach((id, i) => userReq.input(`u${i}`, sql.Int, id));
    const userResult = await userReq.query(`
      SELECT UserID, Username FROM kongsberg.dbo.PortalUsers
      WHERE UserID IN (${ids.map((_, i) => `@u${i}`).join(',')})
    `);
    const userMap = new Map(userResult.recordset.map(r => [r.UserID, r.Username]));

    const results = [];
    for (const userID of ids) {
      const username = userMap.get(userID);
      if (!username) {
        results.push({ userID, username: null, granted: 0, alreadyHad: 0, error: 'User not found' });
        continue;
      }

      let granted = 0, alreadyHad = 0;
      for (const dept of depts) {
        try {
          await pool.request()
            .input('userID',    sql.Int,         userID)
            .input('dept',      sql.NVarChar(50), dept)
            .input('grantedBy', sql.NVarChar(80), actor)
            .query(`
              INSERT INTO kongsberg.dbo.PortalUserDepartments (UserID, Department, GrantedBy)
              VALUES (@userID, @dept, @grantedBy)
            `);
          granted++;
        } catch (dupErr) {
          if (dupErr.number === 2627 || dupErr.message?.includes('UNIQUE') || dupErr.message?.includes('duplicate')) {
            alreadyHad++;
          } else {
            throw dupErr;
          }
        }
      }
      results.push({ userID, username, granted, alreadyHad });
    }

    const totalGranted = results.reduce((s, r) => s + r.granted, 0);
    const totalAlready = results.reduce((s, r) => s + r.alreadyHad, 0);
    const totalFailed  = results.filter(r => r.error).length;

    await audit('DEPT_BULK_GRANT', actor,
      `Granted [${depts.join(', ')}] to ${ids.length} user(s) — ${totalGranted} new grant(s), ${totalAlready} already held` +
      `${totalFailed ? `, ${totalFailed} user(s) not found` : ''}`, req);

    res.json({
      success: true,
      results,
      summary: { users: ids.length, granted: totalGranted, alreadyHad: totalAlready, failed: totalFailed },
    });

  } catch (err) {
    console.error('[admin/users bulk-departments]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/bulk-status ─────────────────────────────────────────────────────
// Admin or superadmin. Sets IsActive/IsLocked/ShortIdleTimeout on many users
// at once — each of the three fields is only touched if present in the
// body, so a batch can change just one or two of them and leave the rest
// alone (unlike PUT /users/:id, which is a single-user full-row update
// where every field is always supplied by the edit modal).
// Body: { userIDs: [1,2,3], isActive?: bool, isLocked?: bool, shortIdleTimeout?: bool }
// Same per-user role-escalation guard as PUT /users/:id: a non-superadmin
// actor can't touch a user whose current role is equal to or higher than
// their own — failed per-row here rather than rejecting the whole batch.
router.post('/users/bulk-status', async (req, res) => {
  const { userIDs, isActive, isLocked, shortIdleTimeout } = req.body;

  if (!Array.isArray(userIDs) || !userIDs.length) {
    return res.status(400).json({ success: false, error: 'Select at least one user.' });
  }
  if (userIDs.length > 500) {
    return res.status(400).json({ success: false, error: 'Maximum 500 users per batch.' });
  }
  if (isActive === undefined && isLocked === undefined && shortIdleTimeout === undefined) {
    return res.status(400).json({ success: false, error: 'Select at least one setting to change.' });
  }

  const ids = [...new Set(userIDs.map(id => parseInt(id, 10)))];
  if (ids.some(id => !id || isNaN(id))) {
    return res.status(400).json({ success: false, error: 'Invalid user ID in selection.' });
  }

  const actorRole  = req.session.user.role;
  const actorLevel = ROLE_LEVEL[actorRole] ?? 0;

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const userReq = pool.request();
    ids.forEach((id, i) => userReq.input(`u${i}`, sql.Int, id));
    const userResult = await userReq.query(`
      SELECT UserID, Username, Role FROM kongsberg.dbo.PortalUsers
      WHERE UserID IN (${ids.map((_, i) => `@u${i}`).join(',')})
    `);
    const userMap = new Map(userResult.recordset.map(r => [r.UserID, r]));

    const results = [];
    for (const userID of ids) {
      const user = userMap.get(userID);
      if (!user) {
        results.push({ userID, username: null, success: false, error: 'User not found' });
        continue;
      }
      if (actorRole !== 'superadmin' && (ROLE_LEVEL[user.Role] ?? 0) >= actorLevel) {
        results.push({ userID, username: user.Username, success: false, error: 'Cannot edit a user with an equal or higher role.' });
        continue;
      }

      const sets    = [];
      const request = pool.request().input('userID', sql.Int, userID);
      if (isActive !== undefined) {
        sets.push('IsActive = @isActive');
        request.input('isActive', sql.Bit, isActive ? 1 : 0);
      }
      if (isLocked !== undefined) {
        sets.push('IsLocked = @isLocked');
        request.input('isLocked', sql.Bit, isLocked ? 1 : 0);
        // Unlocking also resets the failed-login counter, same as PUT /users/:id
        if (!isLocked) sets.push('FailedLogins = 0');
      }
      if (shortIdleTimeout !== undefined) {
        sets.push('ShortIdleTimeout = @shortIdleTimeout');
        request.input('shortIdleTimeout', sql.Bit, shortIdleTimeout ? 1 : 0);
      }

      await request.query(`UPDATE kongsberg.dbo.PortalUsers SET ${sets.join(', ')} WHERE UserID = @userID`);
      results.push({ userID, username: user.Username, success: true });
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.length - succeeded;

    const changes = [];
    if (isActive !== undefined)         changes.push(`Active=${isActive}`);
    if (isLocked !== undefined)         changes.push(`Locked=${isLocked}`);
    if (shortIdleTimeout !== undefined) changes.push(`ShortIdleTimeout=${shortIdleTimeout}`);

    await audit('STATUS_BULK_UPDATE', actor,
      `Set [${changes.join(', ')}] on ${succeeded} user(s)${failed ? `, ${failed} failed` : ''}`, req);

    res.json({ success: true, results, summary: { total: ids.length, succeeded, failed } });

  } catch (err) {
    console.error('[admin/users bulk-status]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /audit ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const { event } = req.query;

  const VALID_EVENTS = [
    'LOGIN_OK','LOGIN_FAIL','LOGOUT','REGISTER',
    'APPROVED','REJECTED','ROLE_CHANGE','DEPT_CHANGE','LOCKED','UNLOCKED',
    'USERNAME_CHANGE','PROFILE_CHANGE','IDLE_TIMEOUT_CHANGE',
    'RAW_SQL','RAW_SQL_BLOCKED','RAW_SQL_ERROR',
    'SAP_OK','SAP_ERROR',
    'PERM_GRANT','PERM_REVOKE','PERM_CREATE','PERM_UPDATE','PERM_DELETE','PERM_BULK_GRANT',
    'BULK_CREATE','PASSWORD_CHANGE','DEPT_BULK_GRANT','STATUS_BULK_UPDATE',
  ];

  if (event && !VALID_EVENTS.includes(event)) {
    return res.status(400).json({ success: false, error: 'Invalid event filter' });
  }

  try {
    const pool    = await sql.connect(sqlConfig);
    const request = pool.request();

    let whereClause = '';
    if (event) {
      request.input('event', sql.NVarChar(50), event);
      whereClause = 'WHERE EventType = @event';
    }

    const result = await request.query(`
      SELECT TOP 500
        LogID, EventTime, Username, EventType, Detail, IPAddress
      FROM kongsberg.dbo.PortalAuditLog
      ${whereClause}
      ORDER BY EventTime DESC
    `);

    res.json({ success: true, rows: result.recordset });

  } catch (err) {
    console.error('[admin/audit]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Permission definition endpoints — superadmin only
// ═══════════════════════════════════════════════════════════════════════════════

function requireSuperadmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Requires superadmin role.' });
}

// ── GET /permissions ──────────────────────────────────────────────────────────
router.get('/permissions', async (req, res) => {
  try {
    const pool   = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT PermissionCode, PermissionName, Description, Category, CreatedAt
      FROM kongsberg.dbo.PortalPermissions
      ORDER BY Category, PermissionCode
    `);
    res.json({ success: true, permissions: result.recordset });
  } catch (err) {
    console.error('[admin/permissions GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /permissions ─────────────────────────────────────────────────────────
router.post('/permissions', requireSuperadmin, async (req, res) => {
  const { permissionCode, permissionName, description, category } = req.body;

  if (!permissionCode || !permissionName || !category) {
    return res.status(400).json({ success: false, error: 'permissionCode, permissionName and category are required.' });
  }

  const codeClean = permissionCode.trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,50}$/.test(codeClean)) {
    return res.status(400).json({ success: false, error: 'Permission code must be 2-50 uppercase letters, digits or underscores.' });
  }

  try {
    const pool = await sql.connect(sqlConfig);

    const exists = await pool.request()
      .input('code', sql.NVarChar(50), codeClean)
      .query(`SELECT 1 FROM kongsberg.dbo.PortalPermissions WHERE PermissionCode = @code`);

    if (exists.recordset.length) {
      return res.status(409).json({ success: false, error: 'Permission code already exists.' });
    }

    await pool.request()
      .input('code',        sql.NVarChar(50),  codeClean)
      .input('name',        sql.NVarChar(100), permissionName.trim())
      .input('description', sql.NVarChar(500), description?.trim() || null)
      .input('category',    sql.NVarChar(50),  category.trim())
      .query(`
        INSERT INTO kongsberg.dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category)
        VALUES (@code, @name, @description, @category)
      `);

    await audit('PERM_CREATE', req.session.user.username,
      `Created permission: ${codeClean} (${permissionName.trim()})`, req);

    res.json({ success: true, permissionCode: codeClean });

  } catch (err) {
    console.error('[admin/permissions POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /permissions/:code ────────────────────────────────────────────────────
router.put('/permissions/:code', requireSuperadmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { permissionName, description, category } = req.body;

  if (!permissionName && !description && !category) {
    return res.status(400).json({ success: false, error: 'Nothing to update.' });
  }

  try {
    const pool = await sql.connect(sqlConfig);

    const current = await pool.request()
      .input('code', sql.NVarChar(50), code)
      .query(`SELECT PermissionName, Description, Category FROM kongsberg.dbo.PortalPermissions WHERE PermissionCode = @code`);

    if (!current.recordset[0]) {
      return res.status(404).json({ success: false, error: 'Permission not found.' });
    }
    const prev = current.recordset[0];

    await pool.request()
      .input('code',        sql.NVarChar(50),  code)
      .input('name',        sql.NVarChar(100), permissionName?.trim() ?? prev.PermissionName)
      .input('description', sql.NVarChar(500), description?.trim()    ?? prev.Description)
      .input('category',    sql.NVarChar(50),  category?.trim()       ?? prev.Category)
      .query(`
        UPDATE kongsberg.dbo.PortalPermissions
        SET PermissionName = @name, Description = @description, Category = @category
        WHERE PermissionCode = @code
      `);

    await audit('PERM_UPDATE', req.session.user.username,
      `Updated permission: ${code}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/permissions PUT]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /permissions/:code ─────────────────────────────────────────────────
router.delete('/permissions/:code', requireSuperadmin, async (req, res) => {
  const code = req.params.code.toUpperCase();

  try {
    const pool = await sql.connect(sqlConfig);

    // Remove from all users first (FK constraint)
    await pool.request()
      .input('code', sql.NVarChar(50), code)
      .query(`DELETE FROM kongsberg.dbo.PortalUserPermissions WHERE PermissionCode = @code`);

    const result = await pool.request()
      .input('code', sql.NVarChar(50), code)
      .query(`
        DELETE FROM kongsberg.dbo.PortalPermissions
        OUTPUT DELETED.PermissionCode
        WHERE PermissionCode = @code
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, error: 'Permission not found.' });
    }

    await audit('PERM_DELETE', req.session.user.username,
      `Deleted permission: ${code}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/permissions DELETE]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// User ↔ permission endpoints — admin or superadmin
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /users/:id/permissions ────────────────────────────────────────────────
router.get('/users/:id/permissions', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  try {
    const pool   = await sql.connect(sqlConfig);
    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT up.PermissionCode, p.PermissionName, p.Category, up.GrantedAt
        FROM kongsberg.dbo.PortalUserPermissions up
        JOIN kongsberg.dbo.PortalPermissions p ON p.PermissionCode = up.PermissionCode
        WHERE up.UserID = @userID
        ORDER BY p.Category, up.PermissionCode
      `);

    res.json({ success: true, permissions: result.recordset });

  } catch (err) {
    console.error('[admin/users/permissions GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/:id/permissions ───────────────────────────────────────────────
router.post('/users/:id/permissions', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  const { permissionCode } = req.body;
  if (!permissionCode) {
    return res.status(400).json({ success: false, error: 'permissionCode is required.' });
  }

  const code = permissionCode.trim().toUpperCase();

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    // Verify permission code exists
    const permExists = await pool.request()
      .input('code', sql.NVarChar(50), code)
      .query(`SELECT 1 FROM kongsberg.dbo.PortalPermissions WHERE PermissionCode = @code`);

    if (!permExists.recordset.length) {
      return res.status(404).json({ success: false, error: 'Permission code does not exist.' });
    }

    // Verify user exists
    const userExists = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`SELECT Username FROM kongsberg.dbo.PortalUsers WHERE UserID = @userID`);

    if (!userExists.recordset[0]) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    try {
      await pool.request()
        .input('userID',        sql.Int,         userID)
        .input('code',          sql.NVarChar(50), code)
        .input('grantedByID',   sql.Int,          req.session.user.userID)
        .query(`
          INSERT INTO kongsberg.dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID)
          VALUES (@userID, @code, @grantedByID)
        `);
    } catch (dupErr) {
      // Unique constraint violation — already has the permission
      if (dupErr.number === 2627 || dupErr.message?.includes('UNIQUE') || dupErr.message?.includes('duplicate')) {
        return res.status(409).json({ success: false, error: 'User already has this permission.' });
      }
      throw dupErr;
    }

    await audit('PERM_GRANT', actor,
      `Granted ${code} to ${userExists.recordset[0].Username}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/users/permissions POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /users/:id/permissions/:code ───────────────────────────────────────
router.delete('/users/:id/permissions/:code', async (req, res) => {
  const userID = parseInt(req.params.id, 10);
  if (!userID || isNaN(userID)) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
  }

  const code = req.params.code.toUpperCase();

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const userResult = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`SELECT Username FROM kongsberg.dbo.PortalUsers WHERE UserID = @userID`);

    if (!userResult.recordset[0]) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const result = await pool.request()
      .input('userID', sql.Int,         userID)
      .input('code',   sql.NVarChar(50), code)
      .query(`
        DELETE FROM kongsberg.dbo.PortalUserPermissions
        OUTPUT DELETED.PermissionCode
        WHERE UserID = @userID AND PermissionCode = @code
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, error: 'Permission not assigned to this user.' });
    }

    await audit('PERM_REVOKE', actor,
      `Revoked ${code} from ${userResult.recordset[0].Username}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[admin/users/permissions DELETE]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /users/bulk-permissions ──────────────────────────────────────────────
// Admin or superadmin. Grants one or more permission codes to many users at
// once — e.g. rolling a new supervisor permission out to a whole shift.
// Body: { userIDs: [1,2,3], permissionCodes: ['PROD_SUPER', 'LOG_PLANNING'] }
// A (userID, code) pair the user already holds is silently skipped, not
// treated as an error — same idempotent-grant spirit as the single-user
// POST /users/:id/permissions endpoint's duplicate handling above.
router.post('/users/bulk-permissions', async (req, res) => {
  const { userIDs, permissionCodes } = req.body;

  if (!Array.isArray(userIDs) || !userIDs.length) {
    return res.status(400).json({ success: false, error: 'Select at least one user.' });
  }
  if (!Array.isArray(permissionCodes) || !permissionCodes.length) {
    return res.status(400).json({ success: false, error: 'Select at least one permission.' });
  }
  if (userIDs.length > 500) {
    return res.status(400).json({ success: false, error: 'Maximum 500 users per batch.' });
  }

  const ids = [...new Set(userIDs.map(id => parseInt(id, 10)))];
  if (ids.some(id => !id || isNaN(id))) {
    return res.status(400).json({ success: false, error: 'Invalid user ID in selection.' });
  }

  const codes = [...new Set(permissionCodes.map(c => String(c).trim().toUpperCase()))];
  if (codes.some(c => !/^[A-Z0-9_]{2,50}$/.test(c))) {
    return res.status(400).json({ success: false, error: 'Invalid permission code in selection.' });
  }

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    // Verify every selected code actually exists
    const permReq = pool.request();
    codes.forEach((c, i) => permReq.input(`c${i}`, sql.NVarChar(50), c));
    const permResult = await permReq.query(`
      SELECT PermissionCode FROM kongsberg.dbo.PortalPermissions
      WHERE PermissionCode IN (${codes.map((_, i) => `@c${i}`).join(',')})
    `);
    const validCodes   = new Set(permResult.recordset.map(r => r.PermissionCode));
    const invalidCodes = codes.filter(c => !validCodes.has(c));
    if (invalidCodes.length) {
      return res.status(400).json({ success: false, error: `Unknown permission code(s): ${invalidCodes.join(', ')}` });
    }

    // Fetch usernames for every selected user in one round trip
    const userReq = pool.request();
    ids.forEach((id, i) => userReq.input(`u${i}`, sql.Int, id));
    const userResult = await userReq.query(`
      SELECT UserID, Username FROM kongsberg.dbo.PortalUsers
      WHERE UserID IN (${ids.map((_, i) => `@u${i}`).join(',')})
    `);
    const userMap = new Map(userResult.recordset.map(r => [r.UserID, r.Username]));

    const results = [];
    for (const userID of ids) {
      const username = userMap.get(userID);
      if (!username) {
        results.push({ userID, username: null, granted: 0, alreadyHad: 0, error: 'User not found' });
        continue;
      }

      let granted = 0, alreadyHad = 0;
      for (const code of codes) {
        try {
          await pool.request()
            .input('userID',      sql.Int,          userID)
            .input('code',        sql.NVarChar(50), code)
            .input('grantedByID', sql.Int,          req.session.user.userID)
            .query(`
              INSERT INTO kongsberg.dbo.PortalUserPermissions (UserID, PermissionCode, GrantedByUserID)
              VALUES (@userID, @code, @grantedByID)
            `);
          granted++;
        } catch (dupErr) {
          if (dupErr.number === 2627 || dupErr.message?.includes('UNIQUE') || dupErr.message?.includes('duplicate')) {
            alreadyHad++;
          } else {
            throw dupErr;
          }
        }
      }
      results.push({ userID, username, granted, alreadyHad });
    }

    const totalGranted = results.reduce((s, r) => s + r.granted, 0);
    const totalAlready = results.reduce((s, r) => s + r.alreadyHad, 0);
    const totalFailed  = results.filter(r => r.error).length;

    await audit('PERM_BULK_GRANT', actor,
      `Granted [${codes.join(', ')}] to ${ids.length} user(s) — ${totalGranted} new grant(s), ${totalAlready} already held` +
      `${totalFailed ? `, ${totalFailed} user(s) not found` : ''}`, req);

    res.json({
      success: true,
      results,
      summary: { users: ids.length, granted: totalGranted, alreadyHad: totalAlready, failed: totalFailed },
    });

  } catch (err) {
    console.error('[admin/users bulk-permissions]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
