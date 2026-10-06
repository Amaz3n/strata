const fs = require("node:fs")
const { cdcDatabase, id } = require("./qbo-cdc-database")
const read = (name) => fs.readFileSync(`supabase/migrations/${name}`, "utf8")
const migration = read("20261005053644_qbo_import_completion_fences.sql")

async function importDatabase(t) {
  const f = await cdcDatabase(t)
  const snapshot = read("20260517092101_remote_schema.sql")
  // Keep the actual imported financial column definitions, without installing
  // unrelated domains/production data. Q04 only tests existing owned import RPCs.
  for (const table of ["invoices", "payments", "project_expenses", "vendor_bills"]) {
    const ddl = snapshot.match(new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${table}" \\([\\s\\S]*?\\n\\);`))[0]
    const existing = new Set(
      (
        await f.db.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [table])
      ).rows.map((row) => row.column_name),
    )
    for (const line of ddl.split("\n")) {
      const column = line.match(/^    "([a-z_]+)" (.*?)(?:,)?$/)
      if (column && !existing.has(column[1]))
        await f.db.exec(`alter table ${table} add column "${column[1]}" ${column[2].replace(/,$/, "")}`)
    }
  }
  await f.db.exec(snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."invoice_lines" \([\s\S]*?\n\);/)[0])
  await f.db.exec(
    "alter table invoice_lines add primary key(id); create table cost_codes(id uuid primary key); create table project_financial_settings(org_id uuid,project_id uuid,cost_codes_enabled boolean); grant select on project_financial_settings to authenticated,service_role",
  )
  await f.db.exec(snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."bill_lines" \([\s\S]*?\n\);/)[0])
  await f.db.exec("alter table bill_lines add primary key(id)")
  await f.db.exec(
    read("20260610120000_add_project_expense_lines.sql").match(
      /create table if not exists public\.project_expense_lines \([\s\S]*?\n\);/,
    )[0],
  )
  await f.db.exec(read("20260604004000_add_bill_line_project_allocation.sql").match(/alter table public\.bill_lines[\s\S]*?;/)[0])
  const coding = read("20260719012456_accounting_coding_backfill.sql")
  for (const alter of coding.matchAll(/alter table public\.(?:vendor_bills|project_expenses)[\s\S]*?;/g)) await f.db.exec(alter[0])
  await f.db.exec(read("20260908020000_accounting_import_recovery.sql").match(/alter table public\.project_expense_lines[\s\S]*?;/)[0])
  const claims = read("20260724010343_accounting_abstraction_hardening.sql")
  const start = claims.indexOf("create table if not exists public.accounting_import_claims")
  const end = claims.indexOf("-- Cost-code memories", start)
  await f.db.exec(claims.slice(start, end))
  // Original sync ledger has a legacy unique index. The real neutral key used
  // by financial import SQL is the source-defined B5 connection-aware index.
  await f.db.exec(claims.match(/create unique index if not exists accounting_sync_records_connection_entity_idx[\s\S]*?;/)[0])
  const owned = read("20260908020000_accounting_import_recovery.sql")
  for (const name of ["accounting_persist_import_row", "accounting_persist_import_children", "accounting_adopt_import_identity"]) {
    const definition = owned.slice(owned.indexOf(`create or replace function public.${name}(`))
    await f.db.exec(definition.slice(0, definition.indexOf("$$;")) + "$$;")
    for (const grant of owned.matchAll(/(?:revoke|grant)[^;]*on function[^;]*;/gi))
      if (grant[0].includes(`public.${name}(`)) await f.db.exec(grant[0])
  }
  await f.db.exec(
    "create function reconcile_accounting_invoice_opening_payment(p_org_id uuid,p_invoice_id uuid) returns void language sql as $$select$$; revoke all on function reconcile_accounting_invoice_opening_payment(uuid,uuid) from public,anon,authenticated; grant execute on function reconcile_accounting_invoice_opening_payment(uuid,uuid) to service_role",
  )
  // User financial reads retain synthetic membership RLS; identity/queue writes
  // retain the exact Q02/Q03 denials installed by the base fixture.
  for (const table of [
    "invoices",
    "payments",
    "project_expenses",
    "vendor_bills",
    "projects",
    "invoice_lines",
    "bill_lines",
    "project_expense_lines",
  ]) {
    await f.db.exec(
      `alter table ${table} enable row level security; create policy fixture_member on ${table} to authenticated using(is_org_member(org_id)) with check(is_org_member(org_id)); grant select,insert,update,delete on ${table} to authenticated; grant all on ${table} to service_role`,
    )
  }
  return { ...f, installCompletion: () => f.db.exec(migration), id }
}
module.exports = { importDatabase, id, migration }
