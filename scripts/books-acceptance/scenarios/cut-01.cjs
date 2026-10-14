// CUT-01 — the Starts cutover (EP07-18), rehearsed end to end on the isolated stack: the rest of the
// forward set is already applied here, so each subcase recreates the state production will be in at
// one moment of the window and proves what the runbook (docs/reference/starts-cutover.md) promises.
//
//   new-code-on-old-schema-is-inert                    the worker leaves everything alone until the schema marker exists
//   legacy-tokenless-claims-drain-after-activation     claims the previous worker held are requeued, claimed under a token and finished once
//   legacy-release-lease-is-honoured                   a package lease held by the previous worker defers the release, then is taken over
//   members-cannot-forge-copy-state-or-drawing-jobs    the manifest, the drawing child jobs and every claim column are server-owned
//   activation-smoke                                   the LOT-01 claim subcase and a real release pass after activation (forgery is the subcase above)
//   rollback-restores-the-old-path-and-reactivation-is-clean   scripts/starts-cutover/rollback.sql and reactivate.sql
//   race-legacy-and-token-claim-same-job               a tokenless and a tokened claim released together: exactly one wins
//   race-two-pipeline-runs-process-each-job-once       two overlapping cron runs release each home once
//
// Homes are given out once at build, one lot each (lots 1-10 are the developed tranche): 1-3 to the
// drain, 4-5 to the lease, 6 to the smoke, 7-8 to the rollback, 9-10 to the overlapping runs; the
// forgery subcase needs only a bare project.
//
// The stack has no previous worker, so "what the previous worker left behind" is written the way its
// claim wrote it (`status = processing`, no claim token, `updated_at` set) for this org's rows only; the
// real `claim_jobs` is used for the one case that must be the real function. The drawings step of a
// release is settled directly (the storage legs are LOT-01's storage subcases), and says so where it happens.
const fs = require("node:fs")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")
const { recorder, loadExpected } = require("../scenario-kit.cjs")

const context = () => require("../../../lib/services/context")
const serviceClient = () => require("../../../lib/supabase/server").createServiceSupabaseClient()
const requirements = () => require("../../../lib/release/schema-requirements")
const pipeline = () => app("starts-pipeline")

const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, from) => Number(one(kit, `select count(*)::int n from ${from}`).n)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Objects compare by content, not by the order their keys were written.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const labelled = (outcome, pattern, label = "refused") => outcome === "allowed" ? "allowed" : pattern.test(outcome) ? label : outcome.slice(0, 300)
const STARTS_TYPES = ["start_release", "trade_schedule_change_notice", "start_release_trade_notice", "start_package_notice"]
const DRAWING_TYPES = ["process_drawing_set", "split_drawing_chunk", "process_drawing_page", "enrich_drawing_metadata", "generate_drawing_tiles", "backfill_drawing_page_text", "extract_drawing_vectors", "detect_drawing_changes"]
const inList = (kit, values) => values.map(kit.q).join(",")

/** The starts pipeline fans out over every run on the stack; a dropped connection is not a verdict. */
async function runPipeline(kit) {
  for (let tries = 1; ; tries += 1) {
    try { return await kit.service(() => pipeline().runStartsPipeline()) } catch (error) {
      if (tries >= 4 || !/fetch failed/.test(error.message)) throw error
    }
  }
}

// ---------------------------------------------------------------------------
// The builder and its homes, built once per run.

const WORLDS = new WeakMap()
const world = (kit) => WORLDS.get(kit) ?? (WORLDS.set(kit, build(kit)), WORLDS.get(kit))
async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "CUT-01 cutover" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  return { org, next: 0 }
}

/** A spec home on its own lot with its start package cleared to ready, as the starts coordinator leaves it. */
async function readyHome(kit) {
  const state = await world(kit), { org } = state
  const index = state.next++
  const lot = org.lots[index]
  if (!lot || index >= 10) throw Error("CUT-01 ran out of developed lots")
  seed.pinSpecPlan(kit, { lot, plan: org.plans[1] })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true })
  return { org, index, lotId: lot.id, packageId: gates.packageId, projectId: gates.projectId, startInDays: 7 * index }
}

