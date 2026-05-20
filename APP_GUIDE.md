# Normanton Nexus — Application Guide

**Version:** May 2026  
**Stack:** Node.js · Express 5 · MSSQL · Session auth · Chart.js  
**Port:** 4000

---

## What is Normanton Nexus?

Normanton Nexus is an internal web portal for Kongsberg Automotive's Normanton site. It exposes a modern, browser-based interface over legacy SQL Server databases that can no longer be accessed directly from Windows 11 clients (TLS 1.0 deprecation). It also integrates with an SAP system via a separate RFC microservice.

The portal is divided into department-specific modules. Each user is assigned one or more department permissions, and only sees the modules relevant to their role. All actions are session-authenticated and key write operations are audit-logged.

---

## Access & Permissions

### How to log in
- Navigate to the portal root (`/`). Enter your username and password.
- Accounts are created by self-registration and must be approved by an admin before use.
- After 10 consecutive failed login attempts, an account is locked and requires admin intervention.

### Roles
| Role | What it can do |
|---|---|
| **viewer** | Read-only access within assigned departments |
| **editor** | Read + write within assigned departments |
| **admin** | Full access; can manage users and approve registrations |
| **superadmin** | All of the above, plus bypasses all department restrictions |

### Department permissions
Each user is assigned one or more departments. The available departments are:

`production` · `logistics` · `warehouse` · `finance` · `sales` · `quality` · `engineering` · `management`

In addition, logistics users may have granular permissions that control which logistics functions they can access:

| Permission code | What it unlocks |
|---|---|
| `LOG_VIEW` | View shipment creation and monitoring functions |
| `LOG_PLANNING` | Book shipments, mark collections/deliveries, edit shipment dates |
| `LOG_MRP` | Material planning functions |
| `LOG_SUPER` | Create new deliveries (highest logistics write permission) |
| `LOG_ADMIN` | Logistics admin functions (rate cards, destinations, pallet/packaging data, freight analytics) |

---

## Modules by Department

---

### Production

The production module reads from the **Production** database, which stores manufacturing records from the Normanton shopfloor.

#### Batch Search & Drill-down
Search the batch register by batch number, drum number, material number, or customer name. Each batch record can be expanded to show:
- **Coils** — coil records within the batch
- **Trace** — traceability data
- **Waste** — scrap/waste records with reason codes

#### Mixing
Browse and search mixing records. Filter by:
- Mixing ID
- Operator name
- Shift
- Mix code
- Supplier batch
- Date range

Each mixing record can be expanded to show material documents and waste records.

#### Extrusion
Browse extrusion batch records. Drill down to trace records and waste.

#### Convo (Conversion)
Browse conversion records. Drill down to trace and waste.

#### Ewald
Browse Ewald records. Drill down to boxes, waste records, and scrap documents.

#### Firewall (SAP Bridge)
Browse records that have been passed through the SAP integration firewall. View associated messages per SAP batch.

#### Staging
Browse staging records and their associated line items.

#### Reports
Generate aggregate charts and summaries for production data. Available report types:
- **Batches** — Total length by material, drum count, metres drummed per day (trend line), metres per operator
- **Ewald** — Quantity per material
- **Mixing** — Weight per mix code
- **Extrusion** — Metres per material
- **Convo** — Metres per material

All reports can be filtered by a custom date range.

#### Export to Excel
Export any filtered dataset (plus related child records) to a formatted `.xlsx` file. The Excel file includes styled header rows, alternating row colours, and one sheet per related sub-table (e.g. export a batch plus its coils and trace records in one file).

#### Raw SQL Console *(superadmin only)*
Execute arbitrary SQL queries against the database and view results in the browser. Non-superadmin users are blocked from write keywords (DELETE, DROP, UPDATE, INSERT, ALTER, TRUNCATE, EXEC, MERGE).

---

### Logistics

The logistics module manages the full lifecycle of outbound and inbound shipments from the Normanton site, including freight booking, cost capture, and SAP cost posting readiness.

#### Shipment Creation *(LOG_VIEW to view · LOG_PLANNING to write)*

**Create Shipment**  
Create a new outbound or inbound shipment record. Fields include:
- Shipment reference
- Origin and destination
- Planned collection and delivery dates
- Gross weight, dimensions, volume (CBM)
- Incoterms (EXW, DAP, DDP, etc.)
- Forwarder assignment

**Awaiting Booking**  
List of shipments that have been created but not yet formally booked with a haulier. From here you can:
- Assign or change the forwarder
- Auto-calculate the expected freight cost (for Kuehne & Nagel shipments based on agreed rate cards by country, postcode prefix, and chargeable weight)
- Set the cost centre and cost element (SAP GL code)
- Confirm the booking (moves shipment to Awaiting Collection)

