/**
 * middleware/auth.js
 *
 * Authentication and authorisation middleware for the Kongsberg Portal.
 *
 * Exports:
 *   requireLogin        — any authenticated user
 *   requireRole(role)   — user must have at least this role level
 *   requireDepartment(dept) — user must have access to this department
 *
 * Role hierarchy (lowest → highest):
 *   operator < admin < superadmin
 *
 * Superadmins bypass all department checks.
 */

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