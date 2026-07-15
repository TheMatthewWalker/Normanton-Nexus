import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../config.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.RatesKN');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by CountryCode ──
router.get('/country/:countryCode', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('countryCode', sql.NVarChar, req.params.countryCode)
            .query('SELECT * FROM Logistics.dbo.RatesKN WHERE countryCode = @countryCode');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PostalCode ──
router.get('/postalcode/:postalCode', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('postalCode', sql.NVarChar, req.params.postalCode)
            .query('SELECT * FROM Logistics.dbo.RatesKN WHERE postalCode = @postalCode');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { countryCode, postalCode, minWeight, maxWeight, agreedRate, transitTime } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('countryCode', sql.NVarChar, countryCode)
            .input('postalCode', sql.NVarChar, postalCode)
            .input('minWeight', sql.Int, minWeight)
            .input('maxWeight', sql.Int, maxWeight)
            .input('agreedRate', sql.Decimal, agreedRate)
            .input('transitTime', sql.Int, transitTime)
            .query(`INSERT INTO Logistics.dbo.RatesKN (countryCode, postalCode, minWeight, maxWeight, agreedRate, transitTime)
                    VALUES (@countryCode, @postalCode, @minWeight, @maxWeight, @agreedRate, @transitTime)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Rate lookup: find rate for a country + postcode prefix + chargeable weight ──
// Query: ?country=DE&postcode=15100&weight=450
// Returns agreedRate, minimumCharge, and the calculated expectedCost.
router.get('/lookup', async (req, res) => {
    const { country, postcode, weight } = req.query;
    if (!country || !postcode || weight == null) {
        return res.status(400).json({ success: false, error: 'country, postcode and weight are required' });
    }
    const prefix = String(postcode).slice(0, 2).toUpperCase();
    const w      = Math.ceil(Math.max(0, parseFloat(weight) || 0));
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('country', sql.NVarChar, String(country).toUpperCase())
            .input('prefix',  sql.NVarChar, prefix)
            .input('weight',  sql.Decimal,  w)
            .query(`SELECT TOP 1 agreedRate, minimumCharge, transitTime
                    FROM Logistics.dbo.RatesKN
                    WHERE countryCode = @country
                      AND postalCode  = @prefix
                      AND @weight     >= minWeight
                      AND @weight     <= maxWeight`);
        if (!result.recordset.length) {
            return res.json({ success: true, data: null, message: 'No rate found for this destination and weight' });
        }
        const row         = result.recordset[0];
        const rawCost     = Number(row.agreedRate) * w;
        const minCharge   = Number(row.minimumCharge || 0);
        const expectedCost = Math.round(Math.max(rawCost, minCharge) * 100) / 100;
        res.json({ success: true, data: { agreedRate: row.agreedRate, minimumCharge: row.minimumCharge, transitTime: row.transitTime, chargeableWeight: w, expectedCost } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
