/**
 * lib/sapCredentials.js
 *
 * Encrypts/decrypts each portal user's own SAP username+password at rest in
 * kongsberg.dbo.PortalUsers (SapUsername / SapPasswordEncrypted — see
 * sql/migrate_sap_user_credentials.sql).
 *
 * WHY THIS EXISTS: elevated SAP operations (PO creation + goods receipt, see
 * SapServer's PurchasingController) need to run under the real user's own
 * SAP authorization, not the shared service account — the service account
 * doesn't have (and per the user, isn't going to be given) rights to create
 * POs. SapServer's connection pool has a small number of "elevated" worker
 * slots that log on with a specific user's credentials for one request, then
 * log off (see SapServer's SapConnectionPool/SapStaWorker) — this module is
 * what supplies those credentials.
 *
 * WHY DECRYPTION HAPPENS HERE, NOT IN SapServer: SapServer cannot reliably
 * reach this SQL Server 2005 database itself — its own direct SQL path
 * (PermissionService, used for RFC-function permission checks) hits a TLS
 * version SQL Server 2005 doesn't support, which is exactly why
 * AuthOptions.BypassPermissions exists as an escape hatch there. This app
 * (Node/"sql2005-bridge") already has a working, reliable SQL connection to
 * kongsberg used by everything else — so the encrypted password is decrypted
 * here, in memory, immediately before an elevated SAP call, and sent to
 * SapServer over the existing TLS-pinned HTTPS connection for that one
 * request only. It is never sent to the browser and never logged.
 *
 * bcrypt (used for portal login passwords elsewhere in this app) is
 * deliberately NOT used here — it's a one-way hash, and SAP needs the actual
 * plaintext password back at logon time. AES-256-GCM is used instead:
 * authenticated encryption, so a corrupted/tampered ciphertext fails loudly
 * (GCM auth tag) rather than silently decrypting to garbage.
 */

import crypto from 'crypto';
import sql from 'mssql';
import { sqlConfig, sapCredEncryptionKey } from '../config.js';

const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH    = 12; // GCM standard nonce size
const KEY_LENGTH    = 32; // AES-256

function resolveKey() {
  if (!sapCredEncryptionKey) {
    throw new Error(
      'SAP_CRED_ENCRYPTION_KEY env var is not set — cannot save or use SAP credentials. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(sapCredEncryptionKey, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`SAP_CRED_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (a 64-character hex string) — got ${key.length}.`);
  }
  return key;
}

// Packed format: base64(IV[12] || authTag[16] || ciphertext)
export function encryptSapPassword(plaintext) {
  const key = resolveKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSapPassword(packed) {
  const key = resolveKey();
  const buf = Buffer.from(packed, 'base64');
  const iv        = buf.subarray(0, IV_LENGTH);
  const authTag   = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = buf.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ── DB helpers ───────────────────────────────────────────────────────────────

// Returns { sapUsername, hasCredentials, updatedAt } — never the password.
// Used by the profile UI to show current status without ever round-tripping
// the secret.
export async function getSapCredentialStatus(userId) {
  const pool = await sql.connect(sqlConfig);
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT SapUsername, SapPasswordEncrypted, SapCredentialUpdatedAt
            FROM kongsberg.dbo.PortalUsers WHERE UserID = @userId`);
  const row = result.recordset[0];
  return {
    sapUsername:    row?.SapUsername || null,
    hasCredentials: !!(row?.SapUsername && row?.SapPasswordEncrypted),
    updatedAt:      row?.SapCredentialUpdatedAt || null,
  };
}

// Encrypts and stores — self-service only, caller must have already
// confirmed this is the logged-in user's own account (see routes/profile.js).
export async function setSapCredentials(userId, sapUsername, sapPassword) {
  const encrypted = encryptSapPassword(sapPassword);
  const pool = await sql.connect(sqlConfig);
  await pool.request()
    .input('userId',    sql.Int,          userId)
    .input('username',  sql.NVarChar(40), String(sapUsername).trim())
    .input('encrypted', sql.NVarChar(400), encrypted)
    .query(`UPDATE kongsberg.dbo.PortalUsers
            SET SapUsername = @username,
                SapPasswordEncrypted = @encrypted,
                SapCredentialUpdatedAt = GETUTCDATE()
            WHERE UserID = @userId`);
}

export async function clearSapCredentials(userId) {
  const pool = await sql.connect(sqlConfig);
  await pool.request()
    .input('userId', sql.Int, userId)
    .query(`UPDATE kongsberg.dbo.PortalUsers
            SET SapUsername = NULL, SapPasswordEncrypted = NULL, SapCredentialUpdatedAt = NULL
            WHERE UserID = @userId`);
}

// Decrypts and returns { sapUsername, sapPassword } for use in a single
// elevated SAP call, or null if the user hasn't configured credentials yet.
// Never cache this return value beyond the one request it's used for.
export async function getDecryptedSapCredentials(userId) {
  const pool = await sql.connect(sqlConfig);
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT SapUsername, SapPasswordEncrypted
            FROM kongsberg.dbo.PortalUsers WHERE UserID = @userId`);
  const row = result.recordset[0];
  if (!row?.SapUsername || !row?.SapPasswordEncrypted) return null;

  return {
    sapUsername: row.SapUsername,
    sapPassword: decryptSapPassword(row.SapPasswordEncrypted),
  };
}
