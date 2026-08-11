// ── Self-service account settings ───────────────────────────────────────────
// Currently just "My SAP Credentials" — see lib/sapCredentials.js for why
// this exists (elevated SAP operations like PO creation need to run under
// the real user's own SAP authorization, since the shared service account
// doesn't have those rights). Self-service only: a user can only ever
// read/set/clear their OWN credentials — there is deliberately no
// admin-facing "set this for someone else" route, since nobody but the
// account owner should ever type in their SAP password.
import express from 'express';
import bcrypt  from 'bcrypt';
import sql     from 'mssql';
import { requireLogin } from '../middleware/auth.js';
import { getSapCredentialStatus, setSapCredentials, clearSapCredentials } from '../lib/sapCredentials.js';
import { auditQuery, getNexusPool } from '../config.js';

const router = express.Router();

router.get('/sap-credentials', requireLogin, async (req, res) => {
  try {
    const status = await getSapCredentialStatus(req.session.user.userID);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sap-credentials', requireLogin, async (req, res) => {
  try {
    const sapUsername = String(req.body.sapUsername || '').trim();
    const sapPassword = String(req.body.sapPassword || '');
    if (!sapUsername || !sapPassword) {
      return res.status(400).json({ success: false, error: 'SAP username and password are both required.' });
    }
    await setSapCredentials(req.session.user.userID, sapUsername, sapPassword);
    await auditQuery('SAP_CRED_SET', req.session.user.username, `Set SAP username '${sapUsername}'`, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/sap-credentials', requireLogin, async (req, res) => {
  try {
    await clearSapCredentials(req.session.user.userID);
    await auditQuery('SAP_CRED_CLEAR', req.session.user.username, 'Cleared SAP credentials', req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /change-password ───────────────────────────────────────────────────
// Self-service password change — same principle as the SAP credential
// routes above: acts only on req.session.user.userID, never a body/param
// supplied ID. Also clears MustChangePassword (set on accounts created via
// the superadmin bulk-create tool — see routes/useradmin.js's
// POST /users/bulk-create — with a known shared initial password), both on
// the row and on the live session, so server.js's /private/:page redirect
// gate stops blocking this user for the rest of their current session.
router.post('/change-password', requireLogin, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword     = String(req.body.newPassword || '');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password are both required.' });
    }
    if (newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 10 characters with one uppercase letter and one number.',
      });
    }

    const pool   = await getNexusPool();
    const userID = req.session.user.userID;

    const current = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`SELECT PasswordHash FROM dbo.PortalUsers WHERE UserID = @userID`);

    const row = current.recordset[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const currentValid = await bcrypt.compare(currentPassword, row.PasswordHash);
    if (!currentValid) {
      await auditQuery('PASSWORD_CHANGE', req.session.user.username, 'Failed — incorrect current password', req);
      return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ success: false, error: 'New password must be different from your current password.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await pool.request()
      .input('userID', sql.Int, userID)
      .input('hash',   sql.NVarChar(256), hash)
      .query(`
        UPDATE dbo.PortalUsers
        SET PasswordHash = @hash, MustChangePassword = 0
        WHERE UserID = @userID
      `);

    req.session.user.mustChangePassword = false;

    await auditQuery('PASSWORD_CHANGE', req.session.user.username, 'Password changed', req);
    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