KN cost calculation uses: `chargeableWeight = MAX(grossWeight, volumetricWeight)` where `volumetricWeight = shipmentVolume × 333`. Customs charges apply to KN shipments only: DDP = £50, DAP = £0, using cost element 603120.

**Customer Specifics**  
Manage per-customer or per-destination special handling notes and requirements.

#### Shipment Monitoring *(LOG_VIEW)*

**Awaiting Collection**  
Shipments that have been booked and are waiting to be collected by the haulier. You can:
- Mark a shipment as collected (with operator name and actual collection date)
- Record a tracking number
- View event log for each shipment

**In Transit**  
Outbound shipments that have been collected and are on their way to the customer. You can:
- Mark a shipment as delivered (with actual delivery date)
- View full event history

**Open Deliveries**  
All deliveries currently open (not yet completed). Supports bulk mark-as-shipped operations.

**Shipment Search**  
Search across all shipments by reference number, destination, date range, or status. Results show full shipment details. From a search result you can:
- Edit shipment dates and collection/delivery status
- View the shipment event log (creation, booking, collection, delivery)

**Completed Shipments**  
Archive view of fully delivered shipments.

**Customs Documents**  
Manage customs documentation batches for shipments requiring export clearance.

#### Material Planning *(LOG_MRP)*
Functions for MRP (Material Requirements Planning) related to logistics. Manages delivery schedules and planned inbound material movements.

#### Admin *(LOG_ADMIN)*

**Freight Spend Analytics**  
Dashboard showing freight cost analytics for a configurable period (3 / 6 / 12 / 24 months). Includes:
- KPI cards: total spend, processed spend, unprocessed spend, shipment count, cost record count
- Chart: Spend by forwarder (doughnut)
- Chart: Spend by destination country (bar)
- Chart: Monthly spend trend (line)
- Chart: Inbound vs outbound split (doughnut)
- Chart: Spend by SAP cost centre (bar)

Costs use actualCost where available, falling back to expectedCost.

**Unprocessed Freight Costs**  
Table of all freight cost lines that have not yet been posted in SAP (migoStatus = 0). Columns:
- Shipment Reference
- Cost Type (Freight / Customs)
- Planned Collection Date
- Actual Collection Date
- Haulier
- Cost Centre (SAP)
- Cost Element (SAP GL code)
- Expected Cost
- Actual Cost
- Country + Postcode prefix (2+2 digits)
- Tracking Number

This view is the primary tool for the person responsible for raising MIGO postings in SAP.

**Update Pallet Data**  
Maintain the pallet type register: pallet types, dimensions, maximum weights, and category assignments.

**Update Packaging Data**  
Maintain the packaging code register: packaging types, descriptions, and dimensions.

**Update Destinations**  
Maintain the destination register. For each destination you can manage:
- Name, address, city, postcode, country
- Zone assignment
- Default incoterms
- Default forwarder
- Default delivery service / mode
- Contact details
- Email addresses (multiple per destination, maintained in a separate linked table)
- Bulk operations: mass-change zone, default forwarder, default delivery service; mass delete

---

### Warehouse

The warehouse module manages physical goods movements on the Normanton site.

#### Open Picksheets
View all open (not yet fully picked) pick sheets. Displays customer, reference, due date, and progress against each line. Supports marking lines as picked.

#### Add / Manage Picksheets
Create new pick sheets and manage existing ones, including adding lines, updating quantities, and closing completed sheets.

#### Pallet Management
Full pallet lifecycle management:
- View all pallets by type, category, or location
- Create new pallet records
- Edit pallet details (type, dimensions, weight limits)
- Add/remove packages on a pallet
- Validate pallets against weight/dimension rules
- View pallet data reports

---

### Finance

The finance module provides GL account grouping for management reporting.

#### GL Account Groups
Organise SAP GL accounts into named groups for reporting purposes.
- View all groups and their member accounts
- Create new groups with a label and initial account list
- Edit existing groups (rename, add or remove accounts)
- Delete groups

This is used to map raw SAP GL account numbers into meaningful report categories (e.g. "Direct Labour", "Overhead", "Freight").

---

### Sales

*Module in development. Access requires the `sales` department permission.*

---

### Quality

*Module in development. Access requires the `quality` department permission.*

---

### Engineering

*Module in development. Access requires the `engineering` department permission.*

---

### Management

The management module provides cross-departmental visibility dashboards. Access requires the `management` department permission.

---

## Admin Panel

Accessible to users with the `admin` role or higher.

