/**
 * routes/bapiInspector.js
 * Kongsberg Portal — BAPI/RFC Structure Inspector (superadmin-only)
 *
 * Lets a superadmin type in any SAP function module/BAPI name and see its
 * real interface — every IMPORT/EXPORT/TABLE/CHANGING parameter, plus the
 * field list for any structured (non-scalar) parameter — straight from SAP
 * itself via RFC_GET_FUNCTION_INTERFACE + DDIF_FIELDINFO_GET (SapServer's
 * existing GET /api/function/params, Controllers/FunctionController.cs —
 * this route is a thin superadmin-gated proxy in front of it, same shape as
 * routes/sap.js's other SapServer proxies).
 *
 * Why this exists: several SapServer RFC/BAPI request builders were written
 * against the *standard documented* shape of a BAPI (no SAP GUI available on
 * a dev machine to confirm field-for-field against the real system — see
 * PurchasingHelper.BuildPoGetPriceRequest's own UNVERIFIED header comment,
 * which guessed BAPI_PO_GETDETAIL1's ITEM_CONDITIONS parameter and crashed
 * for real in production). This tool lets a superadmin confirm or correct a
 * guessed parameter/table name against the live SAP system directly from the
 * portal, instead of needing SAP GUI's own SE37 access.
 *
 * Gated the same way as routes/dbexplorer.js: role-based (superadmin), not
 * department/permission-code based — this reaches arbitrary SAP function
 * metadata, the SAP-side equivalent of dbexplorer's arbitrary SQL schema
 * browsing, so it gets the same "superadmin only, always audited" treatment
 * rather than routes/sap.js's more common per-department requirePermission
 * gates.
 */

import express from 'express';
import axios   from 'axios';
import https   from 'https';
import jwt     from 'jsonwebtoken';
import fs      from 'fs';
import { sapConfig, sapServerSecret, auditQuery } from '../config.js';

const router = express.Router();

// Same TLS-pinned Node->SapServer setup used by routes/sap.js and
// routes/performance.js — see those files' own comments for why a pinned
// cert is used here instead of the system trust store.
const sapCertPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(sapCertPath)
  ? new https.Agent({ ca: fs.readFileSync(sapCertPath), rejectUnauthorized: true })
  : null;

function makeSapToken(userId) {
  return jwt.sign({ userId: userId ?? 0 }, sapServerSecret,
    { issuer: 'normanton-nexus', audience: 'sap-server', expiresIn: '60s' });
}

function requireSuperadmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Requires superadmin role.' });
}
router.use(requireSuperadmin);

// ---------------------------------------------------------------------------
// POST /api/admin/bapi-inspector/lookup
//
// Body: { functionName }. Proxies to SapServer's GET /api/function/params —
// a GET with a JSON body (unusual, but that's the real shape
// FunctionController.GetFunctionParams exposes; axios is told the method
// explicitly rather than using the .get() shorthand so the body is sent
// unambiguously regardless of axios version).
// ---------------------------------------------------------------------------
router.post('/lookup', async (req, res) => {
  const functionName = (req.body?.functionName || '').trim();
  if (!functionName) {
    return res.status(400).json({ success: false, error: 'functionName is required.' });
  }

  const username = req.session?.user?.username || null;
  const callerUserId = req.session?.user?.userID;

  try {
    const response = await axios({
      method: 'get',
      url: `${sapConfig.url}/api/function/params`,
      data: { functionName },
      timeout: 60000,
      httpsAgent: sapAgent,
      headers: { Authorization: `Bearer ${makeSapToken(callerUserId)}` },
    });

    const body = response.data;
    if (!body.success) throw new Error(body.error?.message || body.error || 'SapServer returned success=false');

    await auditQuery('SAP_OK', username, `BAPI structure lookup: ${functionName}`, req);
    res.json({ success: true, data: body.data });
  } catch (err) {
    const status  = err.response?.status ?? 500;
    const message = err.response?.data?.error?.message ?? err.response?.data?.error ?? err.message;
    console.error(`[bapiInspector] Lookup failed for '${functionName}':`, message);
    await auditQuery('SAP_ERROR', username, `BAPI structure lookup failed: ${functionName} — ${String(message).slice(0, 200)}`, req);
    res.status(status).json({ success: false, error: message });
  }
});

export default router;
