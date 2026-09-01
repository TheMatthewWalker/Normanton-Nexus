import express from 'express';
import sql from 'mssql';
import { getNexusOperationsPool } from '../config.js';

const router = express.Router();
const getPool = getNexusOperationsPool;

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM log.CostTypes');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by TypeID ──
// typeID is a SAP-issued code (e.g. 'ITLG06A' for Warehousing), not a
// numeric surrogate — 'General Freight'/'Customs' happened to be seeded as
// plain '1'/'2', but the column itself is NVARCHAR (see the POST comment
// below); sql.BigInt here would throw a conversion error for any
// non-numeric typeID.
router.get('/id/:typeId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('typeId', sql.NVarChar(10), req.params.typeId)
            .query('SELECT * FROM log.CostTypes WHERE typeID = @typeId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
// log.CostTypes.typeID is NVARCHAR(10) — SAP cost-type codes like
// 'ITLG06A'/'ITLG07Z' (Warehousing/Other Logistics Srvs/etc., added
// alongside the original numeric-looking '1'/'2' General Freight/Customs
// rows) aren't numeric, so this must not bind typeID as sql.BigInt.
router.post('/', async (req, res) => {
    try {
        const { typeID, typeDescription } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('typeID', sql.NVarChar(10), typeID)
            .input('typeDescription', sql.NVarChar, typeDescription)
            .query(`INSERT INTO log.CostTypes (typeID, typeDescription)
                    VALUES (@typeID, @typeDescription)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
