import express from 'express';
import sql from 'mssql';
import { requireDepartment, requireLogin, requirePermission, requireRole } from '../middleware/auth.js';
import { auditQuery, sqlConfig } from '../config.js';

const router = express.Router();

// ✅ Query API (still requires API key)
router.post("/query", requireLogin, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  // Normalize query for case-insensitive checking
  const normalized = query.trim().toUpperCase();

  // Allow Admin to by-pass the block.
  const userRole   = req.session?.user?.role;
  const username   = req.session?.user?.username || null;
  const serverAdmin = userRole === 'admin' || userRole === 'superadmin';

  if (!serverAdmin) {
    // 🚫 Block any dangerous keywords even if embedded later
    const forbidden = ["DELETE", "DROP", "UPDATE", "INSERT", "ALTER", "TRUNCATE", "EXEC", "MERGE"];
    if (forbidden.some(word => normalized.includes(word))) {
      auditQuery('RAW_SQL_BLOCKED', username, query.slice(0, 500), req);
      return res.status(403).json({ error: `Forbidden keyword detected: one of ${forbidden.join(", ")}` });
    }
  }

  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(query);
    auditQuery('RAW_SQL', username, query.slice(0, 500), req);
    // Always return JSON, even if recordset is empty (e.g., for INSERT/DELETE)
    res.json({
      success: true,
      rowsAffected: result.rowsAffected,   // array of rows affected per statement
      recordset: result.recordset || []    // will be empty if no SELECT returned
    });
  } catch (err) {
    console.error('[SQL]', err.message, err.number ? `(#${err.number})` : '');
    auditQuery('RAW_SQL_ERROR', username, `${query.slice(0, 400)} — ERR: ${err.message.slice(0, 80)}`, req);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ POST version for Excel or tools sending long queries
router.post("/query-csv", async (req, res) => {
  const { query, key } = req.body;
  if (key !== config.apiKey) return res.status(403).send(key + " " + query);
  if (!query) return res.status(400).send("Missing query");

  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(query);

    
    // INSERT / UPDATE / DELETE
    if (!result.recordset) {
      const rows = result.rowsAffected?.[0] ?? 0;

      return res.status(200).json({
        success: true,
        rowsAffected: rows,
        message: rows === 0
          ? "Query executed successfully (no rows affected)"
          : `${rows} row(s) affected`
      });
    }

    // SELECT
    const rows = result.recordset;
    if (rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Query executed successfully (no data returned)"
      });
    }

    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(";"),
      ...rows.map(row =>
        headers.map(h => JSON.stringify(row[h] ?? "")).join(";")
      )
    ].join("\r\n");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Disposition", "attachment; filename=results.csv");
    res.setHeader("Content-Type", "text/csv");
    res.send(csv);

  } catch (err) {
    console.error('[SQL]', err.message, err.number ? `(#${err.number})` : '');
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


export default router;