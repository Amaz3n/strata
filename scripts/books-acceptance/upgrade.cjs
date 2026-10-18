// Populated upgrade (B00.2): seed a REPLAYED baseline workspace with synthetic
// data, fingerprint the money, apply every remaining migration, and prove the
// money did not move. The baseline workspace comes from
// `bootstrap-books-acceptance.cjs --baseline-file`; nothing here touches any
// database other than that workspace's isolated container.
const fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto"),
  { spawnSync } = require("node:child_process")
const { seedSql, ORG } = require("./upgrade-seed.cjs")
const { manifest } = require("./runtime.cjs")
const { CLI_VERSION } = require("./bootstrap.cjs")

const root = path.resolve(__dirname, "../..")
const digest = (x) => createHash("sha256").update(x).digest("hex")

// Everything a migration must never change about posted money.
const FINGERPRINT = `select json_build_object(
 'trialBalance',(select coalesce(json_agg(x order by x->>'code'),'[]') from (select json_build_object('code',a.code,'debit',sum(l.debit_cents),'credit',sum(l.credit_cents)) x
   from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
   where l.org_id='${ORG}' and e.status in ('posted','reversed') group by a.code) t),
 'journalLines',(select md5(coalesce(string_agg(e.posting_key||'|'||e.status||'|'||e.entry_date||'|'||l.line_no||'|'||a.code||'|'||l.debit_cents||'|'||l.credit_cents||'|'||coalesce(l.project_id::text,''),',' order by e.posting_key,l.line_no),''))
   from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id where l.org_id='${ORG}'),
 'invoices',(select json_agg(json_build_object('n',invoice_number,'status',status,'total',total_cents,'balance',balance_due_cents) order by invoice_number) from public.invoices where org_id='${ORG}'),
 'bills',(select json_agg(json_build_object('n',bill_number,'status',status,'total',total_cents,'paid',paid_cents) order by bill_number) from public.vendor_bills where org_id='${ORG}'),
 'payments',(select json_agg(json_build_object('key',idempotency_key,'amount',amount_cents,'status',status) order by idempotency_key) from public.payments where org_id='${ORG}'),
 'expenses',(select json_agg(json_build_object('date',expense_date,'amount',amount_cents) order by expense_date) from public.project_expenses where org_id='${ORG}')
)::text;`

function upgrade(workspace, { run = spawnSync } = {}) {
  workspace = path.resolve(workspace)
  const job = JSON.parse(fs.readFileSync(path.join(workspace, "bootstrap.json"), "utf8"))
  if (job.status !== "REPLAYED" || job.route !== "baseline" || !job.container.startsWith("supabase_db_arc-books-acceptance-"))
    throw Error("Upgrade requires a REPLAYED baseline acceptance workspace")
  const evidence = { schemaVersion: 1, route: "upgrade", workspace, instanceId: job.instanceId, container: job.container, steps: [], startedAt: new Date().toISOString() }
  const save = () => fs.writeFileSync(path.join(workspace, "upgrade.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 })
  const step = (phase, name, args, input, timeout = 60000) => {
    const r = run(name, args, { encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, cwd: workspace, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    const log = (r.stdout ?? "") + "\n" + (r.stderr ?? "")
    fs.writeFileSync(path.join(workspace, `upgrade-${phase}.log`), log, { mode: 0o600 })
    const ok = !r.error && r.status === 0
    evidence.steps.push({ phase, status: ok ? "PASSED" : "FAILED", sha256: digest(log) })
    save()
    if (!ok) throw Error(`${phase} failed; inspect upgrade-${phase}.log`)
    return (r.stdout ?? "").trim()
  }
  const psql = ["exec", "-i", job.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"]
  try {
    step("seed", "docker", psql, seedSql())
    const before = step("fingerprint-before", "docker", psql, FINGERPRINT)
    const baseline = new Set(job.inventory.migrations.map((m) => m.path))
    const remaining = manifest(root).migrations.filter((m) => !baseline.has(m.path))
    for (const file of remaining) {
      const bytes = fs.readFileSync(path.join(root, file.path))
      if (digest(bytes) !== file.sha256) throw Error("Upgrade input changed while staging")
      fs.writeFileSync(path.join(workspace, file.path), bytes, { mode: 0o600 })
    }
    evidence.appliedMigrations = remaining.map((m) => m.path)
    step("migration-up", "pnpm", ["dlx", `supabase@${CLI_VERSION}`, "migration", "up", "--local", "--include-all", "--workdir", workspace], undefined, 1200000)
    const after = step("fingerprint-after", "docker", psql, FINGERPRINT)
    evidence.fingerprintBefore = JSON.parse(before)
    evidence.fingerprintAfter = JSON.parse(after)
    evidence.moneyPreserved = before === after
    if (!evidence.moneyPreserved) throw Error("Posted money changed across the upgrade")
    evidence.status = "UPGRADED"
  } catch (error) {
    evidence.status = "FAILED"
    evidence.error = error.message
    throw error
  } finally {
    evidence.finishedAt = new Date().toISOString()
    save()
  }
  return evidence
}

module.exports = { upgrade, FINGERPRINT }
if (require.main === module) {
  try {
    const workspace = process.argv[process.argv.indexOf("--workspace") + 1]
    if (!workspace || process.argv.indexOf("--workspace") < 0) throw Error("Use --workspace REPLAYED_BASELINE_DIRECTORY")
    const result = upgrade(workspace)
    console.log(`${result.status}: ${result.appliedMigrations.length} migrations applied; money preserved; evidence ${workspace}/upgrade.json`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
