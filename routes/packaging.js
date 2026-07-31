// routes/packaging.js
//
// Engineering > Packaging Data — ported from 363_new_packaging.xlsm:
//   - Mass Packaging Update: bulk-set the plant-default packaging instruction
//     assignment for a list of parts.
//   - New Packaging Creation: create the SAP material masters + BOMs for a
//     customer part's packaging materials.
//   - Packaging Instruction Detail: read/save the full packaging instruction
//     for a material (plant-default or per-customer), including quantities
//     and the trace-charge-id flag.
//
// All SAP calls proxy straight through to SapServer's /api/packaging
// controller — same per-file makeSapToken/sapAgent boilerplate as
// staging.js/deliverymain.js/quality.js.
//
// View access = plain Engineering department membership. Every write
// (mass-update, create, save/delete instruction) is genuinely irreversible
// against real SAP master data, so it's gated behind the dedicated
// MASTER_DATA permission on top of that — see sql/migrate_master_data_permission.sql.

import express from 'express';
import sql     from 'mssql';
import axios   from 'axios';
import https   from 'https';
import fs      from 'fs';
import jwt     from 'jsonwebtoken';
import { sapConfig, sapServerSecret, sqlConfig } from '../config.js';
import { requireDepartment, requirePermission } from '../middleware/auth.js';
import { getDecryptedSapCredentials } from '../lib/sapCredentials.js';

const router = express.Router();

const canView  = requireDepartment('engineering');
const canWrite = requirePermission('MASTER_DATA');

