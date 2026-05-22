import { Router }                from 'express';
import sql                       from 'mssql';
import { sqlConfig }             from '../server.js';
import { requireRole }           from '../middleware/auth.js';
import { notify }                from '../lib/notify.js';

const router = Router();

const userId = req => req.session?.user?.userID;

// ── GET /api/notifications ────────────────────────────────────────────────────
// Returns the current user's tray: unread first, then read-but-not-dismissed,
// excluding expired and dismissed notifications.

router.get('/', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const r = await pool.request()
      .input('uid', sql.Int, userId(req))
      .query(`
        SELECT
          d.DeliveryID, d.NotificationID,
          n.Title, n.Body, n.Severity, n.Category,
          n.ActionLabel, n.ActionURL,
          n.CreatedAt, n.ExpiresAt,
          d.IsRead, d.IsDismissed, d.ReadAt, d.DismissedAt
        FROM   dbo.NotificationDeliveries d
        JOIN   dbo.Notifications          n ON n.NotificationID = d.NotificationID
        WHERE  d.UserID      = @uid
          AND  d.IsDismissed = 0
          AND  (n.ExpiresAt IS NULL OR n.ExpiresAt > GETDATE())
        ORDER  BY d.IsRead ASC, n.CreatedAt DESC`);

    const unreadCount = r.recordset.filter(n => !n.IsRead).length;
    res.json({ success: true, data: r.recordset, unreadCount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/notifications/history ───────────────────────────────────────────
// Full history including dismissed, for the history page.

router.get('/history', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const r = await pool.request()
      .input('uid', sql.Int, userId(req))
      .query(`
        SELECT
          d.DeliveryID, d.NotificationID,
          n.Title, n.Body, n.Severity, n.Category,
          n.ActionLabel, n.ActionURL,
          n.CreatedAt, n.ExpiresAt,
          d.IsRead, d.IsDismissed, d.ReadAt, d.DismissedAt
        FROM   dbo.NotificationDeliveries d
        JOIN   dbo.Notifications          n ON n.NotificationID = d.NotificationID
        WHERE  d.UserID = @uid
        ORDER  BY n.CreatedAt DESC`);

    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PATCH /api/notifications/read-all ────────────────────────────────────────
// Mark all unread deliveries as read. Called when the tray opens.

router.patch('/read-all', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('uid', sql.Int, userId(req))
      .query(`UPDATE dbo.NotificationDeliveries
              SET IsRead = 1, ReadAt = GETDATE()
              WHERE UserID = @uid AND IsRead = 0 AND IsDismissed = 0`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PATCH /api/notifications/:deliveryId/dismiss ──────────────────────────────
// Dismiss one notification for the current user.

router.patch('/:deliveryId/dismiss', async (req, res) => {
  const id = Number(req.params.deliveryId);
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('id',  sql.Int, id)
      .input('uid', sql.Int, userId(req))
      .query(`UPDATE dbo.NotificationDeliveries
              SET IsDismissed = 1, DismissedAt = GETDATE(), IsRead = 1, ReadAt = COALESCE(ReadAt, GETDATE())
              WHERE DeliveryID = @id AND UserID = @uid`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/admin/notifications ────────────────────────────────────────────
// Create a notification and fan it out. Admin only.

router.post('/admin', requireRole('admin'), async (req, res) => {
  const {
    title, body, severity = 1, category = null,
    actionLabel = null, actionURL = null,
    expiresAt = null,
    target = { type: 'all' },
  } = req.body;

  if (!title || !body)
    return res.status(400).json({ success: false, error: 'title and body are required.' });
  if (![1, 2, 3].includes(Number(severity)))
    return res.status(400).json({ success: false, error: 'severity must be 1, 2 or 3.' });

  try {
    const pool = await sql.connect(sqlConfig);
    const notificationID = await notify(pool, {
      title, body,
      severity:   Number(severity),
      category,
      actionLabel,
      actionURL,
      expiresAt,
      target,
      createdByUserID: userId(req),
    });

    // Count deliveries created
    const countR = await pool.request()
      .input('nid', sql.Int, notificationID)
      .query(`SELECT COUNT(*) AS Recipients FROM dbo.NotificationDeliveries WHERE NotificationID = @nid`);

    res.status(201).json({
      success: true,
      data: { notificationID, recipients: countR.recordset[0].Recipients },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/admin/notifications ─────────────────────────────────────────────
// List sent notifications with delivery stats. Admin only.

router.get('/admin', requireRole('admin'), async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const r = await pool.request().query(`
      SELECT
        n.NotificationID, n.Title, n.Severity, n.Category,
        n.TargetType, n.TargetValue,
        n.CreatedAt, n.ExpiresAt,
        pu.Username AS CreatedBy,
        COUNT(d.DeliveryID)                                    AS TotalSent,
        SUM(CAST(d.IsRead AS INT))                             AS TotalRead,
        SUM(CAST(d.IsDismissed AS INT))                        AS TotalDismissed
      FROM   dbo.Notifications n
      LEFT JOIN dbo.NotificationDeliveries d  ON d.NotificationID = n.NotificationID
      LEFT JOIN dbo.PortalUsers            pu ON pu.UserID = n.CreatedByUserID
      GROUP BY
        n.NotificationID, n.Title, n.Severity, n.Category,
        n.TargetType, n.TargetValue,
        n.CreatedAt, n.ExpiresAt, pu.Username
      ORDER BY n.CreatedAt DESC`);

    res.json({ success: true, data: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── DELETE /api/admin/notifications/:id ──────────────────────────────────────
// Expire a notification immediately (sets ExpiresAt = now). Admin only.

router.delete('/admin/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const pool = await sql.connect(sqlConfig);
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE dbo.Notifications SET ExpiresAt = GETDATE() WHERE NotificationID = @id`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/admin/notifications/targets ─────────────────────────────────────
// Returns available departments and permissions for the send form dropdowns.

router.get('/admin/targets', requireRole('admin'), async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const [depts, perms] = await Promise.all([
      pool.request().query(`SELECT DISTINCT Department FROM dbo.PortalUserDepartments ORDER BY Department`),
      pool.request().query(`SELECT PermissionCode, PermissionName, Category FROM dbo.PortalPermissions ORDER BY Category, PermissionName`),
    ]);
    res.json({
      success: true,
      data: {
        departments: depts.recordset.map(r => r.Department),
        permissions: perms.recordset,
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