const noticeJobs = (kit, home) => kit.rows(`select id::text id from public.outbox where org_id=${kit.q(home.org.orgId)} and job_type='start_package_notice' and payload->>'start_package_id'=${kit.q(home.packageId)} order by id`).map((row) => row.id)
const notifications = (kit, home) => count(kit, `public.notifications where org_id=${kit.q(home.org.orgId)} and payload->>'entity_id'=${kit.q(home.packageId)} and notification_type in ('start_gate_waived','start_package_ready')`)
const job = (kit, id) => one(kit, `select status, retry_count, start_claim_token is not null tokened, start_job_lease_expires_at is not null leased, run_at > now() backed_off from public.outbox where id=${id}`)
const orders = (kit, home) => count(kit, `public.commitments where project_id=${kit.q(home.projectId)} and commitment_type='purchase_order' and status<>'void'`)
const releasedEvents = (kit, home) => count(kit, `public.events where org_id=${kit.q(home.org.orgId)} and entity_id=${kit.q(home.packageId)} and event_type='start.released'`)
const packageStatus = (kit, home) => one(kit, `select status from public.start_packages where id=${kit.q(home.packageId)}`).status

/** A previous-worker claim: this org's pending jobs, held without a token and last touched `minutes` ago. */
const legacyClaim = (kit, ids, minutes) => backdate(kit, `update public.outbox set status='processing', start_claim_token=null, start_job_lease_expires_at=null, updated_at=now()-interval '${minutes} minutes' where id in (${ids.join(",")}) and status='pending'`)
/** `outbox_set_updated_at` stamps every update with now(); a claim last touched minutes ago needs it off for the one statement. */
const backdate = (kit, statement) => kit.sql(`begin;\nalter table public.outbox disable trigger outbox_set_updated_at;\n${statement};\nalter table public.outbox enable trigger outbox_set_updated_at;\ncommit;`)

