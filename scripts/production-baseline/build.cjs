#!/usr/bin/env node
// Builds a production baseline migration: production's schema (a Supabase CLI
// schema dump of production), the seeded reference rows (a data dump of a fresh
// replay, so no customer data), and what dumps never carry (roles, storage
// buckets and policies, cron jobs; from extras.sql run against production).
// Usage:
//   node scripts/production-baseline/build.cjs --schema PROD_SCHEMA.sql \
//     --data REPLAY_DATA.sql --extras EXTRAS.json --out supabase/migrations/<version>_production_baseline.sql
// Then prove it: replay the baseline alone and compare fingerprint.sql output
// with production's (docs/books-operations.md, "Rebaselining").
const fs = require("node:fs")

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const [schemaFile, dataFile, extrasFile, out] = ["--schema", "--data", "--extras", "--out"].map(arg)
if (!schemaFile || !dataFile || !extrasFile || !out) throw Error("Use --schema FILE --data FILE --extras FILE --out FILE")

const extras = JSON.parse(fs.readFileSync(extrasFile, "utf8"))
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'"
const role = (name) => (name === "public" ? "public" : `"${name}"`)

// pg_dump writes each object's grants as if it had been created with none. A
// Supabase database's default privileges would hand anon and authenticated
// access to every object as the dump creates it, including service-only
// functions the migrations revoked, so they are cleared first; the dump's
// closing ALTER DEFAULT PRIVILEGES statements restore them.
const clearDefaults = ["tables", "sequences", "functions"]
  .map((kind) => `alter default privileges for role postgres in schema public revoke all on ${kind} from anon, authenticated, service_role;`)
  .join("\n")

const roles = extras.roles
  .map((name) => `do $$ begin if not exists (select 1 from pg_roles where rolname = ${quote(name)}) then create role "${name}" nologin; end if; end $$;`)
  .join("\n")

const storage = [
  ...extras.buckets.map((b) => `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (${quote(b.id)}, ${quote(b.name)}, ${b.public}, ${b.limit ?? "null"}, ${b.mimes ? `array[${b.mimes.map(quote).join(", ")}]` : "null"}) on conflict (id) do nothing;`),
  ...extras.storage_policies.map((p) => `create policy "${p.name}" on storage.objects as ${p.permissive.toLowerCase()} for ${p.cmd.toLowerCase()} to ${p.roles.map(role).join(", ")}` +
    (p.qual ? ` using (${p.qual})` : "") + (p.with_check ? ` with check (${p.with_check})` : "") + ";"),
].join("\n")

const cron = extras.cron.map((job) => `select cron.schedule(${quote(job.name)}, ${quote(job.schedule)}, ${quote(job.command)});`).join("\n")

fs.writeFileSync(out, [
  `-- Production baseline (${new Date().toISOString().slice(0, 10)}): production's schema, the seeded reference`,
  "-- rows, and the roles, storage and cron jobs dumps leave out. Built by",
  "-- scripts/production-baseline/build.cjs; the migrations it replaces are kept in",
  "-- supabase/migrations-history/ and never applied. Production records only this",
  "-- version in its migration ledger.",
  "",
  clearDefaults,
  "",
  roles,
  "",
  fs.readFileSync(schemaFile, "utf8"),
  fs.readFileSync(dataFile, "utf8"),
  "-- Storage buckets and policies.",
  storage,
  "",
  "-- Scheduled jobs.",
  cron,
  "",
].join("\n"))
console.log(`Wrote ${out}`)
