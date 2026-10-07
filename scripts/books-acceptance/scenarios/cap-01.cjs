// CAP-01 — the projector at a large builder's volume: work per run follows what
// changed, not the size of the ledger, and no interruption, concurrency, tie or
// late commit posts a source twice or never.
const path = require("node:path")
const { spawn } = require("node:child_process")
const { app } = require("./shared.cjs")
const { jobOrg, createBill, editBill, incrementalJob, projectionJob, glId } = require("./status-01.cjs").helpers

// Counts every PostgREST request the projector makes while a measurement is
// open: rows returned by reads, and calls per RPC.
const meter = { on: false, requests: 0, rows: 0, rpc: {} }
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init)
  if (!meter.on) return response
  const url = String(input?.url ?? input)
  if (!url.includes("/rest/v1/")) return response
  meter.requests += 1
  const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(url)
  if (rpc) meter.rpc[rpc[1]] = (meter.rpc[rpc[1]] ?? 0) + 1
  else if ((init?.method ?? "GET") === "GET") {
    const body = await response.clone().json().catch(() => null)
    meter.rows += Array.isArray(body) ? body.length : body ? 1 : 0
  }
  return response
}
async function metered(work) {
  Object.assign(meter, { on: true, requests: 0, rows: 0, rpc: {} })
  try { await work() } finally { meter.on = false }
  return { requests: meter.requests, rows: meter.rows, projections: meter.rpc.project_books_fact_and_journal_atomic ?? 0, receipts: meter.rpc.record_books_projection_receipt ?? 0 }
}

// One bill made through the product, then cloned (header, line, job cost) to the
// volume. A single closing update stamps every clone with the same updated_at, so
// the whole set ties on the projection cursor.
async function volumeOrg(kit, name, input) {
  const org = await jobOrg(kit, name, ["2026-07"])
  const template = await createBill(kit, org, input.billDate, input.cents)
  const { q } = kit
  // Generated columns cannot be inserted, so each clone lists the table's
  // ordinary columns from the catalog.
  kit.sql(`begin;
create temp table cap_map on commit drop as select g, gen_random_uuid() bill_id, gen_random_uuid() line_id from generate_series(2, ${input.bills}) g;
create function pg_temp.cap_clone(p_table text, p_from text) returns void language plpgsql as $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ',' order by ordinal_position) into cols from information_schema.columns
  where table_schema = 'public' and table_name = p_table and is_generated = 'NEVER';
  execute format('insert into public.%I (%s) select %s from (select (jsonb_populate_record(null::public.%I, src)).* from (%s) f) r', p_table, cols, cols, p_table, p_from);
end $$;
select pg_temp.cap_clone('vendor_bills', $q$select to_jsonb(t) || jsonb_build_object('id', m.bill_id, 'bill_number', 'CAP-' || m.g) src from public.vendor_bills t, cap_map m where t.id = ${q(template)}$q$);
select pg_temp.cap_clone('bill_lines', $q$select to_jsonb(l) || jsonb_build_object('id', m.line_id, 'bill_id', m.bill_id) src from public.bill_lines l, cap_map m where l.bill_id = ${q(template)}$q$);
select pg_temp.cap_clone('job_cost_entries', $q$select to_jsonb(j) || jsonb_build_object('id', gen_random_uuid(), 'source_id', m.line_id::text) src from public.job_cost_entries j join public.bill_lines l on l.id::text = j.source_id, cap_map m where l.bill_id = ${q(template)} and j.source_type = 'vendor_bill_line' and j.status = 'posted'$q$);
commit;`)
  // An hour ago, past the late-commit window, so the runs measure a settled
  // ledger. Replica mode keeps the updated_at trigger from restamping the rows.
  kit.sql(`begin; set local session_replication_role = replica;
update public.vendor_bills set updated_at = now() - interval '1 hour' where org_id = ${q(org.orgId)};
commit;`, "supabase_admin")
  return { org, template }
}
const ledger = (kit, org) => kit.rows(`select count(*) filter (where e.status = 'posted' and e.source_type = 'vendor_bill')::int posted,
  count(distinct e.source_id) filter (where e.status = 'posted' and e.source_type = 'vendor_bill')::int bills,
  (select count(*)::int from public.books_projection_receipts r where r.org_id = ${kit.q(org.orgId)} and r.source_type = 'vendor_bill') receipts,
  (select coalesce(sum(l.credit_cents - l.debit_cents), 0)::bigint from public.journal_lines l join public.gl_accounts a on a.id = l.account_id where l.org_id = ${kit.q(org.orgId)} and a.code = '2000') ap_cents
  from public.journal_entries e where e.org_id = ${kit.q(org.orgId)}`)[0]
const exactlyOnce = (row, bills, cents) => ({ postedEntries: row.posted, distinctBills: row.bills, receipts: row.receipts, apCents: Number(row.ap_cents), expected: { bills, apCents: bills * cents } })