/** The coordinator queues the release; the drawings step is settled directly because storage has its own subcases. */
async function queueRelease(kit, home) {
  // An owned lot's basis moves into construction at release, which needs the home's inventory policy adopted first.
  await kit.as(home.org.owner, () => app("books/inventory").enableProjectInventory({ projectId: home.projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/ownership` }))
  const queued = await kit.as(home.org.team.starts, () => app("starts").releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(home.startInDays) }))
  if (!queued.released) throw Error(`The release was not queued: ${JSON.stringify(queued)}`)
  kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), detail='{"harness":"drawings copy is proven by the LOT-01 storage subcases"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)
  return one(kit, `select id::text id from public.outbox where org_id=${kit.q(home.org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} and status='pending' order by id desc limit 1`).id
}

async function pipelineUntilSettled(kit, homes, passes = 6) {
  for (let pass = 0; pass < passes; pass += 1) {
    await runPipeline(kit)
    if (homes.every((home) => ["released", "attention"].includes(packageStatus(kit, home)))) break
  }
}

/** A write as the member's own session, the way a browser sends it: the message, or "allowed". */
const rest = (kit, actor, write) => attempt(() => kit.as(actor, async () => {
  const { supabase } = await context().requireOrgContext()
  const { error } = await write(supabase)
  if (error) throw new Error(error.message)
}))

const script = (name) => fs.readFileSync(path.join(__dirname, "../../starts-cutover", name), "utf8")
const runScript = (kit, name) => kit.sql(`\\set cutover_confirm 1\n${script(name)}`)
const verify = (kit) => Object.fromEntries(kit.sql(script("verify.sql")).split("\n").filter(Boolean).map((line) => {
  const [name, ok, n] = line.split("|")
  return [name, { ok: ok === "t", n: n === "" ? null : Number(n) }]
}))

// ---------------------------------------------------------------------------
// 1. New code on the old schema.

async function newCodeOnOldSchemaIsInert(kit, spec, check) {
  const { org } = await world(kit)
  const probe = () => kit.service(() => requirements().findMissingSchemaRequirement(serviceClient(), "starts-pipeline"))
  const until = async (wanted) => {
    for (let tries = 0; tries < 60; tries += 1) {
      if (await probe() === wanted) return
      await sleep(500)
    }
    throw Error(`The API schema cache never ${wanted === null ? "regained" : "lost"} the marker function`)
  }
  const reload = () => kit.sql("notify pgrst, 'reload schema'")
  let observed
  kit.sql("alter function public.starts_cutover_ready() rename to starts_cutover_ready_held")
  try {
    reload()
    await until("starts_cutover_ready")
    const id = kit.sql(`insert into public.outbox(org_id, job_type, payload) values (${kit.q(org.orgId)}, 'start_package_notice', '{}') returning id`).split("\n")[0]
    const inert = await runPipeline(kit)
    const row = job(kit, id)
    kit.sql(`update public.outbox set status='completed' where id=${id}`)
    observed = {
      markerMissing: "starts_cutover_ready",
      inertRun: inert,
      jobUntouched: { status: row.status, retryCount: row.retry_count, tokened: row.tokened },
    }
  } finally {
    kit.sql("alter function public.starts_cutover_ready_held() rename to starts_cutover_ready")
    reload()
  }
  await until(null)
  const resumed = await runPipeline(kit)
  equal(check, "code deployed ahead of the schema claims, drains and sweeps nothing and does not fail; once the marker exists it runs normally", spec.expected, {
    ...observed, afterMarker: { missing: null, notCutOver: Boolean(resumed.notCutOver) },
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 2. Legacy claims drain.

async function legacyTokenlessClaimsDrain(kit, spec, check) {
  const aged = [await readyHome(kit), await readyHome(kit)], fresh = await readyHome(kit)
  const homes = [...aged, fresh]
  const ids = Object.fromEntries(homes.map((home) => [home.packageId, noticeJobs(kit, home)]))
  const quiet = homes.map((home) => notifications(kit, home))
  for (const home of aged) legacyClaim(kit, ids[home.packageId], 4)
  legacyClaim(kit, ids[fresh.packageId], 1)
  const before = { stuckTokenless: homes.flatMap((home) => ids[home.packageId]).filter((id) => { const row = job(kit, id); return row.status === "processing" && !row.tokened }).length }

  await runPipeline(kit)
  const firstRun = {
    agedJobs: aged.flatMap((home) => ids[home.packageId]).map((id) => job(kit, id)),
    freshJobs: ids[fresh.packageId].map((id) => job(kit, id)),
    agedNotified: aged.map((home) => notifications(kit, home) > 0),
    freshNotified: notifications(kit, fresh),
  }
  const afterFirst = aged.map((home) => notifications(kit, home))
  await runPipeline(kit)
  const stable = aged.map((home) => notifications(kit, home)).every((value, index) => value === afterFirst[index])

  // The fresh claim goes quiet too; now it is drained like the rest.
  backdate(kit, `update public.outbox set updated_at=now()-interval '4 minutes' where id in (${ids[fresh.packageId].join(",")}) and status='processing'`)
  await runPipeline(kit)
  const drained = { jobs: ids[fresh.packageId].map((id) => job(kit, id)), notified: notifications(kit, fresh) > 0 }

  // The generic claimer is untouched: it still hands out every other job type without a token.
  const probeId = kit.sql(`insert into public.outbox(org_id, job_type, payload) values (${kit.q(aged[0].org.orgId)}, 'cut_01_probe', '{}') returning id`).split("\n")[0]
  const claimed = kit.sql("set role service_role; select count(*) from public.claim_jobs(array['cut_01_probe'], 1)")
  const probe = job(kit, probeId)
  kit.sql(`update public.outbox set status='completed' where id=${probeId}`)

  const settled = (rows) => rows.every((row) => row.status === "completed" && row.retry_count === 0 && !row.tokened && !row.leased)
  equal(check, "legacy claims quiet for three minutes are requeued, claimed under a token and finished once with one notification set; a fresher one is left alone until it ages; claim_jobs still claims other job types", spec.expected, {
    beforeActivation: { jobsHeld: before.stuckTokenless > 0, notificationsSent: quiet.every((value) => value === 0) ? "none" : "some" },
    firstRun: {
      agedJobsFinishedOnce: settled(firstRun.agedJobs), agedHomesNotified: firstRun.agedNotified.every(Boolean),
      freshClaimLeftAlone: firstRun.freshJobs.every((row) => row.status === "processing" && !row.tokened && row.retry_count === 0), freshHomeNotified: firstRun.freshNotified,
    },
    aSecondRunSendsNothingMore: stable,
    freshClaimOnceAged: { finishedOnce: settled(drained.jobs), notified: drained.notified },
    claimJobsForOtherTypes: { claimed: Number(claimed), status: probe.status, tokened: probe.tokened },
  })
  return { orgId: aged[0].org.orgId }
}

// ---------------------------------------------------------------------------
// 3. A release lease held by the previous worker.

async function legacyReleaseLeaseIsHonoured(kit, spec, check) {
  const fresh = await readyHome(kit), stale = await readyHome(kit)
  const observed = {}
  for (const [name, home, leaseAgeMinutes] of [["fresh", fresh, 1], ["stale", stale, 6]]) {
    const jobId = await queueRelease(kit, home)
    // The previous worker claimed the release, took the package lease and went quiet.
    legacyClaim(kit, [jobId], 4)
    kit.sql(`update public.start_packages set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('release_lease_token', gen_random_uuid()::text, 'release_lease_at', now() - interval '${leaseAgeMinutes} minutes') where id=${kit.q(home.packageId)}`)
    await runPipeline(kit)
    const afterFirst = job(kit, jobId)
    observed[name] = { jobId, afterFirst: { status: afterFirst.status, retryCount: afterFirst.retry_count, package: packageStatus(kit, home), orders: orders(kit, home) } }
    if (name === "fresh") {
      // Its holder goes stale; the deferred release is due again and takes over.
      kit.sql(`update public.start_packages set metadata = metadata || jsonb_build_object('release_lease_at', now() - interval '6 minutes') where id=${kit.q(home.packageId)}`)
      kit.sql(`update public.outbox set run_at=now() where id=${jobId} and status='pending'`)
    }
    await pipelineUntilSettled(kit, [home])
    const final = job(kit, jobId), ordersAfter = orders(kit, home)
    await runPipeline(kit)
    observed[name].final = { status: final.status, retryCount: final.retry_count, package: packageStatus(kit, home), releasedEvents: releasedEvents(kit, home), orders: ordersAfter > 0 ? "generated" : "none", ordersStableOnRerun: orders(kit, home) === ordersAfter }
  }
  equal(check, "a package lease the previous worker held a minute ago defers the release without burning a retry or building anything; a lease six minutes stale is taken over, completed steps are not repeated and the home gets one purchase order set", spec.expected, {
    freshLease: { deferred: observed.fresh.afterFirst, thenTakenOver: observed.fresh.final },
    staleLease: { takenOverAtOnce: observed.stale.afterFirst.status === "completed" || observed.stale.afterFirst.package === "released", final: observed.stale.final },
  })
  return { orgId: fresh.org.orgId }
}

// ---------------------------------------------------------------------------
// 4. Members and the server-owned state.

async function membersCannotForgeCopyState(kit, spec, check) {
  const { org } = await world(kit)
  const home = { projectId: randomUUID() }
  kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values (${kit.q(home.projectId)},${kit.q(org.orgId)},'CUT-01 forgery bench','production',${kit.q(org.owner.userId)})`)
  const sales = org.team.sales
  const pathForged = `${org.orgId}/books-exports/close-archive-2026.json.gz`
  const manifest = { plan_instantiation: { drawing_copy_attempt: { status: "reserved", reserved_at: "2020-01-01T00:00:00Z", attempt_id: "00000000-0000-4000-8000-0000000000f0", storage_path: pathForged } } }
  const tiles = kit.sql(`insert into public.outbox(org_id, job_type, payload) values (${kit.q(org.orgId)}, 'generate_drawing_tiles', '{"sheetVersionId":"x"}') returning id`).split("\n")[0]
  const ordinary = kit.sql(`insert into public.outbox(org_id, job_type, payload) values (${kit.q(org.orgId)}, 'cut_01_probe', '{}') returning id`).split("\n")[0]
  const was = one(kit, `select metadata from public.projects where id=${kit.q(home.projectId)}`).metadata
  const refusal = (outcome, pattern) => labelled(outcome, pattern)
  const manifestOutcome = await rest(kit, sales, (supabase) => supabase.from("projects").update({ metadata: { ...was, ...manifest } }).eq("org_id", org.orgId).eq("id", home.projectId))
  const drawingInsert = await rest(kit, sales, (supabase) => supabase.from("outbox").insert({ org_id: org.orgId, job_type: "generate_drawing_tiles", payload: {} }))
  const drawingRewrite = await rest(kit, sales, (supabase) => supabase.from("outbox").update({ payload: { storagePath: "FORGED" } }).eq("org_id", org.orgId).eq("id", Number(tiles)))
  const drawingComplete = await rest(kit, sales, (supabase) => supabase.from("outbox").update({ status: "completed" }).eq("org_id", org.orgId).eq("id", Number(tiles)))
  const drawingDelete = await rest(kit, sales, (supabase) => supabase.from("outbox").delete().eq("org_id", org.orgId).eq("id", Number(tiles)))
  const leaseOnOrdinary = await rest(kit, sales, (supabase) => supabase.from("outbox").update({ drawing_lease_expires_at: new Date(Date.now() + 3.15e11).toISOString() }).eq("org_id", org.orgId).eq("id", Number(ordinary)))
  const tokenOnOrdinary = await rest(kit, sales, (supabase) => supabase.from("outbox").update({ drawing_claim_token: "00000000-0000-4000-8000-0000000000f1", status: "processing" }).eq("org_id", org.orgId).eq("id", Number(ordinary)))
  const ordinaryWrite = await rest(kit, sales, (supabase) => supabase.from("outbox").update({ priority: 5 }).eq("org_id", org.orgId).eq("id", Number(ordinary)))
  const after = {
    manifest: one(kit, `select metadata->'plan_instantiation'->'drawing_copy_attempt' is null as absent from public.projects where id=${kit.q(home.projectId)}`).absent,
    drawingJob: one(kit, `select status, payload->>'storagePath' is null untouched from public.outbox where id=${tiles}`),
    ordinaryRow: one(kit, `select status, drawing_claim_token is null no_token from public.outbox where id=${ordinary}`),
  }
  kit.sql(`update public.outbox set status='completed' where id in (${tiles}, ${ordinary})`)
  equal(check, "a member's own client cannot write the drawing copy manifest, insert, rewrite, complete or delete a drawing job, or set a claim or lease on any row; ordinary job writes still work", spec.expected, {
    manifest: refusal(manifestOutcome, /server-owned/),
    drawingJobInsert: refusal(drawingInsert, /server writers/), drawingJobRewrite: refusal(drawingRewrite, /server writers/),
    drawingJobComplete: refusal(drawingComplete, /server writers/), drawingJobDelete: refusal(drawingDelete, /server writers/),
    leaseOnAnyRow: refusal(leaseOnOrdinary, /server writers/), claimOnAnyRow: refusal(tokenOnOrdinary, /server writers/),
    ordinaryJobWrite: ordinaryWrite,
    afterwards: { manifestAbsent: after.manifest, drawingJob: { status: after.drawingJob.status, payloadUntouched: after.drawingJob.untouched }, ordinaryRow: { status: after.ordinaryRow.status, unclaimed: after.ordinaryRow.no_token } },
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 5. Activation smoke.

async function activationSmoke(kit, spec, check) {
  const lotExpected = loadExpected("LOT-01").subcases
  const delegated = {}
  const settle = () => kit.sql(`update public.outbox set status='completed' where status in ('pending','processing','failed') and job_type in (${inList(kit, [...STARTS_TYPES, "process_drawing_set"])})`)
  settle()
  for (const name of ["claim-tokens-enforce-the-current-lease"]) {
    const recorded = recorder()
    await require("./lot-01-starts.cjs").subcases[name](kit, lotExpected[name], recorded)
    // A failing proof names its checks, so a red smoke says what broke.
    const failing = recorded.checks.filter((entry) => !entry.pass).map((entry) => entry.label)
    delegated[name] = recorded.checks.length > 0 && !failing.length ? true : failing
    settle()
  }
  const home = await readyHome(kit)
  const released = await seed.releaseHome(kit, home.org, { packageId: home.packageId, projectId: home.projectId, startInDays: home.startInDays })
  equal(check, "after activation the LOT-01 claim proof passes and a home releases through the tokened worker, once", spec.expected, {
    delegated, release: released.released.status, releasedEvents: releasedEvents(kit, home), orders: orders(kit, home) > 0 ? "generated" : "none",
  })
  return { orgId: home.org.orgId }
}

// ---------------------------------------------------------------------------
// 6. Rollback and re-activation.

async function rollbackRestoresOldPathAndReactivationIsClean(kit, spec, check) {
  const home = await readyHome(kit), next = await readyHome(kit), { org } = home
  const coordinator = org.team.starts
  const tables = ["start_packages", "start_release_steps", "start_package_gates"]
  const fingerprint = () => Object.fromEntries(tables.map((table) => [table, one(kit, `select md5(coalesce(string_agg(((to_jsonb(t) - 'updated_at') #- '{metadata,release_lease_token}' #- '{metadata,release_lease_at}')::text, '|' order by t.id::text), '')) h from public.${table} t where org_id=${kit.q(org.orgId)}`).h]))
  const memberWrites = async () => ({
    startPackage: labelled(await rest(kit, coordinator, (supabase) => supabase.from("start_packages").update({ notes: "written by the previous code" }).eq("org_id", org.orgId).eq("id", home.packageId)), /Starts|server|authorized|worker|row-level/),
    drawingJob: labelled(await rest(kit, coordinator, (supabase) => supabase.from("outbox").insert({ org_id: org.orgId, job_type: "process_drawing_set", payload: {} })), /server writers|authorized/),
  })
  // Work in flight: a tokened starts job and a tokened drawing job, as the new worker holds them.
  const startsJob = kit.sql(`insert into public.outbox(org_id, job_type, payload, status, start_claim_token, start_job_lease_expires_at) values (${kit.q(org.orgId)}, 'start_package_notice', '{}', 'processing', gen_random_uuid(), now() + interval '3 minutes') returning id`).split("\n")[0]
  const drawingJob = kit.sql(`insert into public.outbox(org_id, job_type, payload, status, drawing_claim_token, drawing_lease_expires_at) values (${kit.q(org.orgId)}, 'process_drawing_page', '{}', 'processing', gen_random_uuid(), now() + interval '3 minutes') returning id`).split("\n")[0]
  const completeProbes = (...ids) => kit.sql(`update public.outbox set status='completed' where id in (${ids.join(",")})`)

  const before = { verify: verify(kit), writes: await memberWrites(), data: fingerprint() }
  runScript(kit, "rollback.sql")
  const rolledBack = { verify: verify(kit), data: fingerprint(), startsJob: job(kit, startsJob), drawingJob: job(kit, drawingJob) }
  const previousPath = await memberWrites()
  completeProbes(startsJob, drawingJob)
  kit.sql(`delete from public.outbox where org_id=${kit.q(org.orgId)} and job_type='process_drawing_set' and payload='{}'::jsonb and status='pending'`)
  kit.sql(`update public.start_packages set notes=null where id=${kit.q(home.packageId)}`)
  runScript(kit, "reactivate.sql")
  const reactivated = { verify: verify(kit), writes: await memberWrites() }
  const released = await seed.releaseHome(kit, org, { packageId: next.packageId, projectId: next.projectId, startInDays: next.startInDays })
  const fences = (snapshot) => snapshot.verify["fences enabled"].n

  equal(check, "rollback turns every starts and drawing fence off, requeues tokened work as tokenless and loses no row; the previous path writes again; re-activation restores the same fences, refuses those writes and a release finishes", spec.expected, {
    beforeRollback: { fences: before.verify["fences enabled"].ok ? "enabled" : "missing", memberWrites: before.writes },
    afterRollback: {
      fencesEnabled: fences(rolledBack), fencesDisabled: rolledBack.verify["fences disabled (nonzero only after a rollback)"].n > 0,
      inFlightStartsJob: { status: rolledBack.startsJob.status, tokened: rolledBack.startsJob.tokened, leased: rolledBack.startsJob.leased },
      inFlightDrawingJob: { status: rolledBack.drawingJob.status, tokened: rolledBack.drawingJob.tokened, leased: rolledBack.drawingJob.leased },
      startsDataUntouched: JSON.stringify(rolledBack.data) === JSON.stringify(before.data),
      previousPathWrites: previousPath,
    },
    afterReactivation: { sameFences: fences(reactivated) === fences(before), memberWrites: reactivated.writes, release: released.released.status },
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 7. Races.

async function raceLegacyAndTokenClaim(kit, spec, check) {
  const { org } = await world(kit)
  const rounds = []
  for (let round = 1; round <= 3; round += 1) {
    // The shared queue is settled so these two sessions contend for one job and not someone else's.
    kit.sql(`update public.outbox set status='completed' where status in ('pending','processing','failed') and job_type in (${inList(kit, STARTS_TYPES)})`)
    const id = kit.sql(`insert into public.outbox(org_id, job_type, payload) values (${kit.q(org.orgId)}, 'start_package_notice', '{}') returning id`).split("\n")[0]
    const outcomes = await race(kit, [
      "set role service_role; select count(*) from public.claim_jobs(array['start_package_notice'], 1);",
      "set role service_role; select count(*) from public.claim_starts_jobs(1);",
    ])
    const wins = outcomes.map((outcome) => outcome.ok ? Number(outcome.stdout.split("\n").pop()) : 0)
    const row = job(kit, id)
    kit.sql(`update public.outbox set status='completed' where id=${id}`)
    rounds.push({ winners: wins.reduce((a, b) => a + b, 0), processing: row.status === "processing", claimedOnce: wins.every((value) => value <= 1) })
  }
  equal(check, "a tokenless and a tokened claim released together over one pending job: exactly one session gets it", spec.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceTwoPipelineRuns(kit, spec, check) {
  const homes = [await readyHome(kit), await readyHome(kit)]
  for (const home of homes) await queueRelease(kit, home)
  await Promise.all([runPipeline(kit), runPipeline(kit)])
  await pipelineUntilSettled(kit, homes)
  const settled = homes.map((home) => ({ package: packageStatus(kit, home), releasedEvents: releasedEvents(kit, home), orders: orders(kit, home) }))
  await runPipeline(kit)
  const duplicateNotices = homes.map((home) => Number(one(kit, `select (count(*) - count(distinct payload->>'company_id'))::int n from public.outbox where org_id=${kit.q(home.org.orgId)} and job_type='start_release_trade_notice' and payload->>'start_package_id'=${kit.q(home.packageId)}`).n))
  const stuck = count(kit, `public.outbox where org_id=${kit.q(homes[0].org.orgId)} and job_type='start_release' and status='processing' and payload->>'start_package_id' in (${homes.map((home) => kit.q(home.packageId)).join(",")})`)
  equal(check, "two cron runs overlapping over two queued releases release each home once, with one event, one purchase order set and one notice per company, and leave nothing processing", spec.expected, {
    homes: settled.map((home) => ({ package: home.package, releasedEvents: home.releasedEvents, orders: home.orders > 0 ? "generated" : "none" })),
    ordersStableOnRerun: homes.every((home, index) => orders(kit, home) === settled[index].orders),
    duplicateNotices, stuckReleases: stuck,
  })
  return { orgId: homes[0].org.orgId }
}

module.exports = {
  id: "CUT-01",
  subcases: {
    "new-code-on-old-schema-is-inert": newCodeOnOldSchemaIsInert,
    "legacy-tokenless-claims-drain-after-activation": legacyTokenlessClaimsDrain,
    "legacy-release-lease-is-honoured": legacyReleaseLeaseIsHonoured,
    "members-cannot-forge-copy-state-or-drawing-jobs": membersCannotForgeCopyState,
    "activation-smoke": activationSmoke,
    "rollback-restores-the-old-path-and-reactivation-is-clean": rollbackRestoresOldPathAndReactivationIsClean,
    "race-legacy-and-token-claim-same-job": raceLegacyAndTokenClaim,
    "race-two-pipeline-runs-process-each-job-once": raceTwoPipelineRuns,
  },
}
