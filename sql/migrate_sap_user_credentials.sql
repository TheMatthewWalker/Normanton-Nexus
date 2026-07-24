/* ============================================================
   Per-user SAP credentials — for elevated SAP operations (PO creation +
   goods receipt) that must run under the real user's own SAP authorization
   rather than the shared service account. Run against the kongsberg
   database. SQL Server 2005 compatible (no GO needed, no CONCAT()).

   Self-service only: a user sets/updates their own SapUsername/password
   from their own account settings (see routes/profile.js) — nobody else,
   including admins, ever sees or enters another user's SAP password.

   SapPasswordEncrypted stores IV + ciphertext + auth tag (AES-256-GCM,
   base64), never the plaintext password — see lib/sapCredentials.js for
   the encrypt/decrypt helper. The encryption key lives in an env var
   (SAP_CRED_ENCRYPTION_KEY), never in this database.

   These credentials are decrypted in Node (this app) immediately before an
   elevated SAP call and sent to SapServer over the existing TLS-pinned
   connection for that one request only — SapServer cannot reach this
   database itself (SQL Server 2005 / modern TLS incompatibility, see
   AuthOptions.BypassPermissions and PermissionService in SapServer), so
   credential lookup/decryption has to happen on this side, not SapServer's.
   ============================================================ */

IF COL_LENGTH('dbo.PortalUsers', 'SapUsername') IS NULL
  ALTER TABLE dbo.PortalUsers ADD SapUsername NVARCHAR(40) NULL;

IF COL_LENGTH('dbo.PortalUsers', 'SapPasswordEncrypted') IS NULL
  ALTER TABLE dbo.PortalUsers ADD SapPasswordEncrypted NVARCHAR(400) NULL;

IF COL_LENGTH('dbo.PortalUsers', 'SapCredentialUpdatedAt') IS NULL
  ALTER TABLE dbo.PortalUsers ADD SapCredentialUpdatedAt DATETIME NULL;

PRINT 'PortalUsers SAP credential columns verified/added';

/* ── Verify ───────────────────────────────────────────────────────────── */

SELECT COUNT(*) AS UsersWithSapCredentials
FROM dbo.PortalUsers
WHERE SapUsername IS NOT NULL AND SapPasswordEncrypted IS NOT NULL;
