import express from 'express';
import sql     from 'mssql';
import { sqlConfig } from '../config.js';

const router  = express.Router();
const getPool = async () => sql.connect(sqlConfig);

// ── GET /api/finance/gl-groups — list all groups with their GL accounts ───────
router.get('/gl-groups', async (req, res) => {
  try {
    const pool = await getPool();
    const [groups, accounts] = await Promise.all([
      pool.request().query(
        `SELECT GroupID, GroupLabel, SortOrder
         FROM   dbo.FinanceGlGroups
         ORDER  BY SortOrder, GroupLabel`
      ),
      pool.request().query(
        `SELECT ga.GroupID, ga.GlAccount
         FROM   dbo.FinanceGlGroupAccounts ga
         ORDER  BY ga.GroupID, ga.SortOrder, ga.GlAccount`
      ),
    ]);

    const accMap = {};
    for (const row of accounts.recordset) {
      if (!accMap[row.GroupID]) accMap[row.GroupID] = [];
      accMap[row.GroupID].push(row.GlAccount);
    }

    res.json({
      success: true,
      data: groups.recordset.map(g => ({
        id:       g.GroupID,
        label:    g.GroupLabel,
        accounts: accMap[g.GroupID] || [],
      })),
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/finance/gl-groups — create new group ────────────────────────────
router.post('/gl-groups', async (req, res) => {
  const { label, accounts = [] } = req.body;
  if (!label?.trim())
    return res.status(400).json({ success: false, error: 'label is required.' });

  try {
    const pool = await getPool();
    const ins  = await pool.request()
      .input('label', sql.NVarChar(100), label.trim())
      .query(`INSERT INTO dbo.FinanceGlGroups (GroupLabel)
              OUTPUT INSERTED.GroupID VALUES (@label)`);

    const groupID = ins.recordset[0].GroupID;

    for (let i = 0; i < accounts.length; i++) {
      const acc = String(accounts[i] || '').trim();
      if (!acc) continue;
      await pool.request()
        .input('gid', sql.Int,          groupID)
        .input('acc', sql.NVarChar(20), acc)
        .input('seq', sql.Int,          i)
        .query(`INSERT INTO dbo.FinanceGlGroupAccounts (GroupID, GlAccount, SortOrder)
                VALUES (@gid, @acc, @seq)`);
    }

    res.status(201).json({ success: true, data: { id: groupID } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PUT /api/finance/gl-groups/:id — update label + replace accounts ──────────
router.put('/gl-groups/:id', async (req, res) => {
  const id           = Number(req.params.id);
  const { label, accounts = [] } = req.body;
  if (!label?.trim())
    return res.status(400).json({ success: false, error: 'label is required.' });

  try {
    const pool = await getPool();
    const updated = await pool.request()
      .input('id',    sql.Int,          id)
      .input('label', sql.NVarChar(100), label.trim())
      .query(`UPDATE dbo.FinanceGlGroups SET GroupLabel=@label
              WHERE GroupID=@id`);

    if (updated.rowsAffected[0] === 0)
      return res.status(404).json({ success: false, error: 'Group not found.' });

    await pool.request()
      .input('gid', sql.Int, id)
      .query(`DELETE FROM dbo.FinanceGlGroupAccounts WHERE GroupID=@gid`);

    for (let i = 0; i < accounts.length; i++) {
      const acc = String(accounts[i] || '').trim();
      if (!acc) continue;
      await pool.request()
        .input('gid', sql.Int,          id)
        .input('acc', sql.NVarChar(20), acc)
        .input('seq', sql.Int,          i)
        .query(`INSERT INTO dbo.FinanceGlGroupAccounts (GroupID, GlAccount, SortOrder)
                VALUES (@gid, @acc, @seq)`);
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── DELETE /api/finance/gl-groups/:id ────────────────────────────────────────
router.delete('/gl-groups/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const pool    = await getPool();
    const deleted = await pool.request()
      .input('id', sql.Int, id)
      .query(`DELETE FROM dbo.FinanceGlGroups WHERE GroupID=@id`);

    if (deleted.rowsAffected[0] === 0)
      return res.status(404).json({ success: false, error: 'Group not found.' });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
