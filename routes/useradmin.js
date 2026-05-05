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
 */

import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../server.js';

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
          IsActive, IsLocked, FailedLogins,
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

  const { role, isActive, isLocked, notes, departments } = req.body;

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }
  if (departments && !departments.every(d => VALID_DEPTS.includes(d))) {
    return res.status(400).json({ success: false, error: 'Invalid department in list' });
  }

  try {
    const pool = await sql.connect(sqlConfig);

    const current = await pool.request()
      .input('userID', sql.Int, userID)
      .query('SELECT Username, Role, IsActive, IsLocked FROM kongsberg.dbo.PortalUsers WHERE UserID = @userID');

    if (!current.recordset[0]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const prev = current.recordset[0];

    const actorRole  = req.session.user.role;
    const actorLevel = ROLE_LEVEL[actorRole] ?? 0;
    const targetLevel = ROLE_LEVEL[prev.Role] ?? 0;

    if (actorRole !== 'superadmin') {
      // Admin can only edit users with a strictly lower role level
      if (targetLevel >= actorLevel) {
        return res.status(403).json({
          success: false,
          error: 'You cannot edit a user with an equal or higher role.',
        });
      }
      // Admin can only assign roles strictly below their own level
      if (role && (ROLE_LEVEL[role] ?? 0) >= actorLevel) {
        return res.status(403).json({
          success: false,
          error: 'You cannot assign a role equal to or higher than your own.',
        });
      }
    }

    await pool.request()
      .input('userID',   sql.Int,          userID)
      .input('role',     sql.NVarChar(20),  role     ?? prev.Role)
      .input('isActive', sql.Bit,           isActive ?? prev.IsActive)
      .input('isLocked', sql.Bit,           isLocked ?? prev.IsLocked)
      .input('notes',    sql.NVarChar(500), notes    ?? null)
      .query(`
        UPDATE kongsberg.dbo.PortalUsers
        SET Role     = @role,
            IsActive = @isActive,
            IsLocked = @isLocked,
            Notes    = @notes,
            FailedLogins = CASE WHEN @isLocked = 0 THEN 0 ELSE FailedLogins END
        WHERE UserID = @userID
      `);

    if (Array.isArray(departments)) {
      await pool.request()
        .input('userID', sql.Int, userID)
        .query('DELETE FROM kongsberg.dbo.PortalUserDepartments WHERE UserID = @userID');

      for (const dept of departments) {
        await pool.request()
          .input('userID',    sql.Int,         userID)
          .input('dept',      sql.NVarChar(50), dept)
          .input('grantedBy', sql.NVarChar(80), req.session.user.username)
          .query(`
            INSERT INTO kongsberg.dbo.PortalUserDepartments (UserID, Department, GrantedBy)
            VALUES (@userID, @dept, @grantedBy)
          `);
      }
    }

    const actor = req.session.user.username;
    if (role && role !== prev.Role) {
      await audit('ROLE_CHANGE', actor,
        `Changed ${prev.Username} role: ${prev.Role} → ${role}`, req);
    }
    if (Array.isArray(departments)) {
      await audit('DEPT_CHANGE', actor,
        `Updated ${prev.Username} departments: ${departments.join(', ') || 'none'}`, req);
    }
    if (isLocked !== undefined && !!isLocked !== !!prev.IsLocked) {
      await audit(isLocked ? 'LOCKED' : 'UNLOCKED', actor,
        `${isLocked ? 'Locked' : 'Unlocked'} account: ${prev.Username}`, req);
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

// ── GET /audit ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const { event } = req.query;

  const VALID_EVENTS = [
    'LOGIN_OK','LOGIN_FAIL','LOGOUT','REGISTER',
    'APPROVED','REJECTED','ROLE_CHANGE','DEPT_CHANGE','LOCKED','UNLOCKED',
    'RAW_SQL','RAW_SQL_BLOCKED','RAW_SQL_ERROR',
    'SAP_OK','SAP_ERROR',
    'PERM_GRANT','PERM_REVOKE','PERM_CREATE','PERM_UPDATE','PERM_DELETE',
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

export default router;
