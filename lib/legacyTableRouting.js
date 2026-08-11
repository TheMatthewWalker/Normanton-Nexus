// Resolves a server-allowlisted table name to the pool + schema it lives
// under, for the three generic drill-down/filter/export routes
// (routes/relatedrecords.js, routes/filterrecords.js, routes/exportxlsx.js)
// that take an arbitrary table name from a fixed allowlist and query
// `<schema>.<tableName>` directly. Before the Kongsberg/Production/Logistics
// -> Nexus/NexusOperations/NexusArchive restructure a single default pool
// could serve every allowlisted table (they were all one database); now the
// legacy per-process tables (Mixing/Extrusion/Convo/Ewald/Firewall/etc.)
// live in NexusArchive while the old Logistics shipment/staging tables live
// in NexusOperations' .log schema, so each lookup has to resolve its own
// pool per call rather than reusing one connection for the whole request.
import { getNexusArchivePool, getNexusOperationsPool } from '../config.js';

const LOG_SCHEMA_TABLES = new Set([
  'Staging', 'StagingItems',
  'ShipmentMain', 'ShipmentLink', 'ShipmentCost',
  'PalletMain', 'PalletPackages', 'DeliveryMain', 'DeliveryLink',
]);

export function resolveLegacyTablePool(tableName) {
  return LOG_SCHEMA_TABLES.has(tableName)
    ? { getPool: getNexusOperationsPool, schema: 'log' }
    : { getPool: getNexusArchivePool, schema: 'dbo' };
}