async function firstRunTiesIdleAndOneChange(kit, expected, check) {
  const input = expected.inputs
  const want = expected.expected
  const { org, template } = await volumeOrg(kit, "CAP-01 volume", input)
  const first = await metered(() => incrementalJob(kit, org))
  check.equal(`${input.bills} tied bills post exactly once`, want["first-run"], { ...exactlyOnce(ledger(kit, org), input.bills, input.cents), projections: first.projections })
  const idle = await metered(() => incrementalJob(kit, org))
  check.equal("an idle run reads only configuration and posts nothing", want.idle, { rowsUnderBudget: idle.rows <= input.idleRowBudget, projections: idle.projections, receipts: idle.receipts })
  await editBill(kit, org, template, { actual_lines: [{ description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, "5020") }] })
  const change = await metered(() => incrementalJob(kit, org))
  check.equal("one changed bill: one projection, reads bounded by the change", want["one-change"], { rowsUnderBudget: change.rows <= input.changeRowBudget, projections: change.projections })
  return { orgId: org.orgId, measurements: { first, idle, change } }
}

// A worker killed mid-run leaves a prefix posted; the next ordinary run finishes
// the rest without posting anything twice.
async function interruptedRunResumes(kit, expected, check) {
  const input = expected.inputs
  const { org } = await volumeOrg(kit, "CAP-01 interrupted", input)
  const worker = spawn(process.execPath, [path.join(__dirname, "..", "project-worker.cjs"), "--container", kit.container, "--api-url", kit.apiUrl, "--org", org.orgId], { stdio: "ignore" })
  const receipts = () => Number(kit.rows(`select count(*) n from public.books_projection_receipts where org_id = ${kit.q(org.orgId)}`)[0].n)
  const started = Date.now()
  while (receipts() < input.killAfterReceipts && Date.now() - started < 120000) await new Promise((resolve) => setTimeout(resolve, 200))
  worker.kill("SIGKILL")
  await new Promise((resolve) => worker.once("exit", resolve))
  const atKill = receipts()
  await incrementalJob(kit, org)
  check.equal("after the kill, one ordinary run completes every bill exactly once", expected.expected, { killedPartway: atKill >= input.killAfterReceipts && atKill < input.bills, ...exactlyOnce(ledger(kit, org), input.bills, input.cents) })
  return { orgId: org.orgId, receiptsAtKill: atKill }
}

async function concurrentWorkers(kit, expected, check) {
  const input = expected.inputs
  const { org } = await volumeOrg(kit, "CAP-01 concurrent", input)
  const { projectJournal } = app("books/projector")
  const runs = await Promise.allSettled(Array.from({ length: input.workers }, () => kit.service(() => projectJournal(org.orgId))))
  await incrementalJob(kit, org)
  check.equal(`${input.workers} concurrent workers post each bill once`, expected.expected, { workersFinished: runs.filter((run) => run.status === "fulfilled").length, ...exactlyOnce(ledger(kit, org), input.bills, input.cents) })
  return { orgId: org.orgId }
}

// A write whose transaction started before an already-projected change commits
// after the run: its updated_at is older than the cursor. The next run still
// sees it.
async function lateCommit(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "CAP-01 late commit", ["2026-07"])
  const late = await createBill(kit, org, input.billDate, input.cents)
  const other = await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  const writer = spawn("docker", ["exec", "-i", kit.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "ignore", "ignore"] })
  writer.stdin.end(`begin; update public.vendor_bills set bill_date = '${input.lateDate}' where id = '${late}'; select pg_sleep(${input.holdSeconds}); commit;`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await editBill(kit, org, other, { bill_date: input.otherDate })
  await incrementalJob(kit, org)
  await new Promise((resolve) => writer.once("exit", resolve))
  await incrementalJob(kit, org)
  const dates = Object.fromEntries(kit.rows(`select source_id, entry_date from public.journal_entries where org_id = ${kit.q(org.orgId)} and source_type = 'vendor_bill' and status = 'posted'`).map((row) => [row.source_id === late ? "late" : "other", row.entry_date]))
  check.equal("the late-committed change posts on the next ordinary run", expected.expected, { late: dates.late, other: dates.other })
  return { orgId: org.orgId }
}

// The nightly pass skips what is unchanged without a database call each, and
// still finds a change that no trigger announced.
async function nightlyPass(kit, expected, check) {
  const input = expected.inputs
  const { org, template } = await volumeOrg(kit, "CAP-01 nightly", input)
  await incrementalJob(kit, org)
  const unchanged = await metered(() => projectionJob(kit, org))
  const { q } = kit
  kit.sql(`insert into public.divisions(org_id, name) values (${q(org.orgId)}, 'North division');
update public.projects set division_id = (select id from public.divisions where org_id = ${q(org.orgId)} and name = 'North division') where id = ${q(org.projectId)};`)
  const quiet = await metered(() => incrementalJob(kit, org))
  const full = await metered(() => projectionJob(kit, org))
  const tagged = Number(kit.rows(`select count(*) n from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.org_id = ${q(org.orgId)} and e.status = 'posted' and e.source_type = 'vendor_bill' and l.dimensions ->> 'division_name' = 'North division' and e.source_id = ${q(template)}`)[0].n)
  check.equal("unchanged full pass makes no projection calls", expected.expected.unchanged, { projections: unchanged.projections, receipts: unchanged.receipts })
  check.equal("an unannounced dimension change waits for the nightly pass, which re-posts every affected bill", expected.expected.unannounced, { incrementalProjections: quiet.projections, fullProjections: full.projections, templateTagged: tagged > 0 })
  return { orgId: org.orgId, measurements: { unchanged, quiet, full } }
}

