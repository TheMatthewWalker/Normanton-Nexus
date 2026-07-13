# SQL 2005 Bridge

A lightweight Node.js HTTPS bridge that provides modern applications with secure access to a legacy SQL Server 2005 database — solving the TLS incompatibility introduced by Windows 11.

---

## The Problem

Windows 11 dropped support for TLS 1.0 and TLS 1.1 as part of its security hardening. SQL Server 2005 only supports TLS 1.0, meaning any machine upgraded to Windows 11 **loses the ability to connect to SQL Server 2005 entirely** — with no upgrade path available for the database itself.

In a manufacturing environment, shop floor systems often run on legacy databases that cannot be easily migrated. When office staff were upgraded to Windows 11, they lost access to critical shop floor data overnight.

---

## The Solution

Rather than attempting a costly and risky database migration, this bridge acts as a **secure middleman** — sitting between modern Windows 11 clients and the legacy SQL Server 2005 instance.

```
┌─────────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│  Windows 11 Client  │       │   SQL 2005 Bridge    │       │   SQL Server 2005   │
│                     │       │                      │       │                     │
│  HTTPS Request   ──▶│─HTTPS▶│  Receives request    │─TLS──▶│  Executes query     │
│  + SQL query        │       │  Executes query      │◀──────│  Returns results    │
│                     │◀──────│  Returns JSON        │       │                     │
└─────────────────────┘       └──────────────────────┘       └─────────────────────┘
     Modern TLS                  Handles both sides               Legacy TLS 1.0
```

The bridge handles the TLS negotiation on both sides — accepting modern HTTPS connections from Windows 11 clients on one end, while maintaining the legacy TLS 1.0 connection to SQL Server 2005 on the other.

---

## How It Works

1. Client sends an HTTPS POST request containing a SQL query
2. Bridge receives the request and executes the query against SQL Server 2005
3. Results are returned as a structured JSON response containing:
   - `success` — whether the query executed without error
   - `results` — the returned rows as a JSON array
   - `error` — error message if the query failed

### Example Response — Success

```json
{
  "success": true,
  "results": [
    { "JobNumber": "JB-10042", "Status": "In Progress", "Quantity": 250 },
    { "JobNumber": "JB-10043", "Status": "Complete", "Quantity": 180 }
  ]
}
```

### Example Response — Error

```json
{
  "success": false,
  "results": [],
  "error": "Invalid column name 'JobNumbar'"
}
```

---

## Tech Stack

| Technology | Usage |
|---|---|
| Node.js | Runtime environment |
| JavaScript | Application logic |
| HTTPS | Secure client-facing transport |
| MSSQL (npm) | SQL Server 2005 connectivity |

---

## Background

This was built as a pragmatic fix to a real problem in a live manufacturing environment at Kongsberg Automotive. A phased Windows 11 rollout to office staff cut off access to shop floor production data held in a legacy SQL Server 2005 instance — data that operational and logistics teams relied on daily.

A full database migration was not feasible in the short term due to the complexity of the dependent systems and the risk of disruption to live production. This bridge restored access within a day and has run reliably in production since, buying the time needed to plan a proper long-term migration.

---

## Why This Approach

- **Low risk** — no changes to the existing database or dependent shop floor systems
- **Fast to deploy** — Node.js with minimal dependencies, runs as a lightweight service
- **Transparent** — clients make standard HTTPS requests, the bridge handles all legacy complexity invisibly
- **Temporary by design** — intended as a stopgap while a long-term migration is planned, not a permanent architecture

---

## Author

**Matthew Walker** — Systems & Application Developer  
[LinkedIn](https://linkedin.com/in/matthew-walker-1b740418b) · [GitHub](https://github.com/TheMatthewWalker)