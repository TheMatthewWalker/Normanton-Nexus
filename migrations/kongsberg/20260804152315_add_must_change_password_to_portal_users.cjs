'use strict';
// Adds MustChangePassword to PortalUsers — set true for accounts created
// with a known/shared initial password (the superadmin bulk-create tool,
// routes/useradmin.js's POST /users/bulk-create). Read at login into
// req.session.user.mustChangePassword; server.js's /private/:page route
// redirects any page other than landing.html back to landing while the
// flag is set, and landing.js shows a blocking "change your password"
// modal there. Cleared by a successful POST /api/profile/change-password.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE  object_id = OBJECT_ID(N'dbo.PortalUsers')
        AND  name      = N'MustChangePassword'
    )
      ALTER TABLE dbo.PortalUsers
        ADD MustChangePassword BIT NOT NULL DEFAULT 0
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE  object_id = OBJECT_ID(N'dbo.PortalUsers')
        AND  name      = N'MustChangePassword'
    )
      ALTER TABLE dbo.PortalUsers
        DROP COLUMN MustChangePassword
  `);
};
