# CLAUDE.md — SQL2005 Bridge

## Project Overview

**SQL2005 Bridge** is a Node.js HTTP bridge that solves a legacy database compatibility problem at Kongsberg Automotive. When Windows 11 dropped support for TLS 1.0/1.1, it cut off modern clients from a SQL Server 2005 database (which only supports TLS 1.0). This bridge acts as a secure middleman, exposing a modern REST API backed by the legacy database.

- **Runtime**: Node.js (ES Modules — `"type": "module"` in package.json)
- **Framework**: Express 5.x
- **Port**: 4000 (`0.0.0.0` — network accessible)
- **Start**: `node server.js`
- **Config**: `config.json` (git-ignored; use `config.example.json` as template)

---

## Project Structure

```
sql2005-bridge/
├── server.js                  # Entry point: app setup, route mounting, /query endpoints
├── config.json                # Runtime secrets (DB creds, session secret, SAP creds, API key)
├── config.example.json        # Template — copy and fill to create config.json
├── package.json
├── generate-superadmin.js     # One-time utility: generates bcrypt hash for initial admin
│
├── middleware/
│   └── auth.js                # requireLogin, requireRole, requireDepartment
│
├── routes/                    # ~27 route files, all ES module exports of Express Router
│   ├── auth.js                # POST /login, GET /logout, POST /register, GET /session-check
│   ├── useradmin.js           # GET|PUT /api/admin/users, approve/reject/audit endpoints
│   ├── production.js          # /api/production — batches, coils, materials, customers
│   ├── mixing.js              # /api/mixing — mixing records by ID, operator, shift, etc.
│   ├── reports.js             # /api/reports — aggregate/chart data with date filtering
│   ├── exportxlsx.js          # /api/export-xlsx — Excel file generation via ExcelJS
│   ├── sap.js                 # /api/sap — SAP system integration via axios
│   ├── shipmentmain.js        # /api/shipmentmain
│   ├── shipmentlink.js        # /api/shipmentlink
│   ├── shipmentcost.js        # /api/shipmentcost
│   ├── deliverymain.js        # /api/deliverymain
│   ├── deliverylink.js        # /api/deliverylink
│   ├── palletmain.js          # /api/palletmain
│   ├── palletpackages.js      # /api/palletpackages
│   ├── palletdata.js          # /api/palletdata
│   ├── palletvalidation.js    # /api/palletvalidation
│   ├── packagingdata.js       # /api/packagingdata
│   ├── destinations.js        # /api/destinations
│   ├── forwarders.js          # /api/forwarders
│   ├── forwarderapproval.js   # /api/forwarderapproval
│   ├── incoterms.js           # /api/incoterms
│   ├── costtypes.js           # /api/costtypes
│   ├── costelements.js        # /api/costelements
│   ├── costcenters.js         # /api/costcenters
│   ├── rateskn.js             # /api/rateskn
│   ├── ratestpn.js            # /api/ratestpn
│   ├── assignmenttpn.js       # /api/assignmenttpn
│   ├── relatedrecords.js      # /api/related-records
│   └── filterrecords.js       # /api/filter-records
│
├── public/                    # Unauthenticated static files
│   ├── index.html             # Login page (served at /)
│   ├── css/
│   └── images/
│
└── private/                   # Auth-gated files (served via /private/:page)
    ├── landing.html           # Post-login home/navigation
    ├── admin.html             # Admin dashboard (requires admin role)
    ├── rawsql.html            # Raw SQL console (requires admin role)
    ├── production.html        # (requires production dept)
    ├── logistics.html         # (requires logistics dept)
    ├── warehouse.html         # (requires warehouse dept)
    ├── finance.html           # (requires finance dept)
    ├── sales.html             # (requires sales dept)
    ├── quality.html           # (requires quality dept)
    ├── engineering.html       # (requires engineering dept)
    ├── management.html        # (requires management dept)
    ├── js/
    │   ├── admin.js
    │   ├── production.js
    │   └── rawsql.js
    ├── css/
    └── images/
```

---

## Authentication & Authorization

