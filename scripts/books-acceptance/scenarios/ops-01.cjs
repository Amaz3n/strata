// OPS-01 — Arc runs a first builder's background work fairly and an operator can see and recover it (EP13-03, -05, -06).
//
//   skewed-backlog-is-claimed-fairly          one organization's large backlog does not hold another's few jobs behind it:
//                                              each claim takes turns across organizations and the rotation carries over
//   cancelled-cutover-stops-between-homes     a running Open-WIP cutover shows its progress, stops at the next home when the
//                                              operator cancels, keeps every home it built with its receipt, and Commit again
//                                              finishes it from those receipts
//   bulk-mutations-are-rate-limited           an organization over its hourly budget of import files is refused before any
//                                              write, with how long to wait; an earlier window's count does not refuse
//   dead-run-is-timed-out-not-never-started   a scheduled run whose process died is running until its deadline, then timed out
//                                              (reconciled and counted), and reported apart from a job the scheduler stopped starting
//   failed-units-show-with-a-recovery-that-works
//                                              a cutover that failed and a notification whose delivery exhausted its retries are
//                                              listed for the operator with their safe recovery, and that recovery finishes them
//   members-cannot-forge-job-state            an owner cannot complete, requeue, delete or claim jobs, write job runs, request a
//                                              cancellation or read other tenants' backlog through the data API; it still queues
//                                              and reorders its own pending work
//
// SQL writes only what no service writes here: the backlog of probe jobs (a job type no worker claims), the lock that
// holds one lot, the passage of time (a lapsed claim or deadline, an earlier window's count, a run four days ago), the
// state an exhausted retry leaves behind, and cleanup of the probe jobs. The killed run is a real process, SIGKILLed.
const { spawn } = require("node:child_process")
const path = require("node:path")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const cutover = require("./cutover-01-resume.cjs").helpers

const ORG_NAME = "OPS-01 operations"
const PROBE = "ops_01_probe"
const BUDGET_HEADERS = ["community", "lot_number", "cost_code", "budget_cents"]
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixtureOf = (kit) => cutover.cutoverOrg(kit, ORG_NAME)
const asOperator = (kit, ops, work) => { cutover.actAsSignedInUser(); return kit.as(ops, work) }

function probeOrgs(kit) {
  return ["A (large backlog)", "B", "C"].map((label) => ({ label, org: kit.organization({ name: `OPS-01 tenant ${label}`, chart: [] }) }))
}