// ── SAP caller ────────────────────────────────────────────────────────────────
const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken(userId) {
  return jwt.sign(
    { userId: userId ?? 0 },
    sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

async function sapGet(path, params, userId) {
  const response = await axios.get(`${sapConfig.url}/api/packaging${path}`, {
    params,
    timeout: 30000,
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken(userId)}` },
    validateStatus: () => true, // read 404/403 bodies ourselves instead of throwing
  });
  const body = response.data;
  if (!body.success) {
    const err = new Error(body.error?.message ?? 'SapServer returned success=false');
    err.status = response.status;
    throw err;
  }
  return body.data;
}

async function sapPost(method, path, payload, userId) {
  const response = await axios.request({
    method,
    url: `${sapConfig.url}/api/packaging${path}`,
    data: payload,
    timeout: 120000, // MM01+CS01 batch-input transactions can be slow
    httpsAgent: sapAgent,
    headers: { Authorization: `Bearer ${makeSapToken(userId)}` },
    validateStatus: () => true, // read 422/400 bodies ourselves instead of throwing
  });
  const body = response.data;
  if (!body.success) {
    const err = new Error(body.error?.message ?? 'SapServer returned success=false');
    err.status = response.status;
    throw err;
  }
  return body.data;
}

async function audit(eventType, username, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  username || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
              VALUES (@username, @eventType, @detail, @ip)`);
  } catch (err) {
    console.error('[packaging audit]', err.message);
  }
}

function actor(req) {
  return req.session?.user?.username || 'unknown';
}
function userId(req) {
  return req.session?.user?.userID;
}

// ── Material search (for the Mass Packaging Update lookup list) ───────────────
// Reads the existing daily-synced material master list (dbo.TurnsValClassSnapshot
// — the "mm_turns" list already used by the Stock Turns & Valuation tile in
// Logistics) rather than calling SAP live or duplicating that sync. That route
// is gated behind LOG_MRP (a Logistics permission Engineering users won't
// hold), so this is a thin, read-only, Engineering-gated view over the same
// table instead of reusing the Logistics endpoint directly.

router.get('/materials', canView, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const pool = await sql.connect(sqlConfig);
    const request = pool.request();
    let where = '';
    if (search) {
      where = 'WHERE Material LIKE @search OR MaterialText LIKE @search';
      request.input('search', sql.VarChar(42), `%${search}%`);
    }
    const { recordset } = await request.query(`
      SELECT TOP 200 Material AS material, MaterialText AS materialText
      FROM dbo.TurnsValClassSnapshot
      ${where}
      ORDER BY Material
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Material lookups ─────────────────────────────────────────────────────────

router.get('/material/:material/exists', canView, async (req, res) => {
  try {
    const data = await sapGet(`/${encodeURIComponent(req.params.material)}/exists`, {}, userId(req));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

router.get('/material/:material/description', canView, async (req, res) => {
  try {
    const data = await sapGet(`/${encodeURIComponent(req.params.material)}/description`, {}, userId(req));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

router.get('/material/:material/details', canView, async (req, res) => {
  try {
    const data = await sapGet(`/${encodeURIComponent(req.params.material)}/mara`, {}, userId(req));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

router.get('/material/:material/bom', canView, async (req, res) => {
  try {
    const data = await sapGet(`/${encodeURIComponent(req.params.material)}/bom`, {}, userId(req));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

router.get('/material/:material/customers', canView, async (req, res) => {
  try {
    const data = await sapGet(`/${encodeURIComponent(req.params.material)}/customers`, {}, userId(req));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

// ── Packaging Instruction Detail ("Dialog") ────────────────────────────────

router.get('/material/:material/instruction', canView, async (req, res) => {
  try {
    const data = await sapGet(
      `/${encodeURIComponent(req.params.material)}/instruction`,
      { customer: req.query.customer || undefined },
      userId(req));
    res.json({ success: true, data });
  } catch (err) {
    // 404 from SapServer (no row yet) isn't an error — the Dialog UI treats it as "not yet set up".
    if (err.message?.includes('No ') || err.status === 404) {
      return res.json({ success: true, data: null });
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/instruction', canWrite, async (req, res) => {
  try {
    const {
      material, customer, sqlAction, packMaterial, palletQty, smallBoxQty,
      packProd, boxGen, batchSpread, partMix, chargeReq, techStatReq, pNumReq,
    } = req.body;

    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }

    const data = await sapPost('put', '/instruction', {
      Material: material,
      Customer: customer || null,
      SqlAction: sqlAction || 'U',
      PackMaterial: packMaterial || null,
      PalletQty: Number(palletQty) || 0,
      SmallBoxQty: Number(smallBoxQty) || 0,
      PackProd: !!packProd,
      BoxGen: !!boxGen,
      BatchSpread: !!batchSpread,
      PartMix: !!partMix,
      ChargeReq: !!chargeReq,
      TechStatReq: !!techStatReq,
      PNumReq: !!pNumReq,
    }, userId(req));

    await audit('PACKAGING_INSTRUCTION_SAVED', actor(req),
      `${material}${customer ? ` / ${customer}` : ' (plant default)'} — pack material ${packMaterial || '(unchanged)'}`, req);

    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status === 422 ? 422 : 500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/instruction', canWrite, async (req, res) => {
  try {
    const { material, customer } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }

    const data = await sapPost('delete', '/instruction', { Material: material, Customer: customer || null }, userId(req));

    await audit('PACKAGING_INSTRUCTION_DELETED', actor(req),
      `${material}${customer ? ` / ${customer}` : ' (plant default)'}`, req);

    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status === 422 ? 422 : 500).json({ success: false, error: { message: err.message } });
  }
});

// ── Mass Packaging Update ──────────────────────────────────────────────────

router.post('/mass-update', canWrite, async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'rows must be a non-empty array.' } });
    }
    for (const row of rows) {
      if (!row.material || !row.packMaterial) {
        return res.status(400).json({ success: false, error: { message: 'Each row needs material and packMaterial.' } });
      }
    }

    const data = await sapPost('post', '/mass-update', {
      Rows: rows.map(r => ({ Material: r.material, PackMaterial: r.packMaterial })),
    }, userId(req));

    const okCount = data.filter(r => r.success).length;
    await audit('PACKAGING_MASS_UPDATE', actor(req), `${okCount}/${rows.length} materials updated`, req);

    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

// ── New Packaging Creation ─────────────────────────────────────────────────
// Runs under the CALLING USER's own SAP credentials, not the shared service
// account — MM01 (create material) and CS01 (create BOM) need real SAP
// authorization the service account doesn't have (and isn't being given),
// same reasoning as shipmentcost.js's post-migo flow. The caller must have
// already saved their SAP username/password via My Account (POST
// /api/profile/sap-credentials, see lib/sapCredentials.js); if not, this
// fails fast with a clear message rather than a confusing SAP logon error.
// Calls SapServer's elevated POST /api/packaging/create-elevated (mirrors
// PurchasingController's create-po-elevated pattern) instead of the plain
// /create endpoint.

router.post('/create', canWrite, async (req, res) => {
  try {
    const { customerPart, codes } = req.body;
    if (!customerPart || !String(customerPart).trim()) {
      return res.status(400).json({ success: false, error: { message: 'customerPart is required.' } });
    }

    const sapCreds = await getDecryptedSapCredentials(userId(req));
    if (!sapCreds) {
      return res.status(400).json({
        success: false,
        error: { message: 'You need to save your SAP username and password in My Account before creating packaging materials in SAP.' },
      });
    }

    const data = await sapPost('post', '/create-elevated', {
      SapUsername:  sapCreds.sapUsername,
      SapPassword:  sapCreds.sapPassword,
      CustomerPart: customerPart,
      Codes: Array.isArray(codes) ? codes : [],
    }, userId(req));

    const createdCount = data.filter(r => r.materialCreated).length;
    await audit('PACKAGING_MATERIALS_CREATED', actor(req), `${customerPart} — ${createdCount} materials created`, req);

    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

export default router;
