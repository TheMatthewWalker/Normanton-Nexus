/**
 * lib/notify.js
 *
 * Programmatic notification helper. Import and call notify() from any route
 * to create a notification and fan it out to the matching users.
 *
 * Usage:
 *   import { notify } from '../lib/notify.js';
 *
 *   await notify(pool, {
 *     title:    'Failed Backflush Requires Review',
 *     body:     `${batchRef} failed SAP posting.`,
 *     severity: 2,
 *     category: 'production',
 *     actionLabel: 'Open Queue',
 *     actionURL:   '/private/production-nexus.html',
 *     target: { type: 'permission', value: 'PROD_SUPERVISOR' },
 *   });
 *
 * Target types:
 *   { type: 'user',       value: 'username' }
 *   { type: 'department', value: 'logistics' }
 *   { type: 'permission', value: 'PROD_SUPERVISOR' }
 *   { type: 'role',       value: 'admin' }
 *   { type: 'all' }
 *
 * pool — a connected mssql pool pointed at the kongsberg database.
 * CreatedByUserID = 0 (system) when called programmatically.
 */

import sql from 'mssql';

export async function notify(pool, {
  title,
  body,
  severity    = 1,
  category    = null,
  actionLabel = null,
  actionURL   = null,
  expiresAt   = null,
  target      = { type: 'all' },
  createdByUserID = 0,
}) {
  if (!title || !body) throw new Error('notify: title and body are required');

  const targetType  = target.type  || 'all';
  const targetValue = target.value || null;

  // Insert the notification definition
  const notifResult = await pool.request()
    .input('title',   sql.NVarChar(120),    title)
    .input('body',    sql.NVarChar(sql.MAX), body)
    .input('sev',     sql.TinyInt,           severity)
    .input('cat',     sql.NVarChar(50),      category)
    .input('alabel',  sql.NVarChar(60),      actionLabel)
    .input('aurl',    sql.NVarChar(500),     actionURL)
    .input('ttype',   sql.NVarChar(20),      targetType)
    .input('tval',    sql.NVarChar(100),     targetValue)
    .input('creator', sql.Int,               createdByUserID || null)
    .input('exp',     sql.DateTime,          expiresAt ? new Date(expiresAt) : null)
    .query(`INSERT INTO dbo.Notifications
              (Title,Body,Severity,Category,ActionLabel,ActionURL,
               TargetType,TargetValue,CreatedByUserID,ExpiresAt)
            OUTPUT INSERTED.NotificationID
            VALUES (@title,@body,@sev,@cat,@alabel,@aurl,@ttype,@tval,@creator,@exp)`);

  const notificationID = notifResult.recordset[0].NotificationID;

  // Fan out to target users
  await fanOut(pool, notificationID, targetType, targetValue);

  return notificationID;
}

async function fanOut(pool, notificationID, targetType, targetValue) {
  let userQuery;

  switch (targetType) {
    case 'user':
      userQuery = `
        SELECT UserID FROM dbo.PortalUsers
        WHERE Username = @val AND IsActive = 1`;
      break;

    case 'department':
      userQuery = `
        SELECT DISTINCT ud.UserID
        FROM   dbo.PortalUserDepartments ud
        JOIN   dbo.PortalUsers           pu ON pu.UserID = ud.UserID
        WHERE  ud.Department = @val AND pu.IsActive = 1`;
      break;

    case 'permission':
      userQuery = `
        SELECT DISTINCT up.UserID
        FROM   dbo.PortalUserPermissions up
        JOIN   dbo.PortalUsers           pu ON pu.UserID = up.UserID
        WHERE  up.PermissionCode = @val AND pu.IsActive = 1`;
      break;

    case 'role':
      userQuery = `
        SELECT UserID FROM dbo.PortalUsers
        WHERE Role = @val AND IsActive = 1`;
      break;

    case 'all':
    default:
      userQuery = `
        SELECT UserID FROM dbo.PortalUsers
        WHERE IsActive = 1`;
      break;
  }

  // INSERT ... SELECT with duplicate guard (UNIQUE constraint on NotificationID+UserID)
  await pool.request()
    .input('nid', sql.Int,          notificationID)
    .input('val', sql.NVarChar(100), targetValue)
    .query(`INSERT INTO dbo.NotificationDeliveries (NotificationID, UserID)
            SELECT @nid, UserID FROM (${userQuery}) AS u
            WHERE NOT EXISTS (
              SELECT 1 FROM dbo.NotificationDeliveries
              WHERE NotificationID = @nid AND UserID = u.UserID
            )`);
}
