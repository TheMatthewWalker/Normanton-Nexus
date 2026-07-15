/**
 * routes/auth.js
 *
 * Authentication routes for the Kongsberg Portal.
 *
 * POST /login        — authenticate with username + password
 * GET  /logout       — destroy session and redirect to login
 * POST /register     — submit a registration request (pending admin approval)
 * GET  /session-check — returns current session info as JSON
 *
 * Mount in server.js (no requireLogin — these are public):
 *   import authRoutes from './routes/auth.js';
 *   app.use('/', authRoutes);
 */

import express      from 'express';
import bcrypt       from 'bcrypt';
import sql          from 'mssql';
import rateLimit    from 'express-rate-limit';
import { sqlConfig } from '../config.js';
import { notify }    from '../lib/notify.js';

const router = express.Router();

// ── Rate limiter — max 10 login attempts per 15 minutes per IP ────────────────
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler: (req, res) => {
    res.redirect('/?error=too_many_attempts');
  },
});

// ── Helper — write to audit log ───────────────────────────────────────────────
async function audit(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username  || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail    || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    // Audit failure should never crash the request — just log to console
    console.error('[audit]', err.message);
  }
}

// ── POST /login ───────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.redirect('/?error=missing_fields');
  }

  try {
    const pool = await sql.connect(sqlConfig);

    // Fetch user + their permitted departments in one go
    const userResult = await pool.request()
      .input('username', sql.NVarChar(80), username.trim())
      .query(`
        SELECT
          u.UserID, u.Username, u.Email, u.PasswordHash,
          u.Role, u.IsActive, u.IsLocked, u.FailedLogins
        FROM kongsberg.dbo.PortalUsers u
        WHERE u.Username = @username
      `);

    const user = userResult.recordset[0];

    // ── Unknown user — use a fake compare to prevent timing attacks ──────────
    if (!user) {
      await bcrypt.compare(password, '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      await audit('LOGIN_FAIL', username, 'Unknown username', req);
      return res.redirect('/?error=invalid_credentials');
    }

    // ── Account checks before password verification ───────────────────────────
    if (!user.IsActive) {
      await audit('LOGIN_FAIL', username, 'Account pending approval', req);
      return res.redirect('/?error=pending_approval');
    }

    if (user.IsLocked) {
      await audit('LOGIN_FAIL', username, 'Account locked', req);
      return res.redirect('/?error=account_locked');
    }

    // ── Password check ────────────────────────────────────────────────────────
    const passwordValid = await bcrypt.compare(password, user.PasswordHash);

    if (!passwordValid) {
      // Increment failed login counter — lock after 10 consecutive failures
      const newFailCount = user.FailedLogins + 1;
      const shouldLock   = newFailCount >= 10;

      await pool.request()
        .input('userID',      sql.Int, user.UserID)
        .input('failedLogins', sql.Int, newFailCount)
        .input('isLocked',    sql.Bit, shouldLock ? 1 : 0)
        .query(`
          UPDATE kongsberg.dbo.PortalUsers
          SET FailedLogins = @failedLogins, IsLocked = @isLocked
          WHERE UserID = @userID
        `);

      await audit('LOGIN_FAIL', username,
        shouldLock ? 'Account locked after 10 failures' : `Failed attempt ${newFailCount}`,
        req
      );
      return res.redirect('/?error=invalid_credentials');
    }

    // ── Success — fetch departments and permissions ───────────────────────────
    const [deptResult, permResult] = await Promise.all([
      pool.request().input('userID', sql.Int, user.UserID)
        .query(`SELECT Department FROM kongsberg.dbo.PortalUserDepartments WHERE UserID = @userID`),
      pool.request().input('userID', sql.Int, user.UserID)
        .query(`SELECT PermissionCode FROM kongsberg.dbo.PortalUserPermissions WHERE UserID = @userID`)
        .catch(() => ({ recordset: [] })), // graceful if table doesn't exist yet
    ]);

    const departments = deptResult.recordset.map(r => r.Department);
    const permissions = permResult.recordset.map(r => r.PermissionCode);

    // Reset failed login counter, update LastLogin
    await pool.request()
      .input('userID', sql.Int, user.UserID)
      .query(`
        UPDATE kongsberg.dbo.PortalUsers
        SET FailedLogins = 0, IsLocked = 0, LastLogin = GETDATE()
        WHERE UserID = @userID
      `);

    await audit('LOGIN_OK', username, null, req);

    // ── Regenerate session ID to prevent session fixation ─────────────────────
    req.session.regenerate(err => {
      if (err) {
        console.error('[login] session regenerate error:', err);
        return res.redirect('/?error=server_error');
      }

      req.session.user = {
        userID:      user.UserID,
        username:    user.Username,
        email:       user.Email,
        role:        user.Role,
        departments,
        permissions,
      };

      res.redirect('/private/landing.html');
    });

  } catch (err) {
    console.error('[login]', err.message);
    res.redirect('/?error=server_error');
  }
});

