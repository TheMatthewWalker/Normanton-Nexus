/**
 * seed-vendor-materials.js
 *
 * One-time import: creates dbo.Vendor rows for each vendor tab in the existing
 * MRP2.xlsx workbook, and dbo.VendorMaterial rows assigning that vendor's
 * materials — so the new Vendor Master Data admin page (private/logistics.html,
 * "Vendor Master Data" tile) doesn't start completely empty.
 *
 * WHAT THIS DOES NOT SEED:
 * Lead time, Incoterms and MOQ are NOT in MRP2.xlsx at all (checked directly —
 * the sheet has stock/consumption/order history, not vendor contract terms), so
 * those fields are left blank here. Fill them in through the admin page.
 *
 * MATCHING:
 * MRP2.xlsx uses short display material codes (e.g. "30005R", "10006") which may
 * or may not be stored identically in dbo.TurnsValClassSnapshot.Material (SAP's
 * raw MATNR, possibly zero-padded). Rather than guess the padding, this script
 * pulls every distinct Material already in TurnsValClassSnapshot and matches
 * against it in memory:
 *   - exact string match, or
 *   - match after stripping leading zeros from both sides (numeric materials)
 * A code that matches exactly one Material this way is assigned with confidence.
 * A code matching more than one (rare — only if two distinct stored Material
 * values happen to normalise the same way) OR matching none at all is still
 * inserted, but using the literal Excel code as-is and flagged in the console
 * summary as needing a manual check. Either way, VendorMaterial.SourceHint is
 * always set to the original Excel code, and the admin page's material-edit
 * modal surfaces a "seeded from MRP2.xlsx" notice for any row that has one — so
 * nothing seeded here is silently wrong; it's just flagged for a human glance.
 *
 * SAFE TO RE-RUN: skips any vendor+material pairing that's already assigned
 * (checks dbo.VendorMaterial before inserting), and reuses an existing vendor
 * row by name rather than creating a duplicate.
 *
 * Run manually on the server once the SQL migration is in place:
 *   node scripts/seed-vendor-materials.js
 */

import sql from 'mssql';
import { sqlConfig } from '../config.js';

// Extracted directly from MRP2.xlsx's per-vendor tabs (row 1 = material code,
// row 2 = schedule agreement where the sheet tracks one — only Raaj's tab
// exposed schedule agreement numbers in a consistent, extractable place; the
// rest can be filled in by hand via the admin page if/when needed).
const VENDOR_SEED = [
  {
    name: 'Raaj',
    materials: [
      { code: '30005R',    scheduleAgreement: '5500310937' },
      { code: '30006R',    scheduleAgreement: '5500310938' },
      { code: '30007R',    scheduleAgreement: '5500310939' },
      { code: '30008R',    scheduleAgreement: '5500310940' },
      { code: '30009R',    scheduleAgreement: '5500310943' },
      { code: '30011R',    scheduleAgreement: '5500310942' },
      { code: '30012R',    scheduleAgreement: '5500310941' },
      { code: '30017R',    scheduleAgreement: '5500310944' },
      { code: '30019R',    scheduleAgreement: '5500310945' },
      { code: '56-2MM-51', scheduleAgreement: '5500310946' },
    ],
  },
  { name: 'Sprint',      materials: ['30007', '30006', '30005'] },
  { name: 'GFL',         materials: ['10006'] },
  { name: 'Chemours',    materials: ['10000', '10005', '10008'] },
  { name: 'Isopar',      materials: ['10010'] },
  { name: 'Carbon',      materials: ['10026', '10027'] },
  { name: 'DeWAL + 3P',  materials: ['20007', '20008', '20018', '20025', '20026', '20027', '20013', '20014'] },
  { name: 'Fothergill',  materials: ['20003', '20004', '20005'] },
  { name: 'Mylar',       materials: ['30300', '30303', '30304', '30307'] },
  { name: 'Coverline',   materials: ['50000', '50001', '50013', '50017', '50018', '50024'] },
  { name: 'Yarn',        materials: ['30213', '30222', '30200', '30201', '30203'] },
  { name: 'Tube',        materials: ['10033', '10034', '10035', '10030', '10040'] },
].map(v => ({
  ...v,
  // Normalise every vendor's material list to the same {code, scheduleAgreement}
  // shape whether or not it was written with per-material schedule agreements above.
  materials: v.materials.map(m => (typeof m === 'string' ? { code: m } : m)),
}));

