/* ============================================================
   Notifications system — run against the kongsberg database.

   1. dbo.Notifications       — message definitions
   2. dbo.NotificationDeliveries — per-user fan-out with read/dismiss state

   UserID 0 is reserved as the system user for programmatic
   notifications (CreatedByUserID = 0). The FK is set to NULL-able
   so it does not require a real row in PortalUsers.
   ============================================================ */

/* ── 1. Notifications ────────────────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.Notifications') AND type = 'U')
BEGIN
  CREATE TABLE dbo.Notifications (
    NotificationID  INT           NOT NULL IDENTITY(1,1),
    Title           NVARCHAR(120) NOT NULL,
    Body            NVARCHAR(MAX) NOT NULL,
    Severity        TINYINT       NOT NULL DEFAULT 1,   -- 1=info  2=warning  3=critical
    Category        NVARCHAR(50)  NULL,                 -- 'system','production','logistics'…
    ActionLabel     NVARCHAR(60)  NULL,                 -- optional button text
    ActionURL       NVARCHAR(500) NULL,                 -- optional relative URL
    TargetType      NVARCHAR(20)  NULL,                 -- 'user'|'department'|'permission'|'role'|'all'
    TargetValue     NVARCHAR(100) NULL,                 -- the specific value (NULL when type='all')
    CreatedByUserID INT           NULL,                 -- NULL = system (UserID 0 convention)
    CreatedAt       DATETIME      NOT NULL DEFAULT GETDATE(),
    ExpiresAt       DATETIME      NULL,

    CONSTRAINT PK_Notifications PRIMARY KEY (NotificationID)
  );

  PRINT 'Created dbo.Notifications';
END
ELSE
  PRINT 'dbo.Notifications already exists — skipped';


/* ── 2. NotificationDeliveries ───────────────────────────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.NotificationDeliveries') AND type = 'U')
BEGIN
  CREATE TABLE dbo.NotificationDeliveries (
    DeliveryID      INT      NOT NULL IDENTITY(1,1),
    NotificationID  INT      NOT NULL,
    UserID          INT      NOT NULL,
    IsRead          BIT      NOT NULL DEFAULT 0,
    IsDismissed     BIT      NOT NULL DEFAULT 0,
    ReadAt          DATETIME NULL,
    DismissedAt     DATETIME NULL,

    CONSTRAINT PK_NotificationDeliveries  PRIMARY KEY (DeliveryID),
    CONSTRAINT UQ_Delivery_User           UNIQUE      (NotificationID, UserID),
    CONSTRAINT FK_Deliveries_Notification FOREIGN KEY (NotificationID)
                                          REFERENCES  dbo.Notifications (NotificationID)
                                          ON DELETE CASCADE,
    CONSTRAINT FK_Deliveries_User         FOREIGN KEY (UserID)
                                          REFERENCES  dbo.PortalUsers (UserID)
  );

  CREATE INDEX IX_Deliveries_User    ON dbo.NotificationDeliveries (UserID, IsDismissed, IsRead);
  CREATE INDEX IX_Deliveries_NotifID ON dbo.NotificationDeliveries (NotificationID);

  PRINT 'Created dbo.NotificationDeliveries';
END
ELSE
  PRINT 'dbo.NotificationDeliveries already exists — skipped';


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'Notifications'         AS TableName, COUNT(*) AS Rows FROM dbo.Notifications
UNION ALL
SELECT 'NotificationDeliveries',             COUNT(*)         FROM dbo.NotificationDeliveries;