// ── GET /logout ───────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  const username = req.session?.user?.username;
  req.session.destroy(async () => {
    if (username) await audit('LOGOUT', username, null, req);
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

// ── POST /register ────────────────────────────────────────────────────────────
// Submits a registration request. Account is created with IsActive = 0
// (pending approval). An admin must approve it before the user can log in.

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      5,                // max 5 registration attempts per IP per hour
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many registration attempts. Try again later.' });
  },
});

router.post('/register', registerLimiter, async (req, res) => {
  const { firstName, lastName, email, password, confirmPassword } = req.body;

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!firstName || !lastName || !email || !password || !confirmPassword) {
    return res.status(400).json({ success: false, error: 'All fields are required.' });
  }

  const firstClean = firstName.trim();
  const lastClean  = lastName.trim();
  const emailClean = email.trim().toLowerCase();

  if (firstClean.length < 1 || firstClean.length > 80 || lastClean.length < 1 || lastClean.length > 80) {
    return res.status(400).json({ success: false, error: 'First and last name must be 1–80 characters.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    return res.status(400).json({ success: false, error: 'Invalid email address.' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, error: 'Passwords do not match.' });
  }

  if (password.length < 10 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 10 characters with one uppercase letter and one number.',
    });
  }

  try {
    const pool = await sql.connect(sqlConfig);

    // ── Check for existing email ──────────────────────────────────────────────
    const emailCheck = await pool.request()
      .input('email', sql.NVarChar(160), emailClean)
      .query(`SELECT 1 FROM kongsberg.dbo.PortalUsers WHERE Email = @email`);

    if (emailCheck.recordset.length > 0) {
      return res.status(409).json({ success: false, error: 'That email address is already registered.' });
    }

    // ── Generate unique username: firstname.lastname[.N] ─────────────────────
    const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const base = `${slug(firstClean)}.${slug(lastClean)}`;

    let username = base;
    let suffix   = 1;
    while (true) {
      const taken = await pool.request()
        .input('u', sql.NVarChar(80), username)
        .query(`SELECT 1 FROM kongsberg.dbo.PortalUsers WHERE Username = @u`);
      if (!taken.recordset.length) break;
      suffix++;
      username = `${base}.${suffix}`;
    }

    // ── Hash password and insert ──────────────────────────────────────────────
    const hash = await bcrypt.hash(password, 12);

    await pool.request()
      .input('username',  sql.NVarChar(80),  username)
      .input('firstName', sql.NVarChar(80),  firstClean)
      .input('lastName',  sql.NVarChar(80),  lastClean)
      .input('email',     sql.NVarChar(160), emailClean)
      .input('hash',      sql.NVarChar(256), hash)
      .query(`INSERT INTO kongsberg.dbo.PortalUsers
                (Username, FirstName, LastName, Email, PasswordHash, Role, IsActive)
              VALUES (@username, @firstName, @lastName, @email, @hash, 'operator', 0)`);

    await audit('REGISTER', username, `Registration request submitted by ${firstClean} ${lastClean} — pending approval`, req);

    sql.connect(sqlConfig).then(pool => notify(pool, {
      title:       'New User Registration',
      body:        `${firstClean} ${lastClean} (${username}) has requested an account — pending approval.`,
      severity:    1,
      category:    'system',
      actionLabel: 'Review Users',
      actionURL:   '/private/admin.html',
      target:      { type: 'role', value: 'admin' },
    })).catch(() => {});

    res.json({
      success: true,
      message: `Registration request submitted. Your username will be <strong>${username}</strong>. An administrator will review your account.`,
    });

  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// ── GET /session-check ────────────────────────────────────────────────────────
// Returns current session state as JSON — used by front-end JS.
router.get('/session-check', (req, res) => {
  const user = req.session?.user;
  if (!user) return res.json({ loggedIn: false });

  res.json({
    loggedIn:    true,
    username:    user.username,
    role:        user.role,
    departments: user.departments,
    permissions: user.permissions || [],
  });
});

export default router;