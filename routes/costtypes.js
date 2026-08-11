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
router.get('/id/:typeId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('typeId', sql.BigInt, req.params.typeId)
            .query('SELECT * FROM log.CostTypes WHERE typeID = @typeId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { typeID, typeDescription } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('typeID', sql.BigInt, typeID)
            .input('typeDescription', sql.NVarChar, typeDescription)
            .query(`INSERT INTO log.CostTypes (typeID, typeDescription)
                    VALUES (@typeID, @typeDescription)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
