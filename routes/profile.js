// ── Self-service account settings ───────────────────────────────────────────
// Currently just "My SAP Credentials" — see lib/sapCredentials.js for why
// this exists (elevated SAP operations like PO creation need to run under
// the real user's own SAP authorization, since the shared service account
// doesn't have those rights). Self-service only: a user can only ever
// read/set/clear their OWN credentials — there is deliberately no
// admin-facing "set this for someone else" route, since nobody but the
// account owner should ever type in their SAP password.
import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { getSapCredentialStatus, setSapCredentials, clearSapCredentials } from '../lib/sapCredentials.js';
import { auditQuery } from '../config.js';

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

export default router;
