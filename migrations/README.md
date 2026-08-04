# Knex migrations

One subfolder per database (`kongsberg/`, `production/`, `logistics/`), each
tracked independently via its own `knex_migrations` table — see
`knexfile.cjs` for connection config and the `--env` convention.

Run with:

```bash
npm run migrate:kongsberg
npm run migrate:production
npm run migrate:logistics
```

(or `npx knex migrate:latest --env <name> --knexfile knexfile.cjs` directly,
and `migrate:rollback` / `migrate:status` work the same way).

## Status

- **Kongsberg** / **Logistics**: empty so far. `sql/generate_schema_script.sql`
  is scripting the current live schema for both; once that's back, the first
  migration in each folder will be a single `NNNN_initial_schema.js` that
  reproduces it (schema + reference/lookup data — no transactional data).
- **Production**: has a working schema already (`sql/create_production_database.sql`,
  59 other `sql/*.sql` files hand-apply changes on top of it), just not yet
  translated into this Knex-tracked format. Converting it is the same shape
  of work as the initial-schema migration above, just from an existing
  source instead of a fresh export.

Once all three have an initial migration, every *new* schema change goes
through `npx knex migrate:make <description> --env <db> --knexfile knexfile.cjs`
instead of a new hand-written `sql/migrate_*.sql` file — this is what
replaces that ad-hoc convention going forward.
