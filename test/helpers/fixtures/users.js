// Canned session-user objects matching the shape middleware/auth.js and
// routes/auth.js's /login handler actually populate onto req.session.user.

export const operatorUser = {
  userID: 101,
  username: 'j.smith',
  email: 'j.smith@example.com',
  role: 'operator',
  departments: ['production'],
  permissions: ['PROD_ENTRY'],
  shortIdleTimeout: false,
};

export const productionSupervisor = {
  userID: 102,
  username: 'l.jones',
  email: 'l.jones@example.com',
  role: 'operator',
  departments: ['production'],
  permissions: ['PROD_SUPERVISOR', 'PROD_ENTRY', 'PROD_DATA'],
  shortIdleTimeout: false,
};

export const adminUser = {
  userID: 201,
  username: 'a.admin',
  email: 'a.admin@example.com',
  role: 'admin',
  departments: ['logistics'],
  permissions: ['LOG_PLANNING'],
  shortIdleTimeout: false,
};

export const superadminUser = {
  userID: 301,
  username: 'root',
  email: 'root@example.com',
  role: 'superadmin',
  departments: [],
  permissions: [],
  shortIdleTimeout: true,
};
