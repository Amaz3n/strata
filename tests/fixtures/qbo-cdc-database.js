const fs = require("node:fs")
const { PGlite } = require("@electric-sql/pglite")
const read = (name) => fs.readFileSync(`supabase/migrations/${name}`, "utf8")
const migration = read("20261005050640_qbo_cdc_recovery.sql")
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

async function cdcDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.role() returns text language sql as $$select current_user::text$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table orgs(id uuid primary key); create table app_users(id uuid primary key);
    create table divisions(id uuid primary key,org_id uuid); create table communities(id uuid primary key,org_id uuid);
    create table projects(id uuid primary key,org_id uuid,division_id uuid,phase text);
    create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid);
    create table invoices(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table project_expenses(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table vendor_bills(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table payments(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create function is_org_member(uuid) returns boolean language sql stable as $$select $1::text=current_setting('test.org_id',true)$$;
    create function tg_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
  `)
  const connections = read("20260719011735_accounting_connections.sql")
  await db.exec(connections.slice(0, connections.indexOf("insert into public.accounting_connections")))
  await db.exec(connections.slice(connections.indexOf("create or replace function")))
  await db.exec(
    read("20260724010343_accounting_abstraction_hardening.sql").match(
      /alter table public\.accounting_connections\n  alter column[\s\S]*?;/,
    )[0],
  )
  const snapshot = read("20260517092101_remote_schema.sql")
  await db.exec(snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."qbo_sync_records" \([\s\S]*?\n\);/)[0])
  await db.exec(`alter table qbo_sync_records add primary key(id); alter table qbo_sync_records add column pushable boolean default true;
    create unique index qbo_sync_records_entity_idx on qbo_sync_records(org_id,entity_type,entity_id);
    alter table qbo_sync_records enable row level security;`)
  await db.exec(snapshot.match(/CREATE POLICY "qbo_sync_records_access"[^;]*;/)[0])
  const sync = read("20260719011822_accounting_sync_records.sql")
  await db.exec(sync.slice(0, sync.indexOf("create or replace function")))
  const map = read("20260719011920_accounting_entity_map.sql")
  await db.exec(map.slice(0, map.indexOf("with active_connection")))
  await db.exec(read("20261005033613_accounting_application_authorization.sql"))
  await db.exec(snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."qbo_webhook_events" \([\s\S]*?\n\);/)[0])
  for (const sql of snapshot.matchAll(/ALTER TABLE ONLY "public"\."qbo_webhook_events"[\s\S]*?;/g)) await db.exec(sql[0])
  await db.exec(snapshot.match(/ALTER TABLE "public"\."qbo_webhook_events" ENABLE ROW LEVEL SECURITY;/)[0])
  await db.exec(snapshot.match(/CREATE POLICY "qbo_webhook_events_access"[^;]*;/)[0])
  for (const sql of snapshot.matchAll(/GRANT ALL ON TABLE "public"\."qbo_webhook_events"[^;]*;/g)) await db.exec(sql[0])
  await db.exec(read("20260715200002_qbo_inbound_reconcile_retry.sql").match(/alter table public\.qbo_webhook_events[\s\S]*?;/)[0])
  await db.exec(read("20261005040538_qbo_webhook_provider_receipts.sql"))
  const now = (await db.query("select clock_timestamp() now")).rows[0].now
  const org = id(1),
    connection = id(2),
    otherOrg = id(3),
    otherConnection = id(4)
  await db.query("insert into orgs(id) values($1),($2)", [org, otherOrg])
  await db.query(
    `insert into accounting_connections(id,org_id,external_account_id,access_token,refresh_token,token_expires_at,settings)
    values($1,$2,'realm','synthetic-access','synthetic-refresh',$3,'{"manual_setting":true}'),($4,$5,'other-realm','synthetic-other','synthetic-other',$3,'{}')`,
    [connection, org, now, otherConnection, otherOrg],
  )
  const calls = []
  const f = {
    db,
    org,
    connection,
    otherOrg,
    otherConnection,
    now,
    calls,
    install: () => db.exec(migration),
    async role(role, work) {
      await db.exec(`set role ${role}`)
      try {
        return await work()
      } finally {
        await db.exec("reset role")
      }
    },
    async claim(extra = {}) {
      const args = {
        org,
        connection,
        realm: "realm",
        original: null,
        since: new Date(Date.parse(now) - 86400000).toISOString(),
        checkpoint: now,
        reasons: [],
        ...extra,
      }
      return (
        await db.query("select claim_qbo_cdc_run($1,$2,$3,$4,$5,$6,$7) run", [
          args.org,
          args.connection,
          args.realm,
          args.original,
          args.since,
          args.checkpoint,
          args.reasons,
        ])
      ).rows[0].run
    },
    async persist(run, change, receipt = id(100 + run.version), extra = {}) {
      const args = {
        org: run.org_id,
        connection: run.connection_id,
        realm: run.realm_id,
        token: run.lease_token,
        version: run.version,
        ...extra,
      }
      return (
        await db.query("select persist_qbo_cdc_progress($1,$2,$3,$4,$5,$6,$7,$8) result", [
          args.org,
          args.connection,
          args.realm,
          run.id,
          args.token,
          args.version,
          receipt,
          JSON.stringify(change),
        ])
      ).rows[0].result
    },
    async settings() {
      return (await db.query("select settings from accounting_connections where id=$1", [connection])).rows[0].settings
    },
    async queue() {
      return (await db.query("select * from qbo_webhook_events order by event_id")).rows
    },
    async candidates() {
      return (await db.query("select * from qbo_cdc_candidates order by id")).rows
    },
  }
  return f
}
module.exports = { cdcDatabase, id, migration }
