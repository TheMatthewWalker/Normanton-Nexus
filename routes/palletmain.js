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

// ── Landing page sparkline — pallets finished per day (last 7 days) + overdue picksheets ──
router.get('/landing-sparkline', async (req, res) => {
    try {
        const pool = await getPool();

        // Pallets finished per day for the last 7 days
        const sparkResult = await pool.request().query(`
            WITH days AS (
                SELECT CAST(DATEADD(day, -6, CAST(GETDATE() AS DATE)) AS DATE) AS day UNION ALL
                SELECT CAST(DATEADD(day, -5, CAST(GETDATE() AS DATE)) AS DATE) UNION ALL
                SELECT CAST(DATEADD(day, -4, CAST(GETDATE() AS DATE)) AS DATE) UNION ALL
                SELECT CAST(DATEADD(day, -3, CAST(GETDATE() AS DATE)) AS DATE) UNION ALL
                SELECT CAST(DATEADD(day, -2, CAST(GETDATE() AS DATE)) AS DATE) UNION ALL
                SELECT CAST(DATEADD(day, -1, CAST(GETDATE() AS DATE)) AS DATE) UNION ALL
                SELECT CAST(DATEADD(day,  0, CAST(GETDATE() AS DATE)) AS DATE)
            )
            SELECT d.day, ISNULL(COUNT(pm.palletID), 0) AS cnt
            FROM days d
            LEFT JOIN Logistics.dbo.PalletMain pm
                ON CAST(pm.palletFinishDate AS DATE) = d.day
               AND pm.palletFinish = 1
               AND pm.palletRemoved = 0
            GROUP BY d.day
            ORDER BY d.day ASC`);

        const dailyValues = sparkResult.recordset.map(r => Number(r.cnt));
        const thisWeek    = dailyValues.reduce((a, b) => a + b, 0);

        // Previous 7 days for week-over-week
        const prevResult = await pool.request().query(`
            SELECT COUNT(*) AS cnt
            FROM Logistics.dbo.PalletMain
            WHERE palletFinish = 1
              AND palletRemoved = 0
              AND palletFinishDate >= DATEADD(day, -13, CAST(GETDATE() AS DATE))
              AND palletFinishDate <  DATEADD(day, -6,  CAST(GETDATE() AS DATE))`);

        const prevWeek  = Number(prevResult.recordset[0].cnt);
        const pctChange = prevWeek === 0
            ? (thisWeek > 0 ? 100 : 0)
            : Math.round(((thisWeek - prevWeek) / prevWeek) * 1000) / 10;

        // Overdue picksheets — due date has passed and not yet completed
        const overdueResult = await pool.request().query(`
            SELECT COUNT(*) AS cnt
            FROM Logistics.dbo.DeliveryMain
            WHERE completionStatus = 0
              AND ISNULL(deliveryCancelled, 0) = 0
              AND dueDate < CAST(GETDATE() AS DATE)`);

        const overduePicksheets = Number(overdueResult.recordset[0].cnt);

        res.json({ success: true, data: { dailyValues, thisWeek, pctChange, overduePicksheets } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
