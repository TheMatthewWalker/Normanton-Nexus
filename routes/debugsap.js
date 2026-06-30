import express from 'express';
import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

import * as sap from './performancesap.js';

const router = express.Router();

const DEBUG_DIR = path.resolve('./debug');

// ✅ ensure folder exists
if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR);
}

// ── helper: write CSV ─────────────────────────────────────

async function writeCsv(filename, rows) {
  if (!rows || rows.length === 0) {
    console.warn(`⚠️ No data for ${filename}`);
    return;
  }

  const headers = Object.keys(rows[0]).map(k => ({
    id: k,
    title: k
  }));

  const writer = createObjectCsvWriter({
    path: path.join(DEBUG_DIR, filename),
    header: headers
  });

  await writer.writeRecords(rows);

  console.log(`✅ CSV saved: ${filename} (${rows.length} rows)`);
}

// ── endpoint ─────────────────────────────────────────────

router.post('/debug-sap-dump', async (req, res) => {
  const results = [];

  async function run(name, fn) {
    try {
      console.log(`▶️ Fetching ${name}...`);

      const data = await fn(req);

      await writeCsv(`${name}.csv`, data);

      results.push({
        dataset: name,
        status: 'success',
        rows: data.length
      });

    } catch (err) {
      console.error(`❌ ${name} failed`, err);

      results.push({
        dataset: name,
        status: 'failed',
        error: err.message
      });
    }
  }

  await run('stock', sap.getStock);
  await run('agreements', sap.getAgreements);
  await run('invoices', sap.getInvoicing);
  await run('otif', sap.getOtif);

  res.json({
    success: true,
    results
  });
});

export default router;