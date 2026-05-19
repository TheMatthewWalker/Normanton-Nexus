import express from 'express';
import sql from 'mssql';
import { sqlConfig } from '../server.js';

const router = express.Router();
const getPool = async () => await sql.connect(sqlConfig);

// ── Get all records ──
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query('SELECT * FROM Logistics.dbo.PalletMain');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by PalletID ──
router.get('/id/:palletId', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('palletId', sql.Int, req.params.palletId)
            .query('SELECT * FROM Logistics.dbo.PalletMain WHERE palletID = @palletId');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Category ──
router.get('/category/:category', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('category', sql.NVarChar, req.params.category)
            .query('SELECT * FROM Logistics.dbo.PalletMain WHERE palletCategory = @category');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Get by Location ──
router.get('/location/:location', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('location', sql.NVarChar, req.params.location)
            .query('SELECT * FROM Logistics.dbo.PalletMain WHERE palletLocation = @location');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Create new record ──
// palletID is an IDENTITY column — SQL Server assigns it automatically.
// Do not include it in the INSERT; use SCOPE_IDENTITY() to read it back.
router.post('/', async (req, res) => {
    try {
        const {
            palletType, palletFinish, packagingWeight, grossWeight,
            palletVolume, palletLength, palletWidth, palletHeight,
            palletRemoved, palletCategory, palletLocation, palletCreationDate, palletFinishDate
        } = req.body;

        const pool = await getPool();
        const result = await pool.request()
            .input('palletType', sql.NVarChar, palletType)
            .input('palletFinish', sql.Bit, palletFinish)
            .input('packagingWeight', sql.Decimal, packagingWeight)
            .input('grossWeight', sql.Decimal, grossWeight)
            .input('palletVolume', sql.Decimal, palletVolume)
            .input('palletLength', sql.Int, palletLength)
            .input('palletWidth', sql.Int, palletWidth)
            .input('palletHeight', sql.Int, palletHeight)
            .input('palletRemoved', sql.Bit, palletRemoved)
            .input('palletCategory', sql.NVarChar, palletCategory)
            .input('palletLocation', sql.NVarChar, palletLocation)
            .input('palletCreationDate', sql.DateTime, palletCreationDate ? new Date(palletCreationDate) : null)
            .input('palletFinishDate', sql.DateTime, palletFinishDate ? new Date(palletFinishDate) : null)
            .query(`INSERT INTO Logistics.dbo.PalletMain
                (palletType, palletFinish, packagingWeight, grossWeight,
                 palletVolume, palletLength, palletWidth, palletHeight,
                 palletRemoved, palletCategory, palletLocation, palletCreationDate, palletFinishDate)
                VALUES
                (@palletType, @palletFinish, @packagingWeight, @grossWeight,
                 @palletVolume, @palletLength, @palletWidth, @palletHeight,
                 @palletRemoved, @palletCategory, @palletLocation, @palletCreationDate, @palletFinishDate);
                SELECT SCOPE_IDENTITY() AS palletID;`);

        const newId = result.recordset[0].palletID;
        res.status(201).json({ message: 'Record created successfully', palletID: newId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Update pallet fields ──
router.patch('/:palletId', async (req, res) => {
    const { palletFinish, palletLocation, palletCategory,
            grossWeight, packagingWeight, palletVolume, palletRemoved,
            palletType, palletLength, palletWidth, palletHeight } = req.body;
    try {
        const pool    = await getPool();
        const request = pool.request().input('palletId', sql.Int, req.params.palletId);
        const sets    = [];

        if (palletFinish !== undefined) {
            request.input('palletFinish', sql.Bit, palletFinish ? 1 : 0);
            sets.push('palletFinish = @palletFinish');
            if (palletFinish) sets.push('palletFinishDate = GETDATE()');
        }
        if (palletLocation !== undefined) {
            request.input('palletLocation', sql.NVarChar(50), palletLocation);
            sets.push('palletLocation = @palletLocation');
        }
        if (palletCategory !== undefined) {
            request.input('palletCategory', sql.NVarChar(2), palletCategory);
            sets.push('palletCategory = @palletCategory');
        }
        if (grossWeight !== undefined) {
            request.input('grossWeight', sql.Decimal(18, 3), grossWeight);
            sets.push('grossWeight = @grossWeight');
        }
        if (packagingWeight !== undefined) {
            request.input('packagingWeight', sql.Decimal(18, 3), packagingWeight);
            sets.push('packagingWeight = @packagingWeight');
        }
        if (palletVolume !== undefined) {
            request.input('palletVolume', sql.Decimal(18, 3), palletVolume);
            sets.push('palletVolume = @palletVolume');
        }
        if (palletHeight !== undefined) {
            request.input('palletHeight', sql.Int, palletHeight);
            sets.push('palletHeight = @palletHeight');
        }
        if (palletRemoved !== undefined) {
            request.input('palletRemoved', sql.Bit, palletRemoved ? 1 : 0);
            sets.push('palletRemoved = @palletRemoved');
        }
        if (palletType !== undefined) {
            request.input('palletType', sql.NVarChar, palletType);
            sets.push('palletType = @palletType');
        }
        if (palletLength !== undefined) {
            request.input('palletLength', sql.Int, palletLength);
            sets.push('palletLength = @palletLength');
        }
        if (palletWidth !== undefined) {
            request.input('palletWidth', sql.Int, palletWidth);
            sets.push('palletWidth = @palletWidth');
        }

        if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });

        await request.query(
            `UPDATE Logistics.dbo.PalletMain SET ${sets.join(', ')} WHERE palletID = @palletId`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
