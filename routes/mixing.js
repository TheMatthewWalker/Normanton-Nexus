import express from 'express';
import sql from 'mssql';

const router = express.Router();

// Export your sqlConfig from server.js and import it here
import { sqlConfig } from '../config.js';

// ── Helper to get a connection pool ──
const getPool = async () => await sql.connect(sqlConfig);

    // ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM dbo.Mixing');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by MixingID ──
router.get('/id/:mixingId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('mixingId', sql.NVarChar, req.params.mixingId)
            .query('SELECT * FROM dbo.Mixing WHERE MixingID = @mixingId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Operator ──
router.get('/operator/:operatorName', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('operatorName', sql.NVarChar, req.params.operatorName)
            .query('SELECT * FROM dbo.Mixing WHERE Operator = @operatorName');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Shift ──
router.get('/shift/:shift', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('shift', sql.NVarChar, req.params.shift)
            .query('SELECT * FROM dbo.Mixing WHERE Shift = @shift');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by MixCode ──
router.get('/mixcode/:mixCode', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('mixCode', sql.NVarChar, req.params.mixCode)
            .query('SELECT * FROM dbo.Mixing WHERE MixCode = @mixCode');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by SupplierBatch ──
router.get('/supplierbatch/:supplierBatch', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('supplierBatch', sql.NVarChar, req.params.supplierBatch)
            .query('SELECT * FROM dbo.Mixing WHERE SupplierBatch = @supplierBatch');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by date range ──
router.get('/daterange', async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const pool = await getPool();
        const result = await pool.request()
            .input('dateFrom', sql.NVarChar, dateFrom)
            .input('dateTo', sql.NVarChar, dateTo)
            .query(`SELECT * FROM dbo.Mixing 
                    WHERE CONVERT(date, CreationDate, 104) 
                    BETWEEN CONVERT(date, @dateFrom, 104) 
                    AND CONVERT(date, @dateTo, 104)`)
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Dynamic filtered search ──
// Each row = AND between filled fields
// Multiple rows = OR between rows
router.post('/search', async (req, res) => {
    try {
        const rows = req.body; // Array of search row objects

        if (!rows || rows.length === 0) {
            // No criteria - return all
            const pool = await getPool();
            const result = await pool.request()
                .query('SELECT * FROM dbo.Mixing');
            return res.json(result.recordset);
        }

        const pool = await getPool();
        const request = pool.request();

        // Build one WHERE clause per row, joined by OR
        const rowClauses = rows.map((row, rowIndex) => {
            const fieldClauses = [];

            if (row.mixingID) {
                request.input(`mixingID_${rowIndex}`, sql.NVarChar, row.mixingID);
                fieldClauses.push(`MixingID = @mixingID_${rowIndex}`);
            }
            if (row.mixCode) {
                request.input(`mixCode_${rowIndex}`, sql.NVarChar, row.mixCode);
                fieldClauses.push(`MixCode = @mixCode_${rowIndex}`);
            }
            if (row.totalWeight) {
                request.input(`totalWeight_${rowIndex}`, sql.NVarChar, row.totalWeight);
                fieldClauses.push(`TotalWeight = @totalWeight_${rowIndex}`);
            }
            if (row.shift) {
                request.input(`shift_${rowIndex}`, sql.NVarChar, row.shift);
                fieldClauses.push(`Shift = @shift_${rowIndex}`);
            }
            if (row.operator) {
                request.input(`operator_${rowIndex}`, sql.NVarChar, row.operator);
                fieldClauses.push(`Operator = @operator_${rowIndex}`);
            }
            if (row.supplierBatch) {
                request.input(`supplierBatch_${rowIndex}`, sql.NVarChar, row.supplierBatch);
                fieldClauses.push(`SupplierBatch = @supplierBatch_${rowIndex}`);
            }
            if (row.batchTub) {
                request.input(`batchTub_${rowIndex}`, sql.NVarChar, row.batchTub);
                fieldClauses.push(`BatchTub = @batchTub_${rowIndex}`);
            }
            if (row.creationDate && row.dateTo) {
                // Date range
                request.input(`dateFrom_${rowIndex}`, sql.NVarChar, row.creationDate);
                request.input(`dateTo_${rowIndex}`, sql.NVarChar, row.dateTo);
                fieldClauses.push(`CONVERT(datetime, CreationDate, 104) BETWEEN CONVERT(datetime, @dateFrom_${rowIndex}, 104) AND CONVERT(datetime, @dateTo_${rowIndex}, 104)`);
            } else if (row.creationDate) {
                // Exact date if only DateFrom is filled
                request.input(`dateFrom_${rowIndex}`, sql.NVarChar, row.creationDate);
                fieldClauses.push(`CreationDate = @dateFrom_${rowIndex}`);
            }
            if (row.creationTime) {
                request.input(`creationTime_${rowIndex}`, sql.NVarChar, row.creationTime);
                fieldClauses.push(`CreationTime = @creationTime_${rowIndex}`);
            }
            if (row.comment) {
                request.input(`comment_${rowIndex}`, sql.NVarChar, row.comment);
                fieldClauses.push(`Comment = @comment_${rowIndex}`);
            }

            // AND between fields within a row
            return fieldClauses.length > 0
                ? `(${fieldClauses.join(' AND ')})`
                : null;

        }).filter(clause => clause !== null); // Remove any empty rows

        const whereClause = rowClauses.length > 0
            ? `WHERE ${rowClauses.join(' OR ')}` // OR between rows
            : '';

        const result = await request.query(`SELECT * FROM dbo.Mixing ${whereClause} ORDER BY MixingID DESC`);
        res.json(result.recordset);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Create new record ──
router.post('/', async (req, res) => {
    try {
        const { MixingID, MixCode, TotalWeight, Shift, Operator,
                SupplierBatch, BatchTub, CreationDate, CreationTime, Comment } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('MixingID', sql.NVarChar, MixingID)
            .input('MixCode', sql.NVarChar, MixCode)
            .input('TotalWeight', sql.NVarChar, TotalWeight)
            .input('Shift', sql.NVarChar, Shift)
            .input('Operator', sql.NVarChar, Operator)
            .input('SupplierBatch', sql.NVarChar, SupplierBatch)
            .input('BatchTub', sql.NVarChar, BatchTub)
            .input('CreationDate', sql.NVarChar, CreationDate)
            .input('CreationTime', sql.NVarChar, CreationTime)
            .input('Comment', sql.NVarChar, Comment)
            .query(`INSERT INTO Mixing
                    (MixingID, MixCode, TotalWeight, Shift, Operator,
                     SupplierBatch, BatchTub, CreationDate, CreationTime, Comment)
                    VALUES
                    (@MixingID, @MixCode, @TotalWeight, @Shift, @Operator,
                     @SupplierBatch, @BatchTub, @CreationDate, @CreationTime, @Comment)`);

        res.status(201).json({ message: 'Record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Update record ──
router.put('/:mixingId', async (req, res) => {
    try {
        const { MixCode, TotalWeight, Shift, Operator,
                SupplierBatch, BatchTub, Comment } = req.body;

        const pool = await getPool();
        await pool.request()
            .input('MixingID', sql.NVarChar, req.params.mixingId)
            .input('MixCode', sql.NVarChar, MixCode)
            .input('TotalWeight', sql.NVarChar, TotalWeight)
            .input('Shift', sql.NVarChar, Shift)
            .input('Operator', sql.NVarChar, Operator)
            .input('SupplierBatch', sql.NVarChar, SupplierBatch)
            .input('BatchTub', sql.NVarChar, BatchTub)
            .input('Comment', sql.NVarChar, Comment)
            .query(`UPDATE Mixing SET
                    MixCode = @MixCode,
                    TotalWeight = @TotalWeight,
                    Shift = @Shift,
                    Operator = @Operator,
                    SupplierBatch = @SupplierBatch,
                    BatchTub = @BatchTub,
                    Comment = @Comment
                    WHERE MixingID = @MixingID`);

        res.json({ message: 'Record updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;