async function skewedBacklogIsClaimedFairly(kit, spec, check) {
  const { inputs, expected } = spec
  const tenants = probeOrgs(kit)
  // The large tenant's jobs are all older, so oldest-first would serve every one of them before the others' first.
  for (const [index, tenant] of tenants.entries()) {
    kit.sql(`insert into public.outbox(org_id, job_type, payload, status, run_at, created_at)
      select ${kit.q(tenant.org.orgId)}, '${PROBE}', jsonb_build_object('n', g), 'pending', now() - interval '1 minute', now() - interval '1 hour' + (${index} * interval '10 minutes') + g * interval '1 second'
      from generate_series(1, ${inputs.backlog[index]}) g`)
  }
  const orgIds = tenants.map((tenant) => tenant.org.orgId)
  const scope = `org_id in (${orgIds.map(kit.q).join(",")}) and job_type='${PROBE}'`
  const oldestFirst = kit.rows(`select org_id from public.outbox where ${scope} and status='pending' order by created_at, id limit ${inputs.claimSize}`)
  const { createServiceSupabaseClient } = require("../../../lib/supabase/server")
  const claims = []
  for (let i = 0; i < inputs.claims; i += 1) {
    const { data, error } = await createServiceSupabaseClient().rpc("claim_jobs", { job_types: [PROBE], limit_value: inputs.claimSize })
    if (error) throw Error(`claim_jobs: ${error.message}`)
    const mine = (data ?? []).filter((job) => orgIds.includes(job.org_id))
    claims.push(orgIds.map((orgId) => mine.filter((job) => job.org_id === orgId).length))
  }
  // A single-job claim after the large tenant was served last starts with the next organization.
  kit.sql(`insert into public.outbox(org_id, job_type, payload, status, run_at) select unnest(array[${orgIds.map((id) => `${kit.q(id)}::uuid`).join(",")}]), '${PROBE}', '{}', 'pending', now() - interval '1 minute'`)
  const singles = []
  for (let i = 0; i < 3; i += 1) {
    const { data, error } = await createServiceSupabaseClient().rpc("claim_jobs", { job_types: [PROBE], limit_value: 1 })
    if (error) throw Error(`claim_jobs: ${error.message}`)
    singles.push(data?.[0]?.org_id ?? null)
  }
  const left = count(kit, `select 1 from public.outbox where ${scope} and status='pending'`)
  kit.sql(`update public.outbox set status='completed' where ${scope} and status in ('pending','processing')`)
  check.equal("a claim takes turns across organizations, so the small tenants drain in the first two claims instead of after the large backlog, and the rotation carries over between claims", expected, {
    oldestFirstWouldServeSmallTenants: oldestFirst.filter((row) => row.org_id !== orgIds[0]).length,
    claims,
    smallTenantsDrainedByClaim: claims.findIndex((_, i) => claims.slice(0, i + 1).reduce((sum, c) => sum + c[1] + c[2], 0) === inputs.backlog[1] + inputs.backlog[2]) + 1,
    singleClaimsServeEachTenantOnce: new Set(singles).size === 3 && singles.every((id) => orgIds.includes(id)),
    leftPending: left,
  })
  return { orgIds }
}

