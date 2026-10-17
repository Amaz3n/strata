// RESTORE-02 — the whole-database restore drill (EP13-08), on the acceptance stack only.
//
// The acceptance database is dumped from one exported snapshot (pg_dump inside the
// stack's container, as its superuser), restored into a fresh database in the same
// container, and reconciled against that same snapshot: every public table's row
// count, and a content digest of every row of the operational records, the file rows
// and the financial receipts. The clock runs from the start of the dump to the
// restored database answering queries (RTO); the drill's recovery point is the
// snapshot itself (RPO 0 for this method). The drill database and the dump are
// removed afterwards, whatever happened.
//
// What this does not prove, and is confirmed by the operator: the production
// project's point-in-time-recovery tier and retention (the real RPO), and the object
// store's versioning and backups for the files those rows point at.
const { spawn, spawnSync } = require("node:child_process")

const DRILL_DATABASE = "restore_drill"
const DUMP_PATH = "/tmp/restore_drill.dump"
// Reconciled row by row (content digest). Every other public table is reconciled by count.
const DIGESTED = {
  operational: ["divisions", "communities", "lots", "projects", "lot_reservations", "prospects", "contacts", "contracts", "start_packages", "start_package_gates", "schedule_items",
    "commitments", "commitment_lines", "closings", "project_warranty_coverage", "warranty_requests", "warranty_service_visits", "daily_logs", "events", "audit_log", "outbox"],
  files: ["files", "file_links", "photos", "documents"],
  financial: ["invoices", "invoice_lines", "payments", "receipts", "vendor_bills", "bill_lines", "journal_entries", "journal_lines", "books_projection_receipts",
    "purchase_agreement_creation_receipts", "reservation_conversion_receipts", "po_receipts"],
}

