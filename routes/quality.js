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
import { sapConfig, sapServerSecret } from '../config.js';
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
// Username is taken from the portal session and injected into the SAP body as
// QualityMb1bRequest.Username — the frontend never sends it.
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

// ── POST /bulk ─────────────────────────────────────────────────────────────────
// Accepts an array of stock rows and a direction ('block' | 'unblock').
// Processes each row sequentially against the SAP server and streams progress
// back as Server-Sent Events so the browser can update a live progress bar.
router.post('/bulk', requirePermission('QUAL_BLOCKING'), async (req, res) => {
  const { rows, direction, header } = req.body;

  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, error: 'No rows provided.' });
  }
  if (!['block', 'unblock'].includes(direction)) {
    return res.status(400).json({ success: false, error: 'Invalid direction.' });
  }

  const username = req.session.user.username;

  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no'); // prevent nginx buffering

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', total: rows.length });

  const WM = new Set(['1710', '1711']);

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const sloc = String(row['Storage Loc'] || '').trim();
    const isWM = WM.has(sloc);

    // Parse SAP-format quantity (e.g. "10.875,000" → 10875)
    const rawQty = String(row['Qty'] || '0').trim();
    const qty    = rawQty.includes(',')
      ? parseFloat(rawQty.replace(/\./g, '').replace(',', '.'))
      : parseFloat(rawQty.replace(/\./g, '')) || 0;

    const body = {
      Material:              (row['Material'] || '').trim(),
      Quantity:              qty || 1,
      Header:                header || 'Bulk operation',
      StorageLocation:       sloc,
      BinType:               isWM ? (row['Storage Type'] || '') : '',
      Bin:                   isWM ? (row['Storage Bin']  || '') : '',
      Batch:                 row['Batch'] || null,
      SpecialStockIndicator: row['Spc Stock']    || '',
      SpecialStockNumber:    row['Spc Stock No'] || '',
      Username:              username,
    };

    try {
      const response = await axios.post(
        `${sapConfig.url}/api/quality/${direction}`,
        body,
        { timeout: 60000, httpsAgent: sapAgent, headers: sapHeaders() }
      );
      const d   = response.data?.data;
      const msg = d?.mb1bMessage || d?.toBlockedMessage || d?.toNonBlockedMessage || 'Posted';
      send({ type: 'progress', done: i + 1, total: rows.length, success: true,
             material: body.Material, message: msg });
    } catch (err) {
      const d   = err.response?.data;
      const msg = (typeof d === 'string' ? d : null)
               || d?.error || d?.message || d?.title || err.message;
      send({ type: 'progress', done: i + 1, total: rows.length, success: false,
             material: body.Material, error: msg });
    }
  }

  send({ type: 'complete', total: rows.length });
  res.end();
});

export default router;
