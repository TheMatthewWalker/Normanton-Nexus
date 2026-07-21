/**
 * middleware/auth.js
 *
 * Authentication and authorisation middleware for the Kongsberg Portal.
 *
 * Exports:
 *   requireLogin        — any authenticated user
 *   requireRole(role)   — user must have at least this role level
 *   requireDepartment(dept) — user must have access to this department
 *   requireSessionOrApiToken — session cookie OR bearer token (Excel macro)
 *
 * Role hierarchy (lowest → highest):
 *   operator < admin < superadmin
 *
 * Superadmins bypass all department checks.
 */

import jwt from 'jsonwebtoken';
import { sapServerSecret } from '../config.js';

// ── Role hierarchy ────────────────────────────────────────────────────────────
// operator   — basic site access
// admin      — approve users, assign departments & permissions (cannot promote to admin+)
// superadmin — everything: raw SQL, edit usernames, promote/demote admins
const ROLE_LEVEL = {
  operator:   1,
  admin:      2,
  superadmin: 3,
};

// ── requireLogin ──────────────────────────────────────────────────────────────
// Blocks unauthenticated requests.
// For API routes returns 401 JSON; for page routes redirects to login.

export function requireLogin(req, res, next) {
  if (req.session?.user?.userID) return next();

  const isApiRoute = req.path.startsWith('/api/') || req.xhr ||
                     req.headers.accept?.includes('application/json');

  if (isApiRoute) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  res.redirect('/');
}

// ── requireRole ───────────────────────────────────────────────────────────────
// Returns middleware that checks the user has at least the specified role.
//
// Usage:
//   app.get('/admin', requireLogin, requireRole('admin'), handler)

export function requireRole(minimumRole) {
  return (req, res, next) => {
    const userRole  = req.session?.user?.role;
    const userLevel = ROLE_LEVEL[userRole]  ?? 0;
    const minLevel  = ROLE_LEVEL[minimumRole] ?? 99;

    if (userRole === 'superadmin') return next();
    if (userLevel >= minLevel) return next();

    const isApiRoute = req.path.startsWith('/api/') || req.xhr ||
                       req.headers.accept?.includes('application/json');

    if (isApiRoute) {
      return res.status(403).json({
        success: false,
        error: `Requires role: ${minimumRole}. Your role: ${userRole ?? 'none'}`,
      });
    }
    res.status(403).sendFile('403.html', { root: './public' });
  };
}

// ── requireDepartment ─────────────────────────────────────────────────────────
// Returns middleware that checks the user has access to a specific department.
// Superadmins always pass.
//
// Usage:
//   app.get('/private/production.html', requireLogin, requireDepartment('production'), handler)

export function requireDepartment(department) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.redirect('/');

    // Superadmins have access to everything
    if (user.role === 'superadmin') return next();

    const permitted = Array.isArray(user.departments) &&
                      user.departments.includes(department);

    if (permitted) return next();

    const isApiRoute = req.path.startsWith('/api/') || req.xhr ||
                       req.headers.accept?.includes('application/json');

    if (isApiRoute) {
      return res.status(403).json({
        success: false,
        error: `You do not have access to the ${department} department.`,
      });
    }
    // Redirect back to landing page with a query param so the UI can show a message
    res.redirect('/private/landing.html?denied=' + encodeURIComponent(department));
  };
}

// ── requirePermission ─────────────────────────────────────────────────────────
// Returns middleware that checks the user holds a specific permission code.
// Superadmins bypass all permission checks.
//
// Usage:
//   router.post('/scrap/approve', requirePermission('PROD_SUPERVISOR'), handler)

export function requirePermission(permissionCode) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    if (user.role === 'superadmin') return next();

    const userPerms = Array.isArray(user.permissions) ? user.permissions : [];
    if (userPerms.includes(permissionCode)) return next();

    return res.status(403).json({
      success: false,
      error: `Requires permission: ${permissionCode}`,
    });
  };
}

// ── roleLevel ─────────────────────────────────────────────────────────────────
// Utility — exported so routes can compare levels without importing the map.
export function roleLevel(role) {
  return ROLE_LEVEL[role] ?? 0;
}

// ── requireSessionOrApiToken ────────────────────────────────────────────────
// For routes that need to work both from the logged-in web page (normal
// session cookie, like everything else in this app) AND from the Month End
// Breakdown Excel macro (routes/performance.js's upload-notes route), which
// has no cookie jar to carry a session — it authenticates once via
// POST /api/auth/orderbook-token (routes/auth.js) and sends the resulting
// short-lived JWT as `Authorization: Bearer <token>` instead.
//
// Whichever path succeeds, the handler reads req.uploadUser = { userID,
// username } the same way either way, so it never needs to know which
// route the caller came in by.
export function requireSessionOrApiToken(req, res, next) {
  if (req.session?.user?.userID) {
    req.uploadUser = { userID: req.session.user.userID, username: req.session.user.username };
    return next();
  }

  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, sapServerSecret, {
        issuer: 'kongsberg-portal',
        audience: 'orderbook-notes-upload',
      });
      req.uploadUser = { userID: payload.userId, username: payload.username };
      return next();
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired upload token — please log in again from the button on the Dashboard tab.' });
    }
  }

  res.status(401).json({ success: false, error: 'Not authenticated.' });
}