### User Management
- View all registered users with their role, status, departments, and permissions
- Approve or reject pending registration requests (new users self-register and are held in a pending queue)
- Edit a user's name, email, role, department assignments, and individual permissions
- Lock / unlock user accounts
- Promote or demote roles (admins cannot promote to a role equal to or higher than their own)

### Permission Management *(superadmin only)*
- View all permission definitions (code, name, description, category)
- Create new permission codes
- Edit permission metadata
- Delete permissions (cascades to all users who hold them)
- Grant or revoke individual permissions on a per-user basis

### Audit Log
View a log of all significant system events. Event types include:
- `LOGIN_SUCCESS` / `LOGIN_FAIL`
- `LOGOUT`
- `REGISTER_REQUEST`
- `USER_APPROVED` / `USER_REJECTED`
- `ROLE_CHANGE` / `DEPT_CHANGE`
- `ACCOUNT_LOCKED` / `ACCOUNT_UNLOCKED`
- `USERNAME_CHANGE` / `PROFILE_CHANGE`
- `RAW_SQL_EXEC`
- `SAP_OK` / `SAP_ERROR`
- `PERM_GRANTED` / `PERM_REVOKED`

---

## SAP Integration

The portal communicates with a separate **SapServer** microservice that handles SAP RFC calls. The portal does not talk to SAP directly; instead it signs JWT requests to SapServer which executes the RFC and returns the result.

**What this enables:**
- Executing arbitrary SAP RFC function modules (via `/api/sap/execute-rfc`)
- Pulling costing data from SAP (via `/api/sap/cost-sheet`)
- Syncing logistics shipment data with SAP (freight cost elements, MIGO status)

SAP calls are audit-logged as `SAP_OK` or `SAP_ERROR` events.

---

## Hub / Landing Page

After logging in, users land on the **Hub** page. This shows:
- A tile for each module the user has access to
- Live sparkline charts on tiles that have recent activity (e.g. production output, shipment volumes)
- Quick links to recently visited modules
- User session indicator and sign-out button

---

## Key Technical Notes (for developers)

- **ES Modules throughout** — all server files use `import`/`export`, not `require`
- **Parameterized queries everywhere** — no raw string interpolation in SQL
- **Two database connections** — `kongsberg` (auth, logistics, finance) and `Production` (shopfloor records)
- **Date storage** — legacy Production database stores dates as `nvarchar` in `"dd.mm.yy hh:mm:ss"` format; use `CONVERT(datetime, col, 4)` for comparisons
- **Logistics DB** is on a newer SQL Server instance; uses standard `DATE`/`DATETIME` types
- **mssql bit columns** — returned as JS booleans; always `CAST(ISNULL(col, 0) AS bit)` to avoid null vs false ambiguity
- **Audit logging is non-blocking** — failures in the audit write do not affect the HTTP response
- **All write routes** in the logistics module require the appropriate `LOG_*` permission, checked via `requirePermission()` middleware
- **Rate cards** — KN rates are stored in `RatesKN` (country, postcode prefix, weight bands, agreedRate, minimumCharge, transitTime); TPN rates in `RatesTPN`
- **Data change tracking** — SQL triggers write `SYSTEM_USER` to `DataChangeLog`; `stampDbChange()` backfills with the portal username within ~5 seconds

---

## Route Mount Points

| Mount | File | Description |
|---|---|---|
| `/` | routes/auth.js | Login, logout, register, session check |
| `/api/admin` | routes/useradmin.js | User + permission admin |
| `/api/production` | routes/production.js | Production batch/record queries |
| `/api/mixing` | routes/mixing.js | Mixing records |
| `/api/reports` | routes/reports.js | Aggregate/chart data |
| `/api/export-xlsx` | routes/exportxlsx.js | Excel file export |
| `/api/sap` | routes/sap.js | SAP RFC integration |
| `/api/shipmentmain` | routes/shipmentmain.js | Shipment lifecycle |
| `/api/shipmentcost` | routes/shipmentcost.js | Freight cost records + analytics |
| `/api/deliverymain` | routes/deliverymain.js | Delivery records |
| `/api/palletmain` | routes/palletmain.js | Pallet register |
| `/api/forwarders` | routes/forwarders.js | Haulier register |
| `/api/destinations` | routes/destinations.js | Destination register |
| `/api/rateskn` | routes/rateskn.js | Kuehne & Nagel rate cards |
| `/api/costelements` | routes/costelements.js | SAP cost elements |
| `/api/costcenters` | routes/costcenters.js | SAP cost centres |
| `/api/costtypes` | routes/costtypes.js | Cost type definitions |
| `/api/filter-records` | routes/filterrecords.js | Generic table filter |
| `/api/related-records` | routes/relatedrecords.js | Parent→child drill-down |
| `/api/finance` | routes/finance.js | GL group management |