### Middleware (`middleware/auth.js`)

| Middleware | Usage | Behavior |
|---|---|---|
| `requireLogin` | All `/api/*` routes | Returns 401 JSON (API) or redirects to `/` (page) if no session |
| `requireRole(minRole)` | `/api/admin/*` routes | Returns 403 if user role level < minimum |
| `requireDepartment(dept)` | Department page routes | Returns 403 if user lacks that department; superadmin bypasses |

### Role Hierarchy

| Role | Level | Notes |
|---|---|---|
| viewer | 1 | Read-only |
| editor | 2 | Read + write |
| admin | 3 | Full access |
| superadmin | 4 | Bypasses all department checks |

### Session

- `express-session` with rolling 1-hour idle timeout
- httpOnly + sameSite strict cookies
- Secret from `config.sessionSecret`
- `req.session.user` contains: `userID`, `username`, `role`, `departments[]`

### Database Tables (auth)

- `dbo.PortalUsers` — accounts, password hashes, role, status, lock state
- `dbo.PortalUserDepartments` — junction: user ↔ department
- `dbo.PortalAuditLog` — all auth events (LOGIN_SUCCESS, LOGIN_FAIL, LOGOUT, REGISTER_REQUEST, etc.)

---

## Database Connection

SQL config is exported from `server.js` as `sqlConfig` and imported by all route files:

```js
import { sqlConfig } from '../server.js';
const pool = await sql.connect(sqlConfig);
```

**Always use parameterized queries — never interpolate user input:**

```js
const result = await pool.request()
  .input('batch', sql.NVarChar(50), req.params.batch)
  .query('SELECT * FROM dbo.Batches WHERE Batch = @batch');
```

**Date handling note**: The legacy DB stores dates as `nvarchar` in `"dd.mm.yy hh:mm:ss"` format. Use `CONVERT(datetime, col, 4)` in SQL for date comparisons.

---

## Core Endpoints in server.js

| Endpoint | Auth | Description |
|---|---|---|
| `POST /query` | requireLogin | Execute raw SQL. Non-admins blocked from: DELETE, DROP, UPDATE, INSERT, ALTER, TRUNCATE, EXEC, MERGE |
| `POST /query-csv` | API key (`config.apiKey`) | Execute raw SQL, return CSV. No keyword restrictions. Used by Excel/external tools |
| `GET /private/:page` | requireLogin + dept/role check | Serve protected HTML pages |
| `GET /private/js/:file` | requireLogin | Serve protected JS |
| `GET /private/css/:file` | requireLogin | Serve protected CSS |

---

## Configuration (`config.json`)

```json
{
  "apiKey": "...",
  "sessionSecret": "...",
  "sqlConfig": {
    "user": "...",
    "password": "...",
    "server": "...",
    "database": "..."
  },
  "sapConfig": {
    "system": "...",
    "systemNumber": "...",
    "client": "...",
    "user": "...",
    "password": "...",
    "lang": "EN",
    "url": "..."
  }
}
```

---

## Key Patterns

- **ES Modules throughout** — use `import`/`export`, not `require`
- **All routes** export a default `Router` instance
- **Error handling**: try/catch in every route handler, `res.status(500).json({ error: err.message })`
- **No stack traces** exposed in HTTP responses
- **Rate limiting**: login endpoint — 10 attempts per 15 min per IP
- **Bcrypt cost factor**: 12
- **Audit logging**: non-blocking (failures don't crash the request)

---

## Dependencies

| Package | Purpose |
|---|---|
| express ^5.1.0 | HTTP framework |
| mssql ^12.0.0 | SQL Server connectivity |
| express-session ^1.18.2 | Session management |
| express-rate-limit ^8.2.1 | Login brute-force protection |
| bcrypt ^6.0.0 | Password hashing |
| exceljs ^4.4.0 | Excel file export |
| axios ^1.13.1 | SAP HTTP integration |
| cors ^2.8.5 | CORS headers |
| node-fetch ^3.3.2 | Fetch API polyfill |
| node-windows ^1.0.0-beta.8 | Windows service integration |
