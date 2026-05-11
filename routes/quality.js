/**
 * routes/quality.js
 *
 * Proxies quality endpoints to SapServer.
 * All routes require a valid session (enforced by server.js mount).
 * Block and Unblock additionally require the QUAL_BLOCKING permission.
 *
 * GET  /display   — query quality/blocked stock (StockRow[])
 * POST /block     — block stock via MB1B + transfer orders
 * POST /unblock   — unblock stock via MB1B + transfer orders
 */

import express from 'express';
import axios   from 'axios';
import https   from 'https';
import jwt     from 'jsonwebtoken';
import fs      from 'fs';
import { sapConfig, sapServerSecret } from '../server.js';
import { requirePermission }          from '../middleware/auth.js';

const router = express.Router();

const certPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(certPath)
  ? new https.Agent({ ca: fs.readFileSync(certPath), rejectUnauthorized: true })
  : null;

function makeSapToken() {
  return jwt.sign(
    { userId: 0 },
    sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' }
  );
}

function sapHeaders() {
  return { Authorization: `Bearer ${makeSapToken()}`, 'Content-Type': 'application/json' };
}

function sapError(err, res) {
  const d      = err.response?.data;
  const status = err.response?.status || 502;
  const msg    = (typeof d === 'string' ? d : null)
              || d?.error || d?.message || d?.title
              || (d?.errors ? JSON.stringify(d.errors) : null)
              || err.message;
  res.status(status).json({ success: false, error: msg });
}

// ── GET /display ──────────────────────────────────────────────────────────────
router.get('/display', async (req, res) => {
  try {
    const response = await axios.get(
      `${sapConfig.url}/api/quality/display`,
      { params: req.query, timeout: 30000, httpsAgent: sapAgent, headers: sapHeaders() }
    );
    res.json(response.data);
  } catch (err) { sapError(err, res); }
});

// ── POST /block ───────────────────────────────────────────────────────────────
router.post('/block', requirePermission('QUAL_BLOCKING'), async (req, res) => {
  try {
    const body = { ...req.body, Username: req.session.user.username };
    const response = await axios.post(
      `${sapConfig.url}/api/quality/block`,
      body,
      { timeout: 60000, httpsAgent: sapAgent, headers: sapHeaders() }
    );
    res.json(response.data);
  } catch (err) { sapError(err, res); }
});

// ── POST /unblock ─────────────────────────────────────────────────────────────
router.post('/unblock', requirePermission('QUAL_BLOCKING'), async (req, res) => {
  try {
    const body = { ...req.body, Username: req.session.user.username };
    const response = await axios.post(
      `${sapConfig.url}/api/quality/unblock`,
      body,
      { timeout: 60000, httpsAgent: sapAgent, headers: sapHeaders() }
    );
    res.json(response.data);
  } catch (err) { sapError(err, res); }
});

export default router;