function docker(kit, args, { input, timeout = 1800000 } = {}) {
  const r = spawnSync("docker", ["exec", "-i", kit.container, ...args], { input, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw Error(`${args[0]} failed: ${(r.stderr || r.error?.message || "").trim().slice(-1500)}`)
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim() }
}
const sql = (kit, database, text) => docker(kit, ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", database], { input: text }).stdout

/** A psql session held open: the snapshot the dump reads is exported from it, and the source side of the reconciliation is read in it. */
function holdSession(kit) {
  const child = spawn("docker", ["exec", "-i", kit.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres"])
  let out = "", err = ""
  child.stdout.on("data", (chunk) => { out += chunk })
  child.stderr.on("data", (chunk) => { err += chunk })
  const ask = (text) => new Promise((resolve, reject) => {
    const marker = `__drill_${Math.random().toString(36).slice(2)}`, from = out.length
    const timer = setInterval(() => {
      if (err) { clearInterval(timer); reject(Error(`Holder session: ${err.trim()}`)) }
      const at = out.indexOf(marker, from)
      if (at >= 0) { clearInterval(timer); resolve(out.slice(from, at).trim()) }
    }, 25)
    child.stdin.write(`${text}\n\\echo ${marker}\n`)
  })
  let closed = null
  const close = () => (closed ??= child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => { child.on("close", resolve); child.stdin.end("rollback;\n") }))
  return { ask, close }
}

/** Counts for every public table, and digests for the reconciled ones, as one JSON document (the source also counts its pg_cron jobs). */
function reconciliationQuery({ source }) {
  const digested = Object.values(DIGESTED).flat()
  return `select jsonb_build_object(
  'counts', (select jsonb_object_agg(c.relname, (xpath('/table/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, false, '')))[1]::text::bigint)
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition),
  'digests', (select jsonb_object_agg(t, (xpath('/table/row/d/text()', query_to_xml(format('select md5(coalesce(string_agg(md5(x::text), '''' order by x.id::text), '''')) d from public.%I x', t), false, false, '')))[1]::text)
    from unnest(${`array[${digested.map((t) => `'${t}'`).join(",")}]`}) t),
  'auth_users', (select count(*) from auth.users),
  'storage_objects', (select count(*) from storage.objects),
  'migrations', (select count(*) from supabase_migrations.schema_migrations),
  'marker', (select instance_id::text from books_acceptance.environment),
  'policies', (select count(*) from pg_policies where schemaname in ('public', 'storage')),
  'functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace),
  'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal),
  'cron_jobs', ${source ? "(select count(*) from cron.job)" : "null"}
)::text;`
}

async function wholeDatabaseDrill(kit, expected, check) {
  const { targets } = expected.inputs
  if (!/^supabase_db_arc-books-acceptance-[a-z0-9]+$/.test(kit.container)) throw Error("The drill runs only on an isolated acceptance container")
  const cleanup = () => {
    sql(kit, "postgres", `drop database if exists ${DRILL_DATABASE} with (force);`)
    docker(kit, ["rm", "-f", DUMP_PATH])
  }
  cleanup()
  const holder = holdSession(kit)
  try {
    const startedAt = Date.now()
    const snapshotId = await holder.ask("begin isolation level repeatable read read only; select pg_export_snapshot();")
    const snapshotAt = await holder.ask("select now()::text;")
    // The dump reads the exported snapshot; it is running before the source side is read.
    const dump = new Promise((resolve, reject) => {
      // pg_cron lives only in the cluster's `postgres` database, so a restore into a fresh database
      // leaves it out; its job table is counted on the source and reported beside the drill.
      const child = spawn("docker", ["exec", kit.container, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "-Fc", "-Z", "1", `--snapshot=${snapshotId}`, "--exclude-extension=pg_cron", "--exclude-schema=cron", "-f", DUMP_PATH])
      let stderr = ""
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (code) => (code === 0 ? resolve(Date.now()) : reject(Error(`pg_dump: ${stderr.trim().slice(-1500)}`))))
    })
    const sourceAt = Date.now()
    const source = JSON.parse(await holder.ask(reconciliationQuery({ source: true })))
    const sourceSeconds = (Date.now() - sourceAt) / 1000
    const dumpedAt = await dump
    await holder.close()
    const dumpBytes = Number(docker(kit, ["stat", "-c", "%s", DUMP_PATH]).stdout)

    sql(kit, "postgres", `create database ${DRILL_DATABASE} template template0;`)
    const restoreAt = Date.now()
    const restore = spawnSync("docker", ["exec", kit.container, "pg_restore", "-U", "supabase_admin", "-d", DRILL_DATABASE, "-j", String(targets.restoreJobs), DUMP_PATH], { encoding: "utf8", timeout: 3600000, maxBuffer: 64 * 1024 * 1024 })
    const restoreErrors = (restore.stderr.match(/^pg_restore: error: .*$/gm) ?? []).map((line) => line.replace(/^pg_restore: error: /, ""))
    // The restored database must answer the application's own questions before the clock stops.
    const answering = sql(kit, DRILL_DATABASE, "select (select count(*) from public.projects) > 0 and (select count(*) from public.orgs) > 0;") === "t"
    const restoredAt = Date.now()
    const restored = JSON.parse(sql(kit, DRILL_DATABASE, reconciliationQuery({ source: false })))
    const finishedAt = Date.now()

    const tables = Object.keys(source.counts)
    const countMismatches = tables.filter((t) => source.counts[t] !== restored.counts[t])
    const missingTables = tables.filter((t) => !(t in restored.counts))
    const digestMismatches = Object.keys(source.digests).filter((t) => source.digests[t] !== restored.digests[t])
    const rowsReconciled = Object.values(source.counts).reduce((sum, n) => sum + Number(n), 0)
    const rto = { dumpSeconds: Math.round((dumpedAt - startedAt) / 1000), restoreSeconds: Math.round((restoredAt - restoreAt) / 1000), totalSeconds: Math.round((restoredAt - startedAt) / 1000), reconcileSeconds: Math.round((finishedAt - restoredAt) / 1000 + sourceSeconds) }

    check.equal("the restore exits cleanly without errors and the restored database answers", { exitStatus: 0, errors: [], answering: true }, { exitStatus: restore.status, errors: restoreErrors.slice(0, 20), answering })
    check.equal("row security policies, functions and triggers come back, every one", { policies: source.policies, functions: source.functions, triggers: source.triggers },
      { policies: restored.policies, functions: restored.functions, triggers: restored.triggers })
    const counted = tables.filter((t) => Number.isInteger(source.counts[t])).length
    check.equal("every public table comes back with the same row count", { tables: true, counted: tables.length, missingTables: [], countMismatches: [] }, { tables: tables.length >= targets.minimumTables, counted, missingTables, countMismatches })
    const digested = Object.values(source.digests).filter((digest) => /^[0-9a-f]{32}$/.test(digest ?? "")).length
    check.equal("operational records, file rows and financial receipts come back row for row", { digested: Object.keys(source.digests).length, digestMismatches: [] }, { digested, digestMismatches })
    check.equal("auth users, stored objects, the migration ledger and the isolation marker come back", { authUsers: true, storageObjects: true, migrations: true, marker: true },
      { authUsers: source.auth_users === restored.auth_users, storageObjects: source.storage_objects === restored.storage_objects, migrations: source.migrations === restored.migrations, marker: source.marker === restored.marker })
    check.equal(`recovery time is within the frozen ${targets.recoveryTimeMinutes}-minute target`, true, rto.totalSeconds <= targets.recoveryTimeMinutes * 60)
    return {
      snapshotAt, rto, rpo: { method: "pg_dump of one exported snapshot", drillRecoveryPointSeconds: 0, production: "operator-confirmed: Supabase PITR tier and retention" },
      database: { tables: tables.length, policies: source.policies, functions: source.functions, triggers: source.triggers, rowsReconciled, digestedTables: Object.keys(source.digests).length, dumpMegabytes: Math.round(dumpBytes / 1048576) },
      reconciled: Object.fromEntries(Object.entries(DIGESTED).map(([group, list]) => [group, Object.fromEntries(list.map((t) => [t, Number(source.counts[t])]))])),
      outsideTheDrill: { cronJobs: source.cron_jobs, reason: "pg_cron schedules live in the cluster's postgres database; a production restore (PITR) brings them back with it" },
      operatorConfirms: ["Supabase PITR tier and retention on the production project (the real RPO)", "R2 bucket versioning and backup for the objects file rows point at"],
    }
  } finally {
    await holder.close()
    cleanup()
  }
}

module.exports = { id: "RESTORE-02", subcases: { "whole-database-restore-drill": wholeDatabaseDrill } }