// The cron run has a time budget. A company it does not reach gets an open
// finding (which holds its close), is first in line next time, and its next
// completed run clears the finding.
async function timeBudget(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "CAP-01 time budget", ["2026-07"])
  await createBill(kit, org, input.billDate, input.cents)
  const { runBooksProjection } = app("books/projector")
  const { recordProjectionFailures } = app("books/reconciliation")
  const closeRefusal = async () => {
    try { await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId)); return "closed" }
    catch (error) { return /reconciliation issues/i.test(error.message) ? "held by open findings" : `refused: ${error.message.slice(0, 120)}` }
  }
  const findings = () => kit.rows(`select category from public.accounting_reconciliation_items where org_id = ${kit.q(org.orgId)} and entity_type = 'books_projection_run' and status <> 'resolved'`).map((row) => row.category)
  const posted = () => Number(kit.rows(`select count(*) n from public.journal_entries where org_id = ${kit.q(org.orgId)} and source_type = 'vendor_bill' and status = 'posted'`)[0].n)
  const expired = await kit.service(() => runBooksProjection({ deadline: Date.now() - 1 }))
  await kit.service(() => recordProjectionFailures(expired.results))
  const unreached = { companiesReached: expired.results.filter((result) => result.failures.every((failure) => failure.sourceType !== "books_projection_run")).length, findings: findings(), posted: posted(), close: await closeRefusal() }
  const startedAt = Date.now()
  const next = await kit.service(() => runBooksProjection({ deadline: Date.now() + input.budgetMs }))
  await kit.service(() => recordProjectionFailures(next.results))
  const position = next.results.findIndex((result) => result.orgId === org.orgId)
  check.equal("an expired budget reaches no company and leaves each with an open finding that holds the close", expected.expected.unreached, unreached)
  check.equal("the next run completes it and clears the finding", expected.expected.next, { reached: position >= 0 && next.results[position].failures.every((failure) => failure.sourceType !== "books_projection_run"), findings: findings(), posted: posted() })
  return { orgId: org.orgId, companies: next.results.length, secondsForAllCompanies: Math.round((Date.now() - startedAt) / 1000), position }
}

// A source that failed to post is read again on the next ordinary run even after
// newer work has moved the cursor past it, so a transient failure heals in
// minutes. The failure is a database refusal installed for this one bill and
// removed again, which cures it without touching the bill.
async function failedSourceRetries(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "CAP-01 failed source", ["2026-07"])
  const failing = await createBill(kit, org, input.billDate, input.cents)
  // An hour old, so the late-commit window cannot be what reads it again.
  kit.sql(`begin; set local session_replication_role = replica;
update public.vendor_bills set updated_at = now() - interval '1 hour' where id = ${kit.q(failing)};
commit;`, "supabase_admin")
  const trigger = `cap_refuse_${failing.replace(/-/g, "")}`
  kit.sql(`create function public.${trigger}() returns trigger language plpgsql as $$ begin raise exception 'Simulated transient database failure'; end $$;
create trigger ${trigger} before insert on public.accounting_facts for each row when (new.source_id = ${kit.q(failing)}) execute function public.${trigger}();`, "supabase_admin")
  await incrementalJob(kit, org)
  const findings = () => kit.rows(`select category from public.accounting_reconciliation_items where org_id = ${kit.q(org.orgId)} and entity_id = ${kit.q(failing)} and status <> 'resolved'`).map((row) => row.category)
  const posted = () => kit.rows(`select entry_date from public.journal_entries where org_id = ${kit.q(org.orgId)} and source_id = ${kit.q(failing)} and status = 'posted'`).map((row) => row.entry_date)
  const failed = { findings: findings(), posted: posted() }
  await createBill(kit, org, input.laterBillDate, input.cents)
  await incrementalJob(kit, org)
  kit.sql(`drop trigger ${trigger} on public.accounting_facts; drop function public.${trigger}();`, "supabase_admin")
  await incrementalJob(kit, org)
  check.equal("the failed bill posts on the next ordinary run once the failure clears", expected.expected, { failed, afterCure: { findings: findings(), posted: posted() } })
  return { orgId: org.orgId }
}

module.exports = {
  id: "CAP-01",
  subcases: {
    "first-run-ties-idle-and-one-change": firstRunTiesIdleAndOneChange,
    "interrupted-run-resumes": interruptedRunResumes,
    "concurrent-workers": concurrentWorkers,
    "late-commit": lateCommit,
    "nightly-pass": nightlyPass,
    "time-budget": timeBudget,
    "failed-source-retries": failedSourceRetries,
  },
}