async function cancelledCutoverStopsBetweenHomes(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await fixtureOf(kit)
  const { org, ops } = fixture
  const [batch] = await cutover.stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  const hold = await cutover.holdLot(kit, org, inputs.holdLot)
  const worker = spawn(process.execPath, [path.join(__dirname, "..", "cutover-worker.cjs"), "--container", kit.container, "--api-url", kit.apiUrl, "--batch", batch.id, "--actor", JSON.stringify(ops)], { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  worker.stderr.on("data", (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => worker.once("exit", resolve))
  const started = Date.now()
  while (!cutover.commitWaitsOnALot(kit) && worker.exitCode === null && Date.now() - started < 240000) await sleep(250)
  if (!cutover.commitWaitsOnALot(kit)) { await hold.release(); worker.kill("SIGKILL"); throw Error(`The cutover never reached lot ${inputs.holdLot}: ${stderr.slice(-600)}`) }
  // What the operator's page shows while the cutover runs.
  const running = await asOperator(kit, ops, () => app("imports").getImportBatch(batch.id, { limit: 50 }, { platformOrgId: org.orgId }))
  // The request is recorded against the live claim; the worker honours it at its next home.
  const cancelling = asOperator(kit, ops, () => app("imports").cancelImportBatch(batch.id, { platformOrgId: org.orgId }))
  await sleep(500)
  await hold.release()
  const requested = await cancelling
  await Promise.race([exited, sleep(120000)])
  const after = cutover.batchState(kit, batch.id)
  const built = cutover.receipts(kit, batch.id)
  const homes = cutover.records(kit, batch.id).homes
  const cancelled = after.report.cancelled ?? {}
  const midRun = {
    status: after.status,
    claimed: after.claimed,
    cancelRequestCleared: count(kit, `select 1 from public.import_batches where id=${kit.q(batch.id)} and cancel_requested_at is null`) === 1,
    stoppedBetweenHomes: built >= inputs.lots.indexOf(inputs.holdLot) && built < inputs.lots.length,
    homesMatchReceipts: homes === built,
    reportCountsBuilt: cancelled.homes_built === built && cancelled.rows === inputs.lots.length,
    cancelledBy: cancelled.by === ops.userId,
    workerExitedCleanly: worker.exitCode === 0,
    resumeJobs: kit.rows(`select status from public.outbox where job_type='import_open_wip_commit' and payload->>'batch_id'=${kit.q(batch.id)} order by id`).map((row) => row.status),
    event: count(kit, `select 1 from public.events where entity_id=${kit.q(batch.id)} and event_type='import_batch_cancelled'`),
    audit: count(kit, `select 1 from public.audit_log where entity_id=${kit.q(batch.id)} and after_data->>'status'='failed' and after_data ? 'cancelled'`),
  }
  const notRunning = await asOperator(kit, ops, () => refusal(() => app("imports").cancelImportBatch(batch.id, { platformOrgId: org.orgId })))
  const retried = await asOperator(kit, ops, () => app("imports").commitImportBatch(batch.id, { platformOrgId: org.orgId }))
  const finished = cutover.batchState(kit, batch.id)
  check.equal("a running cutover shows its receipts, stops at the next home when cancelled keeping every home it built, and Commit again finishes it from them", expected, {
    progress: { built: running.progress?.built, total: running.progress?.total, cancelRequested: running.progress?.cancelRequested },
    request: requested.state,
    cancelled: midRun,
    cancelAgain: /Only a running cutover/.test(notRunning) ? "refused" : notRunning,
    commitAgain: { status: retried.status, committedCount: retried.committed_count, attempts: finished.attempts, reconciliation: cutover.reconciliation(finished) },
    homes: cutover.homesOn(kit, org, inputs.lots, [batch.id]),
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function bulkMutationsAreRateLimited(kit, spec, check) {
  const { inputs, expected } = spec
  const { org, ops } = await fixtureOf(kit)
  const key = `identifier='org:${org.orgId}' and action='mutation:import_stage'`
  const windowStart = "to_timestamp(floor(extract(epoch from now()) / 3600) * 3600)"
  const stage = (n) => asOperator(kit, ops, () => app("imports").stageImportBatch({ importer: "open_wip", sourceFilename: `budgets-limit-${n}.csv`, context: { file_kind: "budgets", as_of_date: inputs.asOf },
    csvText: seed.csv(BUDGET_HEADERS, [{ community: "Cypress Landing", lot_number: "40", cost_code: "31-000", budget_cents: "1000" }]) }, { platformOrgId: org.orgId }))
  const batches = () => count(kit, `select 1 from public.import_batches where org_id=${kit.q(org.orgId)}`)
  // A full budget in the previous hour does not carry over.
  kit.sql(`insert into public.auth_rate_limits(action, identifier, window_start, attempts) values ('mutation:import_stage', 'org:${org.orgId}', ${windowStart} - interval '1 hour', ${inputs.limit * 3})
    on conflict (action, identifier, window_start) do update set attempts = excluded.attempts`)
  const before = batches()
  const earlierWindow = await refusal(() => stage(1))
  const afterAllowed = batches()
  // This hour's budget is spent.
  kit.sql(`update public.auth_rate_limits set attempts=${inputs.limit} where ${key} and window_start=${windowStart}`)
  const overBudget = await refusal(() => stage(2))
  const afterRefused = batches()
  // The window rolls over.
  kit.sql(`delete from public.auth_rate_limits where ${key}`)
  check.equal("an organization over its hourly budget of import files is refused before any write, with how long to wait, while an earlier hour's count does not refuse", expected, {
    earlierWindow,
    stagedInEarlierWindow: afterAllowed - before,
    overBudget: overBudget.replace(/Try again in \d+ minutes?\./, "Try again in N minutes."),
    stagedOverBudget: afterRefused - afterAllowed,
  })
  return { orgId: org.orgId }
}

async function deadRunIsTimedOutNotNeverStarted(kit, spec, check) {
  const { inputs, expected } = spec
  const { org, ops } = await fixtureOf(kit)
  // The run row's start is the app's clock, so the new row is found by id, not by time.
  // Its previous run succeeded a minute ago, so what the page reports is this run alone, not an earlier run's outcome.
  kit.sql(`insert into public.job_runs(job_name, started_at, finished_at, status, duration_ms) values (${kit.q(inputs.diedJob)}, now() - interval '1 minute', now() - interval '1 minute' + interval '1 second', 'success', 1000)`)
  const earlier = kit.rows(`select id from public.job_runs where job_name=${kit.q(inputs.diedJob)}`).map((row) => row.id)
  const worker = spawn(process.execPath, [path.join(__dirname, "..", "ops-01-cron-worker.cjs"), "--container", kit.container, "--api-url", kit.apiUrl, "--job", inputs.diedJob], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  worker.stdout.on("data", (chunk) => { output += chunk })
  worker.stderr.on("data", (chunk) => { output += chunk })
  const runRow = () => kit.rows(`select id, status, deadline_at > started_at deadline_after_start, correlation_id like 'cron:${inputs.diedJob}:%' correlated from public.job_runs where job_name=${kit.q(inputs.diedJob)} ${earlier.length ? `and id not in (${earlier.map(kit.q).join(",")})` : ""} order by started_at desc limit 1`)[0]
  const started = Date.now()
  while (!runRow() && Date.now() - started < 60000) await sleep(200)
  const opened = runRow()
  if (!opened) { worker.kill("SIGKILL"); throw Error(`${inputs.diedJob} never opened its run: ${output.slice(-600)}`) }
  worker.kill("SIGKILL")
  await new Promise((resolve) => (worker.exitCode !== null || worker.signalCode ? resolve() : worker.once("exit", resolve)))
  const health = async () => Object.fromEntries((await asOperator(kit, ops, () => app("ops").getCronHealth())).map((job) => [job.name, job]))
  const killed = (await health())[inputs.diedJob]
  // Its deadline passes (the function's maximum duration and a grace period, without the wait).
  kit.sql(`update public.job_runs set deadline_at = now() - interval '1 second' where id=${kit.q(opened.id)}`)
  const pastDeadline = (await health())[inputs.diedJob]
  const reconciled = await kit.service(() => app("job-runs").reconcileOverdueJobRuns(inputs.diedJob))
  const row = kit.rows(`select status, error from public.job_runs where id=${kit.q(opened.id)}`)[0]
  // The other job's last run was started four days ago and nothing since.
  kit.sql(`insert into public.job_runs(job_name, started_at, finished_at, status, duration_ms) values (${kit.q(inputs.silentJob)}, now() - interval '4 days', now() - interval '4 days' + interval '2 seconds', 'success', 2000)`)
  // A job whose deadline is longer than its cadence: a run in flight inside its deadline, the run before it died, and
  // no success for two hours. The run in flight must not hide that its work is not being done.
  const inFlightRows = [
    kit.sql(`insert into public.job_runs(job_name, started_at, deadline_at, status) values (${kit.q(inputs.inFlightJob)}, now() - interval '1 minute', now() + interval '6 minutes', 'running') returning id`).trim(),
    kit.sql(`insert into public.job_runs(job_name, started_at, deadline_at, status, error) values (${kit.q(inputs.inFlightJob)}, now() - interval '8 minutes', now() - interval '1 minute', 'timed_out', 'past its deadline') returning id`).trim(),
    kit.sql(`insert into public.job_runs(job_name, started_at, finished_at, status, duration_ms) values (${kit.q(inputs.inFlightJob)}, now() - interval '2 hours', now() - interval '2 hours' + interval '2 seconds', 'success', 2000) returning id`).trim(),
  ]
  const after = await health()
  const { assessCronJob, cronAlertKind } = require("../../../lib/ops/cron-health")
  const { CRON_JOBS, loadCronRunFacts } = app("job-runs")
  const kindOf = async (name) => {
    const definition = CRON_JOBS.find((entry) => entry.name === name)
    const windowMs = definition.expectedIntervalMinutes * 3 * 60_000
    const facts = await kit.service(() => loadCronRunFacts(name, windowMs, Date.now()))
    return cronAlertKind(assessCronJob(facts, windowMs, Date.now()))
  }
  const alerts = { died: await kindOf(inputs.diedJob), silent: await kindOf(inputs.silentJob), staleWithRunInFlight: await kindOf(inputs.inFlightJob) }
  kit.sql(`delete from public.job_runs where id in (${inFlightRows.map(kit.q).join(",")})`)
  check.equal("a run whose process died is running until its deadline, then timed out, reconciled and counted, and reported apart from a job the scheduler stopped starting", expected, {
    opened: { status: opened.status, deadlineAfterStart: opened.deadline_after_start, correlated: opened.correlated },
    afterKill: killed.state,
    pastDeadline: pastDeadline.state,
    reconciled: reconciled >= 1,
    row: { status: row.status, error: /deadline/.test(row.error ?? "") ? "past its deadline" : row.error },
    reported: { died: { state: after[inputs.diedJob].state, failuresLast24h: after[inputs.diedJob].failuresLast24h >= 1, lastError: /deadline/.test(after[inputs.diedJob].lastError ?? "") }, silent: after[inputs.silentJob].state, staleWithRunInFlight: after[inputs.inFlightJob].state },
    alerts,
  })
  return { jobRunId: opened.id }
}

async function failedUnitsShowWithARecoveryThatWorks(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await fixtureOf(kit)
  const { org, ops } = fixture
  // A cutover interrupted as often as the reaper allows is failed, keeping its homes.
  const [batch] = await cutover.stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  await cutover.killMidFile(kit, fixture, batch.id, inputs.holdLot)
  kit.sql(`update public.import_batches set commit_attempts=5 where id=${kit.q(batch.id)}`)
  cutover.lapseClaim(kit, batch.id)
  await cutover.reap(kit)
  // A notification whose delivery exhausted its retries while the email provider was down.
  const notificationId = kit.sql(`insert into public.notifications(org_id, user_id, notification_type, payload) values (${kit.q(org.orgId)}, ${kit.q(org.owner.userId)}, 'ops_01_probe', '{"title":"OPS-01"}') returning id`)
  const jobId = Number(kit.sql(`insert into public.outbox(org_id, job_type, payload, status, retry_count, last_error, run_at)
    values (${kit.q(org.orgId)}, 'deliver_notification', jsonb_build_object('notificationId', ${kit.q(notificationId)}), 'failed', 3, 'Email provider unavailable (503)', now()) returning id`))
  const view = () => asOperator(kit, ops, () => app("pipeline-failures").listPipelineFailures())
  const find = (groups, pipeline, key) => groups.find((group) => group.pipeline === pipeline)?.units.find((unit) => unit.key === key) ?? null
  const before = await view()
  const importUnit = find(before, "imports", `batch:${batch.id}`)
  const notificationUnit = find(before, "notifications", `job:${jobId}`)
  // The documented recoveries, through the operator's own service calls.
  const recommitted = await asOperator(kit, ops, () => app("pipeline-failures").recommitFailedCutover({ orgId: org.orgId, batchId: batch.id }))
  const requeued = await asOperator(kit, ops, () => app("pipeline-failures").requeueFailedPipelineJob(jobId))
  const queued = kit.rows(`select status, retry_count, last_error from public.outbox where id=${jobId}`)[0]
  const { NextRequest } = require("next/server")
  const { POST } = require("../../../app/api/jobs/process-outbox/route")
  for (let i = 0; i < 30 && kit.rows(`select status from public.outbox where id=${jobId}`)[0].status !== "completed"; i += 1) {
    await POST(new NextRequest("http://127.0.0.1/api/jobs/process-outbox", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
    await kit.settle()
  }
  const delivered = kit.rows(`select status from public.outbox where id=${jobId}`)[0].status
  const again = await asOperator(kit, ops, () => refusal(() => app("pipeline-failures").requeueFailedPipelineJob(jobId)))
  const after = await view()
  const unit = (found) => found ? { recovery: found.recovery?.kind ?? null, hasCure: found.cure.length > 40, hasError: Boolean(found.error), org: found.orgName === ORG_NAME } : null
  check.equal("a failed cutover and an undelivered notification are listed with their safe recovery, and that recovery finishes each one", expected, {
    listed: { cutover: unit(importUnit), notification: unit(notificationUnit) },
    cutoverRecovery: { status: recommitted.status, homes: cutover.records(kit, batch.id).homes, reconciled: cutover.reconciliation(cutover.batchState(kit, batch.id))?.clean ?? false },
    notificationRecovery: { requeued: requeued.jobType, queued: { status: queued.status, retryCount: queued.retry_count, lastError: queued.last_error }, delivered,
      audit: count(kit, `select 1 from public.audit_log where entity_type='outbox' and after_data->>'job_id'=${kit.q(String(jobId))} and source='platform_ops'`) },
    requeueAgain: /not a failed/.test(again) ? "refused" : again,
    listedAfter: { cutover: find(after, "imports", `batch:${batch.id}`) !== null, notification: find(after, "notifications", `job:${jobId}`) !== null },
  })
  return { orgId: org.orgId, batchId: batch.id, jobId }
}

async function membersCannotForgeJobState(kit, spec, check) {
  const { expected } = spec
  const { org } = await fixtureOf(kit)
  const owner = org.owner
  // A job of a type a member's session queues (search upkeep), and one only the server queues.
  const job = Number(kit.sql(`insert into public.outbox(org_id, job_type, payload, status, run_at) values (${kit.q(org.orgId)}, 'reindex_search', '{"ops01":"own"}', 'pending', now() + interval '1 day') returning id`))
  const serverJob = Number(kit.sql(`insert into public.outbox(org_id, job_type, payload, status, run_at) values (${kit.q(org.orgId)}, '${PROBE}', '{"ops01":"server"}', 'pending', now() + interval '1 day') returning id`))
  // A job that exhausted its retries: putting it back is the operator's recovery, never the member's.
  const failed = Number(kit.sql(`insert into public.outbox(org_id, job_type, payload, status, retry_count, last_error, run_at) values (${kit.q(org.orgId)}, '${PROBE}', '{}', 'failed', 3, 'probe failure', now()) returning id`))
  const batch = kit.rows(`select id from public.import_batches where org_id=${kit.q(org.orgId)} and importer='open_wip' and status='committed' limit 1`)[0]?.id ?? null
  const write = (fn) => cutover.memberWrite(kit, owner, fn)
  const forged = {
    completeAJob: await write((db) => db.from("outbox").update({ status: "completed" }).eq("id", job)),
    spendItsRetries: await write((db) => db.from("outbox").update({ retry_count: 3 }).eq("id", job)),
    requeueAFailedJob: await write((db) => db.from("outbox").update({ status: "pending", retry_count: 0, last_error: null }).eq("id", failed)),
    deleteAJob: await write((db) => db.from("outbox").delete().eq("id", job)),
    insertCompleted: await write((db) => db.from("outbox").insert({ org_id: org.orgId, job_type: PROBE, payload: {}, status: "completed" })),
    insertClaimed: await write((db) => db.from("outbox").insert({ org_id: org.orgId, job_type: PROBE, payload: {}, status: "processing" })),
    claimJobs: await write((db) => db.rpc("claim_jobs", { job_types: [PROBE], limit_value: 5 })),
    readEveryTenantsBacklog: await write((db) => db.rpc("outbox_backlog_by_org", { p_limit: 5 })),
    rotateTheClaim: await write((db) => db.from("outbox_claim_rotation").update({ last_org_id: org.orgId }).eq("queue_key", "starts")),
    writeAJobRun: await write((db) => db.from("job_runs").insert({ job_name: "process-outbox", status: "success", started_at: new Date().toISOString() })),
    closeAJobRun: await write((db) => db.from("job_runs").update({ status: "success" }).eq("status", "timed_out")),
    requestACancel: batch ? await write((db) => db.from("import_batches").update({ cancel_requested_at: new Date().toISOString() }).eq("id", batch)) : "no committed batch",
    cancelThroughTheRpc: await write((db) => db.rpc("request_open_wip_cancel", { p_org_id: org.orgId, p_batch_id: batch, p_actor_id: owner.userId })),
    readPipelineFindings: await write((db) => db.rpc("operations_pipeline_findings")),
    queueAPaymentRelease: await write((db) => db.from("outbox").insert({ org_id: org.orgId, job_type: "release_payment_run", payload: { paymentRunId: org.orgId } })),
    queueAServerOnlyJob: await write((db) => db.from("outbox").insert({ org_id: org.orgId, job_type: PROBE, payload: {} })),
    editAServerQueuedJob: await write((db) => db.from("outbox").update({ payload: { forged: true } }).eq("id", serverJob)),
  }
  const serverJobPayload = kit.rows(`select payload from public.outbox where id=${serverJob}`)[0].payload
  // Its own pending work is the organization's to queue and reorder: claims rotate across organizations, so this moves no one else's.
  // Its bookkeeping is the server's: a forged correlation id, an old creation time and a run time ahead of the queue are replaced.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const enqueue = await write((db) => db.from("outbox").insert({ org_id: org.orgId, job_type: "reindex_search", payload: { ops01: "plain" }, correlation_id: "forged", created_at: hourAgo, run_at: hourAgo }))
  const queued = kit.rows(`select correlation_id, created_at > now() - interval '5 minutes' created_now, run_at >= created_at not_ahead from public.outbox where org_id=${kit.q(org.orgId)} and payload->>'ops01' = 'plain'`)[0]
  const reorder = await write((db) => db.from("outbox").update({ priority: 5 }).eq("id", job))
  const backdate = await write((db) => db.from("outbox").update({ run_at: hourAgo }).eq("id", job))
  const untouched = kit.rows(`select status, retry_count, priority, run_at > now() - interval '5 minutes' not_backdated from public.outbox where id=${job}`)[0]
  const stillFailed = kit.rows(`select status from public.outbox where id=${failed}`)[0].status
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(org.orgId)} and (job_type='${PROBE}' or payload ? 'ops01') and status in ('pending','failed')`)
  check.equal("an owner cannot complete, spend, requeue, delete, claim or rotate jobs, queue a job type only the server queues, edit a server-queued job, write job runs, cancel a cutover or read cross-tenant backlog through the data API, and still queues and reorders its own search jobs with the server's bookkeeping", expected, {
    forged,
    serverQueuedJobUnchanged: serverJobPayload.forged === undefined,
    plainEnqueue: enqueue,
    queuedBookkeeping: { correlationForged: queued.correlation_id === "forged", createdNow: queued.created_now, runAtNotAheadOfQueue: queued.not_ahead },
    reorderOwnPendingJob: reorder,
    backdateOwnPendingJob: backdate,
    job: { status: untouched.status, retryCount: untouched.retry_count, priority: untouched.priority, notBackdated: untouched.not_backdated },
    failedJob: stillFailed,
  })
  return { orgId: org.orgId }
}

module.exports = {
  id: "OPS-01",
  subcases: {
    "skewed-backlog-is-claimed-fairly": skewedBacklogIsClaimedFairly,
    "cancelled-cutover-stops-between-homes": cancelledCutoverStopsBetweenHomes,
    "dead-run-is-timed-out-not-never-started": deadRunIsTimedOutNotNeverStarted,
    "failed-units-show-with-a-recovery-that-works": failedUnitsShowWithARecoveryThatWorks,
    "members-cannot-forge-job-state": membersCannotForgeJobState,
    // Last: it spends this organization's hourly import budget and then rolls the window over.
    "bulk-mutations-are-rate-limited": bulkMutationsAreRateLimited,
  },
}