function normalise(code) {
  const t = String(code).trim().toUpperCase();
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t;
}

async function findOrCreateVendor(pool, vendorName) {
  const existing = await pool.request()
    .input('name', sql.NVarChar(80), vendorName)
    .query('SELECT VendorId FROM dbo.Vendor WHERE VendorName = @name');
  if (existing.recordset.length) return { vendorId: existing.recordset[0].VendorId, created: false };

  const inserted = await pool.request()
    .input('name', sql.NVarChar(80), vendorName)
    .query('INSERT INTO dbo.Vendor (VendorName) OUTPUT INSERTED.VendorId VALUES (@name)');
  return { vendorId: inserted.recordset[0].VendorId, created: true };
}

async function main() {
  const pool = await sql.connect(sqlConfig);

  console.log('Loading distinct materials from dbo.TurnsValClassSnapshot...');
  const { recordset } = await pool.request().query('SELECT DISTINCT Material FROM dbo.TurnsValClassSnapshot');
  const byNormalised = new Map();
  for (const { Material } of recordset) {
    const key = normalise(Material);
    if (!byNormalised.has(key)) byNormalised.set(key, []);
    byNormalised.get(key).push(Material);
  }
  console.log(`  ${recordset.length} distinct materials loaded.\n`);

  const summary = { confident: [], ambiguous: [], unmatched: [] };

  for (const vendor of VENDOR_SEED) {
    console.log(`=== ${vendor.name} ===`);
    const { vendorId, created } = await findOrCreateVendor(pool, vendor.name);
    console.log(`  ${created ? 'Created' : 'Reusing existing'} vendor (VendorId=${vendorId}).`);

    for (const { code, scheduleAgreement } of vendor.materials) {
      const candidates = byNormalised.get(normalise(code)) || [];

      let material, bucket;
      if (candidates.length === 1) {
        material = candidates[0];
        bucket = 'confident';
      } else if (candidates.length > 1) {
        material = code; // literal fallback — flagged below for a manual check
        bucket = 'ambiguous';
      } else {
        material = code; // literal fallback — no SAP material found at all
        bucket = 'unmatched';
      }

      const already = await pool.request()
        .input('vendorId', sql.Int, vendorId)
        .input('material', sql.NVarChar(18), material)
        .query('SELECT 1 FROM dbo.VendorMaterial WHERE VendorId = @vendorId AND Material = @material');
      if (already.recordset.length) {
        console.log(`  ${code} -> ${material} [${bucket}] — already assigned, skipped.`);
        continue;
      }

      await pool.request()
        .input('vendorId',          sql.Int,          vendorId)
        .input('material',          sql.NVarChar(18), material)
        .input('scheduleAgreement', sql.NVarChar(10), scheduleAgreement || null)
        .input('sourceHint',        sql.NVarChar(40), code)
        .query(`
          INSERT INTO dbo.VendorMaterial (VendorId, Material, ScheduleAgreement, SourceHint)
          VALUES (@vendorId, @material, @scheduleAgreement, @sourceHint)
        `);

      const note = candidates.length > 1 ? ` (${candidates.length} candidates: ${candidates.join(', ')})` : '';
      console.log(`  ${code} -> ${material} [${bucket}]${note}`);
      summary[bucket].push(`${vendor.name}: "${code}" -> "${material}"${note}`);
    }
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`Confident matches:              ${summary.confident.length}`);
  console.log(`Ambiguous (needs manual check):  ${summary.ambiguous.length}`);
  summary.ambiguous.forEach(l => console.log(`  - ${l}`));
  console.log(`Unmatched (needs manual check):  ${summary.unmatched.length}`);
  summary.unmatched.forEach(l => console.log(`  - ${l}`));
  if (summary.ambiguous.length || summary.unmatched.length) {
    console.log('\nFix flagged rows via the Vendor Master Data tile — click the vendor, click the');
    console.log('flagged material, and use the "seeded from MRP2.xlsx" notice as your cue to');
    console.log('remove/reassign it via the material search if it\'s not the right SAP material.');
  }

  await pool.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
