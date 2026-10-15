// LOT-01 workflow proof: release. EP07-14 (bounded storage copy), EP07-15 (durable drawing publication),
// EP07-16 (child worker and orphan recovery) and EP07-17 (atomic release finalization), driven as the starts
// coordinator through Arc's services and, where the criterion is about ownership between database sessions,
// through the service-role RPCs exactly as lib/services/plan-drawing-copy.ts, plan-instantiation.ts and
// starts-pipeline.ts call them (including the claim headers a release worker's requests carry).
//
// Harness notes (the stack has no file storage and a global job queue):
// - the plan-set PDF is a `files` row with no object behind it; the storage leg of a copy (HeadObject and
//   conditional CopyObject) therefore cannot run, and the copy evidence (size, source ETag) is supplied;
// - a release job is claimed by the same UPDATE claim_starts_jobs performs, but for ONE job of this org, so the
//   shared queue's other workers are never disturbed; every later transition is the real RPC;
// - steps the harness settles directly are named where they happen.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const confirmation = () => require("../../../lib/starts/confirmation-identity")
const copyService = () => require("../../../lib/services/plan-drawing-copy")
const planInstantiation = () => require("../../../lib/services/plan-instantiation")

const STEPS = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"]
const PDF_BYTES = 4096000
const PDF_NAME = "Mangrove-plan-set.pdf"
const SOURCE_ETAG = '"6a0e2f1c7d9b4a58b3c1e0f9d2a47b10"'
const COPY_ETAG = '"b81f3c52a7e04d6c9f10e2a3c5d7f9b2"'

// ---------------------------------------------------------------------------
// Plumbing.

const FIXTURES = new WeakMap()
const fx = (kit) => FIXTURES.get(kit) ?? (FIXTURES.set(kit, { next: 0, memo: new Map() }), FIXTURES.get(kit))
function once(kit, key, work) {
  const state = fx(kit)
  if (!state.memo.has(key)) state.memo.set(key, work())
  return state.memo.get(key)
}

/** Runs SQL as the service role (what the app's service client is). */
const svc = (kit, body) => kit.sql(`set role service_role;\n${body}`)
function attempt(kit, body) {
  try { return { ok: true, out: svc(kit, body) } } catch (error) { return { ok: false, err: String(error.message) } }
}
const parsed = (out) => {
  const line = String(out).split("\n").reverse().find((text) => text.startsWith("R:"))
  return line === undefined ? undefined : JSON.parse(line.slice(2))
}
const workerHeaders = (job) => job
  ? `\\o /dev/null\nselect set_config('request.headers','${JSON.stringify({ "x-starts-job-id": String(job.id), "x-starts-claim-token": job.token })}',false);\n\\o\n`
  : ""
const script = (job, body) => `set role service_role;\n${workerHeaders(job)}${body}`
const scalar = (kit, sql) => kit.rows(`select (${sql}) as v`)[0].v
const count = (kit, sql) => Number(scalar(kit, `select count(*)::int from ${sql}`))
/** An error message reduced to the clause under test, or the message itself when it is something else. */
const refusedAs = (outcome, pattern, label = "refused") => outcome.ok ? "allowed" : pattern.test(outcome.err) ? label : outcome.err.slice(0, 300)

const rpc = {
  reserve: (kit, home, evidence, actorId = home.actorId) => `select 'R:'||public.reserve_plan_drawing_copy(${kit.q(home.orgId)},${kit.q(home.projectId)},${kit.q(home.planVersionId)},${kit.q(actorId)},${kit.q(JSON.stringify(evidence))}::jsonb)::text;`,
  publish: (kit, home, copy, actorId = home.actorId) => `select 'R:'||public.publish_plan_drawing_copy(${kit.q(home.orgId)},${kit.q(home.projectId)},${kit.q(home.planVersionId)},${kit.q(actorId)},${kit.q(JSON.stringify(copy))}::jsonb)::text;`,
}
const evidence = { size_bytes: PDF_BYTES, source_etag: SOURCE_ETAG }
const copyOf = (attemptRow, overrides = {}) => ({ attempt_id: attemptRow.attempt_id, storage_path: attemptRow.storage_path, size_bytes: attemptRow.size_bytes, source_etag: attemptRow.source_etag, etag: COPY_ETAG, ...overrides })
const manifestOf = (kit, projectId) => kit.rows(`select metadata->'plan_instantiation' as state from public.projects where id=${kit.q(projectId)}`)[0].state ?? {}

/** The plan-set PDF as a file record (no object behind it) and a released plan version that froze it. */
const pdfPlan = (kit) => once(kit, "pdfPlan", async () => {
  const { org } = await lot().stage(kit, "land")
  const fileId = randomUUID()
  kit.sql(`insert into public.files(id,org_id,file_name,storage_path,mime_type,size_bytes,checksum) values(${kit.q(fileId)},${kit.q(org.orgId)},${kit.q(PDF_NAME)},${kit.q(`${org.orgId}/plans/library/${PDF_NAME}`)},'application/pdf',${PDF_BYTES},'sha256-6a0e2f1c')`)
  const plans = app("house-plans")
  const created = await kit.as(org.owner, () => plans.createHousePlan({ code: "PD1800", name: "The Pelican", series: "Cypress Landing", heatedSqft: 1800, totalSqft: 2120, beds: 3, baths: 2, stories: 1, garageBays: 2 }))
  const elevations = []
  for (const [index, [code, label]] of [["A", "Coastal"], ["B", "Craftsman"]].entries())
    elevations.push(await kit.as(org.owner, () => plans.upsertElevation(created.id, { code, name: label, sortOrder: index })))
  const version = created.versions?.[0] ?? (await kit.as(org.owner, () => plans.listPlanVersions(created.id)))[0]
  await kit.as(org.owner, () => plans.replaceTakeoffLines(version.id, seed.TRADES.map((trade) => ({
    costCodeId: org.costCodeIds[trade.costCode], description: `${trade.vendor} scope`, quantity: trade.uom === "sf" ? 1800 : 1, uom: trade.uom,
  }))))
  await kit.as(org.owner, () => plans.updatePlanVersion(version.id, { label: "Launch release", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: [], selectionCategoryIds: [], drawingSourceFileId: fileId }))
  await kit.as(org.owner, () => plans.releasePlanVersion(version.id))
  await kit.as(org.owner, () => app("community-sales").offerPlanInCommunity({ communityId: org.communityId, housePlanId: created.id, basePriceCents: 41500000 }))
  return { id: created.id, versionId: version.id, elevationIds: elevations.map((row) => row.id), fileId }
})

/** A lot with a spec plan pinned and its start package cleared to ready, as the starts coordinator would leave it. */
async function freshHome(kit, { pdf = false } = {}) {
  const { org } = await lot().stage(kit, "land")
  const state = fx(kit)
  const row = org.lots[state.next++]
  if (!row || state.next > 10) throw Error("The release area ran out of developed lots")
  const plan = pdf ? await pdfPlan(kit) : org.plans[1]
  seed.pinSpecPlan(kit, { lot: row, plan })
  const gates = await seed.clearStartGates(kit, org, { lotId: row.id, spec: true })
  await seed.assignSuperintendent(kit, org, { projectId: gates.projectId })
  return { org, orgId: org.orgId, lot: row, lotId: row.id, projectId: gates.projectId, packageId: gates.packageId, planVersionId: plan.versionId, planFileId: plan.fileId ?? null, actorId: org.team.starts.userId }
}

function settleSteps(kit, home, keys = STEPS) {
  kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), error=null, detail='{"harness":"settled directly"}' where start_package_id=${kit.q(home.packageId)} and step_key = any(array[${keys.map(kit.q).join(",")}])`)
  // The finalize step proves the two gates the release itself produces (syncReleaseProducedGates); settling it by hand does the same.
  if (keys.includes("finalize")) kit.sql(`update public.start_package_gates g set status='passed', passed_via='auto' from public.start_gate_definitions d where d.id=g.gate_definition_id and g.start_package_id=${kit.q(home.packageId)} and d.key in ('budget','po_set') and g.status='pending'`)
}

/** The coordinator queues the release; one job of this org is claimed the way claim_starts_jobs claims it. */
async function claimRelease(kit, home, { settle = false, leaseMinutes = 20 } = {}) {
  const queued = await kit.as(home.org.team.starts, () => app("starts").releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" }))
  if (!queued.released) throw Error(`The release was not queued: ${JSON.stringify(queued)}`)
  const out = kit.sql(`update public.outbox set status='processing', updated_at=clock_timestamp(), start_claim_token=gen_random_uuid(), start_job_lease_expires_at=clock_timestamp()+interval '${leaseMinutes} minutes'
    where org_id=${kit.q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} and status='pending' returning id::text||'|'||start_claim_token::text`)
  if (!out) throw Error("Another worker took the queued release before the harness claimed it; rerun")
  const [id, token] = out.split("|")
  const job = { id, token }
  if (parsed(svc(kit, `select 'R:'||public.transition_starts_package_lease(${kit.q(home.orgId)},${id},${kit.q(token)}::uuid,'acquire');`)) !== true) throw Error("The package lease was not acquired")
  if (settle) settleSteps(kit, home)
  return job
}

const bareProject = (kit, orgId, ownerId) => {
  const id = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(id)},${kit.q(orgId)},${kit.q(`Drawing copy bench ${id.slice(0, 8)}`)},'production',${kit.q(ownerId)})`)
  return id
}
/** A project that is not in a release (no claim): the non-release consumer path of the same RPCs. */
async function benchHome(kit) {
  const { org } = await lot().stage(kit, "land")
  const plan = await pdfPlan(kit)
  return { org, orgId: org.orgId, projectId: bareProject(kit, org.orgId, org.owner.userId), planVersionId: plan.versionId, planFileId: plan.fileId, actorId: org.team.starts.userId }
}

const rowsFor = (kit, home, path) => ({
  files: count(kit, `public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and storage_path=${kit.q(path)}`),
  drawingSets: count(kit, `public.drawing_sets where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)}`),
  revisions: count(kit, `public.drawing_revisions where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)}`),
  processorJobs: count(kit, `public.outbox where org_id=${kit.q(home.orgId)} and job_type='process_drawing_set' and payload->>'projectId'=${kit.q(home.projectId)}`),
})
/**
 * The stack's outbox is shared: any other run's drain also processes pending drawing jobs, and without file storage they
 * fail on the missing object and back off. A processor job this area wants to claim itself is therefore kept out of the
 * queue (not due) until the check that owns it asks for it.
 */
const shelveProcessorJobs = (kit, home) => kit.sql(`update public.outbox set run_at=clock_timestamp()+interval '2 hours' where org_id=${kit.q(home.orgId)} and job_type='process_drawing_set' and payload->>'projectId'=${kit.q(home.projectId)} and status='pending'`)
const shelveJob = (kit, jobId) => kit.sql(`update public.outbox set run_at=clock_timestamp()+interval '2 hours' where id=${jobId} and status='pending'`)
const wakeJob = (kit, jobId) => kit.sql(`update public.outbox set run_at=clock_timestamp() where id=${jobId} and status='pending' and run_at>clock_timestamp()`)
/** The starts pipeline fans out over every community of every run on the stack; a dropped connection there is not a verdict. */
async function runPipeline(kit) {
  for (let tries = 1; ; tries += 1) {
    try { return await kit.service(() => app("starts-pipeline").runStartsPipeline()) } catch (error) {
      if (tries >= 4 || !/fetch failed/.test(error.message)) throw error
    }
  }
}

const noRows = { files: 0, drawingSets: 0, revisions: 0, processorJobs: 0 }
const oneOfEach = { files: 1, drawingSets: 1, revisions: 1, processorJobs: 1 }

// ---------------------------------------------------------------------------
// EP07-14: the plan PDF transfer on a stack without file storage.

async function planPdfCopyWithoutStorage(kit, spec, check) {
  const { equal } = lot()
  const home = await benchHome(kit)
  const source = kit.rows(`select id, storage_path, mime_type, size_bytes from public.files where id=${kit.q(home.planFileId)}`)[0]
  const publish = () => kit.service(() => copyService().publishPlanDrawingCopy({ orgId: home.orgId, projectId: home.projectId, planVersionId: home.planVersionId, actorId: home.actorId, source: { ...source, size_bytes: Number(source.size_bytes) } }))
  const settle = async (work) => { try { await work(); return "succeeded" } catch (error) { return /Missing R2 credentials/.test(error.message) ? "refused: no storage" : error.message } }

  // 1. Nothing reserved yet: the transfer cannot even read its source, and leaves no trace.
  const coldOutcome = await settle(publish)
  const cold = { manifest: manifestOf(kit, home.projectId).drawing_copy_attempt ?? null, ...rowsFor(kit, home, "") }

  // 2. A reservation exists (the worker reached the copy): the copy cannot complete and nothing is published.
  const reserved = parsed(svc(kit, script(null, rpc.reserve(kit, home, evidence))))
  const reservedOutcome = await settle(publish)
  const afterCopy = { manifest: manifestOf(kit, home.projectId).drawing_copy_attempt?.status, ...rowsFor(kit, home, reserved.storage_path) }

  // 3. The source changes after the reservation (the file record no longer matches the reserved evidence):
  //    publication refuses, so a stale copy cannot be reported as the plan set.
  kit.sql(`update public.files set size_bytes=${PDF_BYTES + 1024} where id=${kit.q(home.planFileId)}`)
  const staleSource = attempt(kit, script(null, rpc.publish(kit, home, copyOf(reserved))))
  const afterStale = rowsFor(kit, home, reserved.storage_path)
  kit.sql(`update public.files set size_bytes=${PDF_BYTES} where id=${kit.q(home.planFileId)}`)
  const staleReservation = attempt(kit, script(null, rpc.reserve(kit, home, { size_bytes: PDF_BYTES + 1024, source_etag: SOURCE_ETAG })))

  // 4. A copy result that does not match its reservation (a different source version) is refused.
  const otherVersion = attempt(kit, script(null, rpc.publish(kit, home, copyOf(reserved, { source_etag: '"0000deadbeef"' }))))
  const afterOtherVersion = rowsFor(kit, home, reserved.storage_path)

  equal(check, "without file storage the plan PDF transfer reports no success and publishes nothing; stale source evidence is refused", spec.expected, {
    coldTransfer: coldOutcome, coldState: cold,
    reservedTransfer: reservedOutcome, reservedState: afterCopy,
    sourceChangedAfterReservation: refusedAs(staleSource, /differs from source/), rowsAfterChangedSource: afterStale,
    changedSourceCannotBeReserved: refusedAs(staleReservation, /differs from file record/),
    otherSourceVersion: refusedAs(otherVersion, /not reserved with this evidence/), rowsAfterOtherVersion: afterOtherVersion,
  })
  return { orgId: home.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// EP07-15: reservation, atomic publication and the verified receipt.

/** Everything one claimed release does with the drawing copy, run once and reused by the processor checks. */
const lifecycle = (kit) => once(kit, "lifecycle", async () => {
  const home = await freshHome(kit, { pdf: true })
  const job = await claimRelease(kit, home)
  const org = home.org
  const call = (body) => attempt(kit, script(job, body))
  const before = { manifest: manifestOf(kit, home.projectId).drawing_copy_attempt ?? null, ...rowsFor(kit, home, "") }

  const reservedOutcome = call(rpc.reserve(kit, home, evidence))
  const reserved = parsed(reservedOutcome.out)
  const expectedPath = `${home.orgId}/projects/${home.projectId}/plans/${home.planVersionId}/${reserved.attempt_id}/${PDF_NAME}`
  const afterReserve = { ...rowsFor(kit, home, reserved.storage_path), manifestStatus: manifestOf(kit, home.projectId).drawing_copy_attempt.status }
  const again = parsed(call(rpc.reserve(kit, home, evidence)).out)
  const conflicting = call(rpc.reserve(kit, home, { ...evidence, source_etag: '"another-source-version"' }))
  const wrongSize = call(rpc.reserve(kit, home, { ...evidence, size_bytes: PDF_BYTES + 1 }))
  const wrongActor = call(rpc.reserve(kit, home, evidence, org.owner.userId))

  const wrongEtag = call(rpc.publish(kit, home, copyOf(reserved, { source_etag: '"another-source-version"' })))
  const wrongPath = call(rpc.publish(kit, home, copyOf(reserved, { storage_path: `${home.orgId}/projects/${home.projectId}/plans/${home.planVersionId}/${randomUUID()}/${PDF_NAME}` })))
  const noEtag = call(rpc.publish(kit, home, copyOf(reserved, { etag: "" })))
  const publishWrongActor = call(rpc.publish(kit, home, copyOf(reserved), org.owner.userId))
  const afterRefusals = rowsFor(kit, home, reserved.storage_path)

  const published = parsed(call(rpc.publish(kit, home, copyOf(reserved))).out)
  const file = kit.rows(`select source, category, visibility, mime_type, size_bytes, uploaded_by, metadata from public.files where id=${kit.q(published.file_id)}`)[0]
  const set = kit.rows(`select source_file_id, status, processing_stage from public.drawing_sets where id=${kit.q(published.drawing_set_id)}`)[0]
  const revision = kit.rows(`select source_file_id, drawing_set_id, status, processing_stage from public.drawing_revisions where id=${kit.q(published.revision_id)}`)[0]
  const job15 = kit.rows(`select status, payload from public.outbox where id=${published.job_id}`)[0]
  const manifest = manifestOf(kit, home.projectId).drawing_copy_attempt
  const afterPublish = rowsFor(kit, home, reserved.storage_path)

  // A lost response: the worker never saw the receipt. Replaying the same call, and the real TS function, return it again.
  const replay = parsed(call(rpc.publish(kit, home, copyOf(reserved))).out)
  const reserveAfter = parsed(call(rpc.reserve(kit, home, evidence)).out)
  const source = kit.rows(`select id, storage_path, mime_type, size_bytes from public.files where id=${kit.q(home.planFileId)}`)[0]
  const viaService = await kit.service(() => copyService().publishPlanDrawingCopy({ orgId: home.orgId, projectId: home.projectId, planVersionId: home.planVersionId, actorId: home.actorId, source: { ...source, size_bytes: Number(source.size_bytes) } }))
  const afterReplays = rowsFor(kit, home, reserved.storage_path)
  shelveJob(kit, published.job_id)

  // The processor failed for good: replaying the publication must not report the dead job as live.
  kit.sql(`update public.outbox set status='failed' where id=${published.job_id}`)
  const failedReplay = call(rpc.publish(kit, home, copyOf(reserved)))
  kit.sql(`update public.outbox set status='pending' where id=${published.job_id}`)
  return {
    home, job, reserved, published, expectedPath, before, reservedOutcome, again, conflicting, wrongSize, wrongActor, afterReserve, wrongEtag, wrongPath, noEtag, publishWrongActor, afterRefusals,
    file, set, revision, job15, manifest, afterPublish, replay, reserveAfter, viaService, afterReplays, failedReplay,
  }
})

async function drawingCopyReservedThenPublishedAtomically(kit, spec, check) {
  const { equal } = lot()
  const seen = await lifecycle(kit)
  const { home, reserved, published } = seen
  const receipt = (value) => ({ file: value.file_id === published.file_id, set: value.drawing_set_id === published.drawing_set_id, revision: value.revision_id === published.revision_id, job: value.job_id === published.job_id })
  equal(check, "the copy is reserved under a stable, attempt-unique path before anything is published; the file, set, revision and processor job appear together, once; a lost response gets the same verified receipt", spec.expected, {
    beforeReservation: seen.before,
    reservation: { status: reserved.status, path: reserved.storage_path === seen.expectedPath ? "attempt-unique path under the home and plan version" : reserved.storage_path, sizeBytes: reserved.size_bytes, sourceEtag: reserved.source_etag },
    reservedPublishesNothing: seen.afterReserve,
    reservingAgainReturnsTheSameAttempt: seen.again.attempt_id === reserved.attempt_id,
    differentSourceVersionCannotReserve: refusedAs(seen.conflicting, /Existing drawing copy attempt differs/),
    differentSizeCannotReserve: refusedAs(seen.wrongSize, /differs from file record/),
    otherActorCannotReserve: refusedAs(seen.wrongActor, /reservation actor mismatch/),
    publishWithAnotherSourceVersion: refusedAs(seen.wrongEtag, /not reserved with this evidence/),
    publishToAnotherPath: refusedAs(seen.wrongPath, /not reserved with this evidence/),
    publishWithoutCopyEvidence: refusedAs(seen.noEtag, /evidence is incomplete/),
    otherActorCannotPublish: refusedAs(seen.publishWrongActor, /publication actor mismatch/),
    refusedPublicationsLeaveNothing: seen.afterRefusals,
    published: {
      replayed: published.replayed,
      rows: seen.afterPublish,
      file: { source: seen.file.source, category: seen.file.category, visibility: seen.file.visibility, mime: seen.file.mime_type, sizeBytes: Number(seen.file.size_bytes), uploadedByCoordinator: seen.file.uploaded_by === home.actorId, planVersionPinned: seen.file.metadata.source_plan_version_id === home.planVersionId, attemptRecorded: seen.file.metadata.plan_copy_attempt_id === reserved.attempt_id, sourceEtagRecorded: seen.file.metadata.source_storage_etag === SOURCE_ETAG, copyEtagRecorded: seen.file.metadata.storage_etag === COPY_ETAG },
      set: { holdsTheCopy: seen.set.source_file_id === published.file_id, status: seen.set.status },
      revision: { forThisSetAndFile: seen.revision.drawing_set_id === published.drawing_set_id && seen.revision.source_file_id === published.file_id, status: seen.revision.status, stage: seen.revision.processing_stage },
      processorJob: { status: seen.job15.status, names: seen.job15.payload.draftRevisionId === published.revision_id && seen.job15.payload.sourceFileId === published.file_id && seen.job15.payload.drawingSetId === published.drawing_set_id && seen.job15.payload.storagePath === reserved.storage_path },
      manifest: { status: seen.manifest.status, etag: seen.manifest.etag === COPY_ETAG, receiptMatches: receipt(seen.manifest.receipt) },
    },
    lostResponseRetry: { replayedFlag: seen.replay.replayed, sameReceipt: receipt(seen.replay), reserveReturnsPublished: seen.reserveAfter.status, serviceRetrySameSet: seen.viaService.drawing_set_id === published.drawing_set_id, serviceRetryQueued: seen.viaService.queued, rowsAfterRetries: seen.afterReplays },
    deadProcessorBlocksReplay: refusedAs(seen.failedReplay, /Drawing processing failed/),
  })
  return { orgId: home.orgId, projectId: home.projectId, drawingSetId: published.drawing_set_id }
}

async function raceDrawingCopy(kit, spec, check) {
  const { equal } = lot()
  const rounds = []
  for (const variant of ["same-evidence", "conflicting-evidence", "conflicting-evidence"]) {
    const home = await freshHome(kit, { pdf: true })
    const job = await claimRelease(kit, home)
    const evidences = variant === "same-evidence" ? [evidence, evidence] : [evidence, { ...evidence, source_etag: '"a-different-source-version"' }]
    // Two workers reserve the copy together.
    const reserves = await race(kit, evidences.map((item) => script(job, rpc.reserve(kit, home, item))))
    const reservations = reserves.map((outcome) => outcome.ok ? parsed(outcome.stdout) : null)
    const winners = reservations.filter(Boolean)
    const manifest = manifestOf(kit, home.projectId).drawing_copy_attempt
    // Whatever won, publication is raced by two workers with the winning evidence and one with another source version, with a cancel behind them.
    const copy = copyOf(manifest, { etag: COPY_ETAG })
    const publishes = await race(kit, [
      script(job, rpc.publish(kit, home, copy)),
      script(job, rpc.publish(kit, home, copy)),
      script(job, rpc.publish(kit, home, { ...copy, source_etag: '"a-third-source-version"' })),
    ])
    const outcomes = publishes.map((outcome) => outcome.ok ? parsed(outcome.stdout) : null)
    const results = outcomes.filter(Boolean)
    shelveProcessorJobs(kit, home)
    const rows = rowsFor(kit, home, manifest.storage_path)
    const after = manifestOf(kit, home.projectId).drawing_copy_attempt
    rounds.push({
      variant,
      reservations: { succeeded: winners.length, oneAttempt: new Set(winners.map((item) => item.attempt_id)).size === 1, manifestIsThatAttempt: winners.every((item) => item.attempt_id === manifest.attempt_id), refusedConflicting: variant === "same-evidence" ? 0 : reserves.filter((outcome) => !outcome.ok && /Existing drawing copy attempt differs/.test(outcome.stderr)).length },
      publications: { succeeded: results.length, replayedFlags: results.map((item) => item.replayed).sort(), sameReceipt: new Set(results.map((item) => `${item.file_id}|${item.drawing_set_id}|${item.revision_id}|${item.job_id}`)).size === 1, refusedAnotherVersion: publishes.filter((outcome) => !outcome.ok && /not reserved with this evidence/.test(outcome.stderr)).length },
      rows, manifest: { status: after.status, receiptMatches: results.length > 0 && after.receipt.file_id === results[0].file_id && after.receipt.job_id === results[0].job_id },
    })
  }
  equal(check, "workers racing to reserve and to publish one plan-drawing copy produce one attempt and one file, set, revision and processor job; the losers are clean refusals or replays of the same receipt", spec.expected, { rounds })
  return { rounds: rounds.length }
}

// ---------------------------------------------------------------------------
// EP07-16: processors and notice workers own their claims; cleanup never deletes what is referenced.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Claims the job, waiting out any other worker of the shared stack that is holding it for the moment. */
const drawingClaim = async (kit, jobId, { patient = true } = {}) => {
  for (let tries = 0; tries < (patient ? 45 : 1); tries += 1) {
    wakeJob(kit, jobId)
    const claim = drawingClaimOnce(kit, jobId)
    if (claim) return claim
    if (patient) await pause(2000)
  }
  return null
}
const drawingClaimOnce = (kit, jobId) => {
  // The queue is shared and claims come oldest first: take batches until this job turns up, then hand every other
  // job (this organisation's other homes, other organisations') straight back untouched.
  const held = []
  let mine = null
  for (let batch = 0; batch < 30 && !mine; batch += 1) {
    const rows = parsed(svc(kit, `select 'R:'||coalesce(jsonb_agg(c),'[]'::jsonb)::text from public.claim_drawing_jobs(array['process_drawing_set'],6) c;`)) ?? []
    if (!rows.length) break
    for (const row of rows) { if (String(row.job_id) === String(jobId)) mine = row; else held.push(row) }
  }
  for (const other of held) svc(kit, `select public.transition_drawing_job_lease(${other.job_id},${kit.q(other.claim_token)}::uuid,'release');`)
  return mine
}
const drawingTransition = (kit, jobId, token, action, error = null) => parsed(svc(kit, `select 'R:'||public.transition_drawing_job_lease(${jobId},${kit.q(token)}::uuid,${kit.q(action)},${kit.q(error)});`))
const drawingRow = (kit, jobId) => kit.rows(`select status, retry_count, last_error, drawing_claim_token is not null claimed, run_at <= now() due from public.outbox where id=${jobId}`)[0]
const expireDrawingLease = (kit, jobId) => kit.sql(`update public.outbox set drawing_lease_expires_at=clock_timestamp()-interval '1 second' where id=${jobId}`)

async function drawingProcessorClaims(kit, spec, check) {
  const { equal } = lot()
  const seen = await lifecycle(kit)
  const jobId = seen.published.job_id
  const revisionId = seen.published.revision_id
  const out = {}
  // Start from the job as it was published: another run's drain may have tried it once, without storage, while it sat queued.
  kit.sql(`update public.outbox set status='pending', retry_count=0, last_error=null, drawing_claim_token=null, drawing_lease_expires_at=null, run_at=clock_timestamp()+interval '2 hours' where id=${jobId}`)
  kit.sql(`update public.drawing_revisions set processing_stage='queued', error_message=null where id=${kit.q(revisionId)}`)
  const first = await drawingClaim(kit, jobId)
  out.claimed = Boolean(first)
  out.secondClaimDoesNotTakeIt = drawingClaimOnce(kit, jobId) === null
  out.strangerTokenCannotComplete = drawingTransition(kit, jobId, randomUUID(), "complete")
  out.ownerHeartbeat = drawingTransition(kit, jobId, first.claim_token, "heartbeat")
  const liveWrite = attempt(kit, `set role service_role;\n\\o /dev/null\nselect set_config('request.headers','${JSON.stringify({ "x-drawing-job-id": String(jobId), "x-drawing-claim-token": first.claim_token })}',false);\n\\o\nupdate public.drawing_revisions set processing_stage='splitting' where id=${kit.q(revisionId)};`)
  out.liveClaimMayWriteItsRevision = liveWrite.ok ? "allowed" : liveWrite.err.slice(0, 200)
  // The claim goes stale.
  expireDrawingLease(kit, jobId)
  const staleWrite = attempt(kit, `set role service_role;\n\\o /dev/null\nselect set_config('request.headers','${JSON.stringify({ "x-drawing-job-id": String(jobId), "x-drawing-claim-token": first.claim_token })}',false);\n\\o\nupdate public.drawing_revisions set processing_stage='ready' where id=${kit.q(revisionId)};`)
  out.staleClaimWrite = refusedAs(staleWrite, /Drawing job lease lost/)
  out.staleClaimComplete = drawingTransition(kit, jobId, first.claim_token, "complete")
  out.staleRevisionUntouched = kit.rows(`select processing_stage from public.drawing_revisions where id=${kit.q(revisionId)}`)[0].processing_stage
  svc(kit, `select public.recover_drawing_job_leases(array['process_drawing_set']);`)
  out.afterRecovery = (({ status, retry_count, last_error, claimed }) => ({ status, retryCount: retry_count, lastError: last_error, claimed }))(drawingRow(kit, jobId))
  const second = await drawingClaim(kit, jobId)
  out.reclaimedWithNewToken = Boolean(second) && second.claim_token !== first.claim_token
  out.oldTokenStillCannotComplete = drawingTransition(kit, jobId, first.claim_token, "complete")
  out.stillOwnedByNewClaim = drawingRow(kit, jobId).status
  // A real failure of the live claim backs off rather than retrying immediately.
  out.liveRetry = drawingTransition(kit, jobId, second.claim_token, "retry", "Page render failed")
  const backoff = drawingRow(kit, jobId)
  out.afterRetry = { status: backoff.status, retryCount: backoff.retry_count, dueNow: backoff.due }
  out.notClaimableDuringBackoff = drawingClaimOnce(kit, jobId) === null
  // Retries are bounded: the third failure ends the job and tells the revision.
  const third = await drawingClaim(kit, jobId)
  expireDrawingLease(kit, jobId)
  svc(kit, `select public.recover_drawing_job_leases(array['process_drawing_set']);`)
  const last = drawingRow(kit, jobId)
  out.afterThirdFailure = { status: last.status, retryCount: last.retry_count, claimed: last.claimed, tokenWasLive: Boolean(third) }
  out.revisionTold = kit.rows(`select processing_stage, error_message is not null as has_message from public.drawing_revisions where id=${kit.q(revisionId)}`)[0]
  out.deadJobCannotBeClaimed = drawingClaimOnce(kit, jobId) === null
  // leave the job as it was published, out of the shared queue
  kit.sql(`update public.outbox set status='pending', retry_count=0, last_error=null, run_at=clock_timestamp()+interval '2 hours' where id=${jobId}`)
  equal(check, "a drawing processor owns its job only while its claim is live: strangers and stale claims cannot complete or write, expired claims are recovered once, retries back off and end after three", spec.expected, out)
  return { orgId: seen.home.orgId, jobId }
}

const startsClaim = (kit, orgId, jobId, minutes = 10) => kit.sql(`update public.outbox set status='processing', updated_at=clock_timestamp(), start_claim_token=gen_random_uuid(), start_job_lease_expires_at=clock_timestamp()+interval '${minutes} minutes'
  where org_id=${kit.q(orgId)} and id=${jobId} and status='pending' returning start_claim_token::text`)
const startsTransition = (kit, orgId, jobId, token, action, error = null) => attempt(kit, `select 'R:'||public.transition_starts_job_lease(${kit.q(orgId)},${jobId},${kit.q(token)}::uuid,${kit.q(action)},${kit.q(error)});`)
const startsRow = (kit, jobId) => kit.rows(`select status, retry_count, last_error, start_claim_token is not null claimed, run_at <= now() due from public.outbox where id=${jobId}`)[0]
const expireStartsLease = (kit, jobId) => kit.sql(`update public.outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second' where id=${jobId}`)
const addNotice = (kit, home, type = "start_release_trade_notice") => Number(kit.sql(`insert into public.outbox(org_id,job_type,payload,run_at) values(${kit.q(home.orgId)},${kit.q(type)},${kit.q(JSON.stringify({ start_package_id: home.packageId, project_id: home.projectId, company_id: home.org.vendorIds["Cypress Sitework"], actor_id: home.actorId }))}::jsonb, now()) returning id`))

async function noticeWorkerClaims(kit, spec, check) {
  const { equal } = lot()
  const seen = await lifecycle(kit)
  const home = seen.home
  const out = {}
  // The shared release job was claimed for 20 minutes when the fixture was built. A whole-scenario run is
  // longer than that, so by now recovery or this subcase's own pipeline drain may have taken it and finished
  // the release. Hand the job back to a live claim before anything below runs.
  const releaseJob = { id: seen.job.id, token: kit.sql(`update public.outbox set status='processing', updated_at=clock_timestamp(), start_claim_token=gen_random_uuid(), start_job_lease_expires_at=clock_timestamp()+interval '20 minutes' where id=${seen.job.id} returning start_claim_token::text`) }
  // The worker itself: a notice for a release still running is deferred, not failed and not sent.
  const deferJob = addNotice(kit, home)
  await runPipeline(kit)
  const deferred = startsRow(kit, deferJob)
  out.noticeForARunningRelease = { status: deferred.status, retryCount: deferred.retry_count, claimed: deferred.claimed, retriesLater: !deferred.due }
  // Ownership and retry rules of the claim.
  const job = addNotice(kit, home)
  const token = startsClaim(kit, home.orgId, job)
  out.strangerTokenCannotComplete = parsed(startsTransition(kit, home.orgId, job, randomUUID(), "complete").out)
  out.otherOrganisationCannotTouchIt = parsed(startsTransition(kit, randomUUID(), job, token, "complete").out)
  out.unknownActionRefused = refusedAs(startsTransition(kit, home.orgId, job, token, "steal"), /Invalid starts lease transition/)
  out.ownerHeartbeat = parsed(startsTransition(kit, home.orgId, job, token, "heartbeat").out)
  expireStartsLease(kit, job)
  out.staleClaimComplete = parsed(startsTransition(kit, home.orgId, job, token, "complete").out)
  out.staleClaimRetry = parsed(startsTransition(kit, home.orgId, job, token, "retry", "late").out)
  svc(kit, `select public.recover_starts_job_leases(500);`)
  const afterRecovery = startsRow(kit, job)
  out.recovery = { status: afterRecovery.status, retryCount: afterRecovery.retry_count, lastError: afterRecovery.last_error, claimed: afterRecovery.claimed }
  const second = startsClaim(kit, home.orgId, job)
  out.newClaimToken = Boolean(second) && second !== token
  out.oldTokenCannotComplete = parsed(startsTransition(kit, home.orgId, job, token, "complete").out)
  out.liveRetry = parsed(startsTransition(kit, home.orgId, job, second, "retry", "Mail provider unavailable").out)
  const backedOff = startsRow(kit, job)
  out.afterRetry = { status: backedOff.status, retryCount: backedOff.retry_count, lastError: backedOff.last_error, dueNow: backedOff.due }
  // Retries end after the third failure.
  kit.sql(`update public.outbox set run_at=clock_timestamp() where id=${job}`)
  out.finalFailure = parsed(startsTransition(kit, home.orgId, job, startsClaim(kit, home.orgId, job), "retry", "Mail provider unavailable").out)
  const ended = startsRow(kit, job)
  out.afterThirdFailure = { status: ended.status, retryCount: ended.retry_count, claimed: ended.claimed }
  // A release job cannot be completed by its worker unless the package durably released.
  out.releaseJobCompletionNeedsAReleasedPackage = refusedAs(startsTransition(kit, home.orgId, releaseJob.id, releaseJob.token, "complete"), /durably released package/)
  out.releaseJobStillClaimed = startsRow(kit, releaseJob.id).status
  equal(check, "a notice worker owns its job only while its claim is live: strangers, other organisations and stale claims cannot move it, expired claims are recovered, retries back off and end after three, and a release job cannot complete before the package is released", spec.expected, out)
  return { orgId: home.orgId, jobs: [deferJob, job] }
}

const agedReservation = (kit, home, evidenceItem = evidence) => {
  const reserved = parsed(svc(kit, script(null, rpc.reserve(kit, home, evidenceItem))))
  kit.sql(`update public.projects set metadata=jsonb_set(metadata,'{plan_instantiation,drawing_copy_attempt,reserved_at}',to_jsonb(to_char(now()-interval '2 days','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where id=${kit.q(home.projectId)}`)
  return reserved
}
const claimAbandoned = (kit, orgId) => (parsed(svc(kit, `select 'R:'||coalesce(jsonb_agg(c),'[]'::jsonb)::text from public.claim_abandoned_plan_drawing_copies(25) c;`)) ?? []).filter((row) => row.org_id === orgId)
const clearAbandoned = (kit, home, attemptId) => parsed(svc(kit, `select 'R:'||public.clear_abandoned_plan_drawing_copy(${kit.q(home.orgId)},${kit.q(home.projectId)},${kit.q(attemptId)});`))
const manifestStatus = (kit, projectId) => manifestOf(kit, projectId).drawing_copy_attempt?.status ?? "none"

async function abandonedCopyCleanup(kit, spec, check) {
  const { equal } = lot()
  const out = {}
  // 1. A fresh reservation is not abandoned: its copy may be in flight.
  const fresh = await benchHome(kit)
  const freshReserved = parsed(svc(kit, script(null, rpc.reserve(kit, fresh, evidence))))
  out.freshReservationNotClaimed = claimAbandoned(kit, fresh.orgId).filter((row) => row.attempt_id === freshReserved.attempt_id).length
  // 2. An old reservation nobody published is claimed: marked abandoned, audited, and neither reservable nor publishable again.
  const home = await benchHome(kit)
  const reserved = agedReservation(kit, home)
  const claimed = claimAbandoned(kit, home.orgId).filter((row) => row.attempt_id === reserved.attempt_id)
  out.oldReservationClaimed = { claimed: claimed.length, pathHandedToDeletion: claimed[0]?.storage_path === reserved.storage_path, manifest: manifestStatus(kit, home.projectId) }
  out.audit = count(kit, `public.audit_log where org_id=${kit.q(home.orgId)} and entity_id=${kit.q(home.projectId)} and source='plan_drawing_copy.abandoned'`)
  out.abandonedPathCannotBePublished = refusedAs(attempt(kit, script(null, rpc.publish(kit, home, copyOf(reserved)))), /not reserved with this evidence/)
  out.abandonedPathCannotBeReserved = refusedAs(attempt(kit, script(null, rpc.reserve(kit, home, evidence))), /Existing drawing copy attempt differs/)
  out.rowsAfterRefusals = rowsFor(kit, home, reserved.storage_path)
  // 3. The deleting step is outside the database: when it fails (no storage here) the manifest is NOT cleared.
  const swept = await planInstantiation().cleanupAbandonedPlanDrawingCopies()
  const sweep = swept.failed.some((failure) => /Missing R2 credentials/.test(failure.message)) ? "refused: object not deleted" : swept.cleared > 0 ? "cleared" : "nothing to clear"
  out.sweepWhenDeleteFails = { outcome: sweep, manifest: manifestStatus(kit, home.projectId) }
  // 4. Once the object is gone the manifest is cleared, audited, and the path is free for a new reservation.
  out.cleared = clearAbandoned(kit, home, reserved.attempt_id)
  out.manifestAfterClear = manifestStatus(kit, home.projectId)
  out.clearedAudit = count(kit, `public.audit_log where org_id=${kit.q(home.orgId)} and entity_id=${kit.q(home.projectId)} and source='plan_drawing_copy.cleared'`)
  out.clearingAgainDoesNothing = clearAbandoned(kit, home, reserved.attempt_id)
  const fresh2 = parsed(svc(kit, script(null, rpc.reserve(kit, home, evidence))))
  out.newReservationAfterClear = { status: fresh2.status, newPath: fresh2.storage_path !== reserved.storage_path }
  // 5. A referenced object is never cleaned up. A published copy is never claimed, and a manifest whose path a file names cannot be cleared.
  const published = await benchHome(kit)
  const pubReserved = agedReservation(kit, published)
  parsed(svc(kit, script(null, rpc.publish(kit, published, copyOf(pubReserved)))))
  shelveProcessorJobs(kit, published)
  out.publishedCopyNotClaimed = claimAbandoned(kit, published.orgId).filter((row) => row.attempt_id === pubReserved.attempt_id).length
  out.publishedManifest = manifestStatus(kit, published.projectId)
  const referenced = await benchHome(kit)
  const refReserved = agedReservation(kit, referenced)
  kit.sql(`insert into public.files(org_id,project_id,file_name,storage_path,mime_type,size_bytes,source) values(${kit.q(referenced.orgId)},${kit.q(referenced.projectId)},${kit.q(PDF_NAME)},${kit.q(refReserved.storage_path)},'application/pdf',${PDF_BYTES},'generated')`)
  out.reservationNamedByAFileNotClaimed = { claimed: claimAbandoned(kit, referenced.orgId).filter((row) => row.attempt_id === refReserved.attempt_id).length, manifest: manifestStatus(kit, referenced.projectId) }
  kit.sql(`update public.projects set metadata=jsonb_set(metadata,'{plan_instantiation,drawing_copy_attempt,status}','"abandoned"') where id=${kit.q(referenced.projectId)}`)
  const clearReferenced = attempt(kit, `set role service_role;\nselect public.clear_abandoned_plan_drawing_copy(${kit.q(referenced.orgId)},${kit.q(referenced.projectId)},${kit.q(refReserved.attempt_id)});`)
  out.referencedAbandonedManifestCannotBeCleared = { outcome: refusedAs(clearReferenced, /referenced by a file/), manifest: manifestStatus(kit, referenced.projectId), fileStillThere: count(kit, `public.files where org_id=${kit.q(referenced.orgId)} and storage_path=${kit.q(refReserved.storage_path)}`) }
  // 6. Browser roles cannot run the sweep.
  const browser = attempt(kit, `set role authenticated;\nselect * from public.claim_abandoned_plan_drawing_copies(1);`)
  out.browserCannotSweep = browser.ok ? "allowed" : /permission denied/.test(browser.err) ? "refused" : browser.err.slice(0, 200)
  // leave nothing for other workers' sweeps to trip over
  for (const item of [home, published, referenced]) {
    const status = manifestStatus(kit, item.projectId)
    if (status === "abandoned") kit.sql(`update public.projects set metadata=metadata #- '{plan_instantiation,drawing_copy_attempt}' where id=${kit.q(item.projectId)}`)
    if (status === "reserved") kit.sql(`update public.projects set metadata=metadata #- '{plan_instantiation,drawing_copy_attempt}' where id=${kit.q(item.projectId)}`)
  }
  kit.sql(`update public.projects set metadata=metadata #- '{plan_instantiation,drawing_copy_attempt}' where id=${kit.q(fresh.projectId)}`)
  equal(check, "abandoned copy cleanup claims only old unpublished reservations, refuses to touch a path any file names, clears the manifest only after the object is deleted, and is a service-role job", spec.expected, out)
  return { orgId: home.orgId }
}

async function raceStaleClaimsAndCleanup(kit, spec, check) {
  const { equal } = lot()
  const rounds = []
  const winners = []
  const home = (await lifecycle(kit)).home
  for (let round = 1; round <= 3; round += 1) {
    const result = { round }
    // A stale notice-worker claim against recovery and a new live claim.
    const job = addNotice(kit, home)
    const stale = startsClaim(kit, home.orgId, job)
    expireStartsLease(kit, job)
    const claimLive = `update public.outbox set status='processing', start_claim_token=gen_random_uuid(), start_job_lease_expires_at=clock_timestamp()+interval '10 minutes', updated_at=clock_timestamp() where id=${job} and status='pending';`
    const noticeRace = await race(kit, [
      script(null, `select 'R:'||public.transition_starts_job_lease(${kit.q(home.orgId)},${job},${kit.q(stale)}::uuid,'complete');`),
      script(null, `select 'R:'||public.recover_starts_job_leases(500);\n${claimLive}`),
    ])
    const noticeRow = startsRow(kit, job)
    result.notice = { staleCompletionRefused: noticeRace[0].ok && parsed(noticeRace[0].stdout) === false, notCompletedByStaleClaim: noticeRow.status !== "completed", status: noticeRow.status === "processing" || noticeRow.status === "pending" ? "owned by the new claim or queued" : noticeRow.status, retryCountedOnce: noticeRow.retry_count === 1 }
    kit.sql(`update public.outbox set status='completed' where id=${job}`)

    // A stale drawing-processor claim against recovery.
    const lifeline = await lifecycle(kit)
    const drawingJob = lifeline.published.job_id
    kit.sql(`update public.outbox set status='pending', retry_count=0, run_at=clock_timestamp(), drawing_claim_token=null, drawing_lease_expires_at=null where id=${drawingJob}`)
    const drawingStale = await drawingClaim(kit, drawingJob)
    expireDrawingLease(kit, drawingJob)
    const drawingRace = await race(kit, [
      script(null, `select 'R:'||public.transition_drawing_job_lease(${drawingJob},${kit.q(drawingStale.claim_token)}::uuid,'complete',null);`),
      script(null, `select 'R:'||public.recover_drawing_job_leases(array['process_drawing_set']);`),
    ])
    const drawingAfter = drawingRow(kit, drawingJob)
    result.drawing = { staleCompletionRefused: drawingRace[0].ok && parsed(drawingRace[0].stdout) === false, status: drawingAfter.status, retryCountedOnce: drawingAfter.retry_count === 1, claimed: drawingAfter.claimed }
    kit.sql(`update public.outbox set status='pending', retry_count=0, run_at=clock_timestamp()+interval '2 hours', drawing_claim_token=null, drawing_lease_expires_at=null, last_error=null where id=${drawingJob}`)

    // Cleanup against a publication that references the object.
    const bench = await benchHome(kit)
    const reserved = agedReservation(kit, bench)
    // The sweep starts a little later in later rounds, so the publication gets there first in some of them.
    const sweepDelay = [0, 0.012, 0.03][round - 1]
    const sweep = `${sweepDelay ? `select pg_sleep(${sweepDelay});\n` : ""}select 'R:'||coalesce(jsonb_agg(c),'[]'::jsonb)::text from public.claim_abandoned_plan_drawing_copies(25) c;\nselect 'R:'||public.clear_abandoned_plan_drawing_copy(${kit.q(bench.orgId)},${kit.q(bench.projectId)},${kit.q(reserved.attempt_id)});`
    const cleanupRace = await race(kit, [script(null, sweep), script(null, rpc.publish(kit, bench, copyOf(reserved)))])
    shelveProcessorJobs(kit, bench)
    const filesNamingPath = count(kit, `public.files where org_id=${kit.q(bench.orgId)} and storage_path=${kit.q(reserved.storage_path)}`)
    const status = manifestStatus(kit, bench.projectId)
    const published = cleanupRace[1].ok
    const cleanupLines = String(cleanupRace[0].stdout).split("\n").filter((line) => line.startsWith("R:"))
    const cleared = cleanupRace[0].ok && JSON.parse(cleanupLines[cleanupLines.length - 1].slice(2)) === true
    result.cleanup = {
      oneWinner: published !== cleared,
      referencedObjectKept: filesNamingPath === 1 ? (status === "published" && !cleared) : true,
      clearedOnlyWhenUnreferenced: cleared ? filesNamingPath === 0 && status === "none" : true,
      publicationRefusedWhenCleaned: published ? true : /not reserved with this evidence/.test(cleanupRace[1].stderr),
      rowsConsistent: filesNamingPath === (published ? 1 : 0) && rowsFor(kit, bench, reserved.storage_path).processorJobs === (published ? 1 : 0),
    }
    // nothing left abandoned for the shared sweep
    if (["abandoned", "reserved"].includes(manifestStatus(kit, bench.projectId))) kit.sql(`update public.projects set metadata=metadata #- '{plan_instantiation,drawing_copy_attempt}' where id=${kit.q(bench.projectId)}`)
    winners.push(published ? "publication" : "cleanup")
    rounds.push(result)
  }
  equal(check, "a stale claim never completes a job a recovered or live claim owns, and cleanup racing a publication never removes a manifest whose path a file names", spec.expected, { rounds })
  return { orgId: home.orgId, cleanupRaceWinners: winners }
}

// ---------------------------------------------------------------------------
// EP07-17: finalization is one transaction.

const packageSnapshot = (kit, home) => {
  const row = kit.rows(`select p.status, p.released_at is not null released, p.actual_start_date::text actual, l.status lot, pr.phase,
      (select count(*)::int from public.events e where e.org_id=p.org_id and e.entity_id=p.id and e.event_type='start.released') released_events,
      (select count(*)::int from public.events e where e.org_id=p.org_id and e.entity_id=p.id and e.event_type='start.release_cancelled') cancelled_events,
      (select count(*)::int from public.events e where e.org_id=p.org_id and e.entity_id=p.id and e.event_type='start.release_retried') retried_events,
      (select count(*)::int from public.audit_log a where a.org_id=p.org_id and a.entity_id=p.id and a.source='starts.release_published') published_audits,
      (select count(*)::int from public.audit_log a where a.org_id=p.org_id and a.entity_id=p.id and a.source='starts.release_cancelled') cancelled_audits,
      (select count(*)::int from public.audit_log a where a.org_id=p.org_id and a.entity_id=p.id and a.source='starts.release_retried') retried_audits
    from public.start_packages p join public.lots l on l.id=p.lot_id join public.projects pr on pr.id=p.project_id where p.id=${kit.q(home.packageId)}`)[0]
  const jobs = kit.rows(`select status from public.outbox where org_id=${kit.q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} order by id`)
  return { ...row, jobs: jobs.map((item) => item.status) }
}
const reindexJobs = (kit, home) => {
  const entities = { start_package: home.packageId, project: home.projectId, lot: home.lotId }
  return Object.fromEntries(Object.entries(entities).map(([type, id]) => [type, count(kit, `public.outbox where org_id=${kit.q(home.orgId)} and job_type='reindex_search' and payload->>'entity_type'=${kit.q(type)} and payload->>'entity_id'=${kit.q(id)}`)]))
}

/**
 * Ends the claims this area's earlier checks left parked (their homes mid-release, processor and notice jobs nobody
 * will run on a stack without storage), so the organisation's outbox can drain. Releases still running are cancelled by
 * the coordinator's own RPC; a published release's claim completes through its own transition.
 */
function retireParkedClaims(kit, orgId, actorId) {
  const jobs = kit.rows(`select o.id, o.start_claim_token::text token, o.payload->>'start_package_id' package_id, p.status
    from public.outbox o join public.start_packages p on p.id=(o.payload->>'start_package_id')::uuid
    where o.org_id=${kit.q(orgId)} and o.job_type='start_release' and o.status in ('pending','processing')`)
  for (const job of jobs) {
    if (job.status === "released") svc(kit, `select public.transition_starts_job_lease(${kit.q(orgId)},${job.id},${kit.q(job.token)}::uuid,'complete');`)
    else if (["releasing", "attention"].includes(job.status)) svc(kit, `select public.cancel_start_release(${kit.q(orgId)},${kit.q(job.package_id)},${kit.q(actorId)});`)
  }
  // Jobs this area ended on purpose (cancelled releases, processors that ran out of retries) are retired, not left as
  // failures for the organisation's outbox drain to report.
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(orgId)}
    and ((status in ('pending','processing') and job_type in ('process_drawing_set','start_release_trade_notice','trade_schedule_change_notice'))
      or (status='failed' and job_type in ('start_release','process_drawing_set','start_release_trade_notice','trade_schedule_change_notice')))`)
}

async function realRelease(kit, home) {
  // The lot is owned land: its basis moves into the house only once the home is adopted for owned-inventory accounting.
  // A spec home has no contract, so its revenue policy is the project-level one: earned at closing, reviewed by the accountant.
  const policies = app("books/revenue-policies")
  const proposal = await kit.as(home.org.owner, () => policies.proposeRevenuePolicy({ projectId: home.projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: "2026-06-01", rationale: "A spec home earns its revenue at closing." }))
  await kit.as(home.org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
  await kit.as(home.org.owner, () => app("books/inventory").enableProjectInventory({ projectId: home.projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/ownership` }))
  const queued = await kit.as(home.org.team.starts, () => app("starts").releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" }))
  if (!queued.released) throw Error(`The release was not queued: ${JSON.stringify(queued)}`)
  // The plan-set PDF copy needs file storage; that one step is settled directly and nothing else about the release is.
  kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)
  for (let tries = 0; tries < 6; tries += 1) {
    await runPipeline(kit)
    const status = kit.rows(`select status from public.start_packages where id=${kit.q(home.packageId)}`)[0].status
    if (["released", "attention"].includes(status)) break
  }
}

async function releaseFinalizesTogether(kit, spec, check) {
  const { equal } = lot()
  const home = await freshHome(kit)
  retireParkedClaims(kit, home.orgId, home.actorId)
  const before = packageSnapshot(kit, home)
  await realRelease(kit, home)
  await kit.drainOutbox(home.orgId)
  const after = packageSnapshot(kit, home)
  const eventId = confirmation().startsConfirmationId(home.orgId, home.packageId, "event")
  const events = kit.rows(`select id, entity_type, payload from public.events where org_id=${kit.q(home.orgId)} and entity_id=${kit.q(home.packageId)} and event_type='start.released'`)
  const audit = kit.rows(`select actor_user_id, before_data, after_data from public.audit_log where org_id=${kit.q(home.orgId)} and entity_id=${kit.q(home.packageId)} and source='starts.release_published'`)
  const project = kit.rows(`select start_date::text d, phase from public.projects where id=${kit.q(home.projectId)}`)[0]
  const pkg = kit.rows(`select scheduled_start_date::text scheduled, actual_start_date::text actual, released_by from public.start_packages where id=${kit.q(home.packageId)}`)[0]
  const steps = kit.rows(`select step_key, status from public.start_release_steps where start_package_id=${kit.q(home.packageId)} order by step_key`)
  // Notification intent: the claimed job is the intent; every recipient has one stable notification identity.
  const notified = kit.rows(`select id, user_id, payload->>'event_id' as event_id from public.notifications where org_id=${kit.q(home.orgId)} and notification_type='start_released' and payload->>'entity_id'=${kit.q(home.packageId)} order by user_id`)
  const holders = kit.rows(`select distinct m.user_id from public.memberships m join public.role_permissions rp on rp.role_id=m.role_id where m.org_id=${kit.q(home.orgId)} and m.status='active' and rp.permission_key in ('start.release','*')`).map((row) => row.user_id)
  // The house's assigned superintendent (every home needs one before it releases) is told too, with start.read.
  const superintendent = kit.rows(`select superintendent_id from public.projects where id=${kit.q(home.projectId)}`)[0].superintendent_id
  const audience = Array.from(new Set(superintendent ? [...holders, superintendent] : holders))
  const expectedIds = audience.map((userId) => confirmation().startsConfirmationId(home.orgId, home.packageId, "notification", userId)).sort()
  // Running the pipeline again, and the operator's recovery of the confirmation, publish nothing twice.
  await runPipeline(kit)
  await kit.drainOutbox(home.orgId)
  const rerun = packageSnapshot(kit, home)
  const notifiedAgain = count(kit, `public.notifications where org_id=${kit.q(home.orgId)} and notification_type='start_released' and payload->>'entity_id'=${kit.q(home.packageId)}`)
  equal(check, "a finished release commits the package status, the lot and home state, one durable event, one audit row and the notification intent together; replays publish nothing twice", spec.expected, {
    before: { package: before.status, lot: before.lot, phase: before.phase, jobs: before.jobs, releasedEvents: before.released_events },
    after: { package: after.status, released: after.released, lot: after.lot, phase: project.phase, startDateIsReleaseDate: project.d === pkg.scheduled && pkg.actual === pkg.scheduled, releasedByCoordinator: pkg.released_by === home.actorId, steps: Object.fromEntries(steps.map((step) => [step.step_key, step.status])) },
    event: { count: events.length, stableIdentity: events[0]?.id === eventId, scope: events[0]?.entity_type, namesHomeAndLot: events[0]?.payload.project_id === home.projectId && events[0]?.payload.lot_id === home.lotId, actorIsCoordinator: events[0]?.payload.actor_id === home.actorId },
    audit: { count: audit.length, byCoordinator: audit[0]?.actor_user_id === home.actorId, from: audit[0]?.before_data.status, to: audit[0]?.after_data.status, namesHome: audit[0]?.after_data.project_id === home.projectId },
    searchReindex: Object.fromEntries(Object.entries(reindexJobs(kit, home)).map(([type, n]) => [type, n >= 1])),
    notificationIntent: { releaseJobs: after.jobs, recipientsAreEveryStartReleaseHolder: JSON.stringify(notified.map((row) => row.id).sort()) === JSON.stringify(expectedIds) && notified.length > 0, citeTheEvent: notified.every((row) => row.event_id === eventId) },
    afterReplay: { package: rerun.status, releasedEvents: rerun.released_events, audits: rerun.published_audits, notifications: notifiedAgain === notified.length },
  })
  return { orgId: home.orgId, packageId: home.packageId }
}

async function publicationIsAllOrNothing(kit, spec, check) {
  const { equal } = lot()
  const home = await freshHome(kit)
  const job = await claimRelease(kit, home)
  settleSteps(kit, home, STEPS.filter((key) => key !== "drawings"))
  const eventId = confirmation().startsConfirmationId(home.orgId, home.packageId, "event")
  const publish = (token = job.token) => attempt(kit, `select 'R:'||public.publish_start_release(${kit.q(home.orgId)},${job.id},${kit.q(token)}::uuid,${kit.q(eventId)}::uuid)::text;`)
  const untouched = () => { const s = packageSnapshot(kit, home); return { package: s.status, lot: s.lot, releasedEvents: s.released_events, audits: s.published_audits, reindex: Object.values(reindexJobs(kit, home)).reduce((a, b) => a + b, 0) } }
  const baseline = untouched()
  const reindexBefore = reindexJobs(kit, home)
  const out = { baseline: { package: baseline.package, lot: baseline.lot, releasedEvents: baseline.releasedEvents, audits: baseline.audits } }
  const unchanged = () => JSON.stringify(untouched()) === JSON.stringify(baseline)
  // The job cannot complete before the package has durably released.
  out.completeBeforeRelease = refusedAs(startsTransition(kit, home.orgId, job.id, job.token, "complete"), /durably released package/)
  // 1. A step still pending: the ledger is the receipt.
  out.pendingStep = { outcome: refusedAs(publish(), /Release completion is not proven for: drawings/), nothingChanged: unchanged() }
  settleSteps(kit, home, ["drawings"])
  // 2. A step that settled with an error does not count.
  kit.sql(`update public.start_release_steps set error='Budget template missing' where start_package_id=${kit.q(home.packageId)} and step_key='budget'`)
  out.erroredStep = { outcome: refusedAs(publish(), /Release completion is not proven for: budget/), nothingChanged: unchanged() }
  kit.sql(`update public.start_release_steps set error=null where start_package_id=${kit.q(home.packageId)} and step_key='budget'`)
  // 3. Another worker's claim.
  out.wrongClaim = { outcome: refusedAs(publish(randomUUID()), /Starts worker lease lost/), nothingChanged: unchanged() }
  // 4. The package lease went stale.
  kit.sql(`update public.start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb((now()-interval '10 minutes')::text)) where id=${kit.q(home.packageId)}`)
  out.staleLease = { outcome: refusedAs(publish(), /Start package lease lost/), nothingChanged: unchanged() }
  kit.sql(`update public.start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb(now()::text)) where id=${kit.q(home.packageId)}`)
  // 5. The coordinator who queued it no longer holds the authority.
  kit.sql(`update public.memberships set status='suspended' where org_id=${kit.q(home.orgId)} and user_id=${kit.q(home.actorId)}`)
  out.actorLeft = { outcome: refusedAs(publish(), /no longer an active organization member/), nothingChanged: unchanged() }
  kit.sql(`update public.memberships set status='active' where org_id=${kit.q(home.orgId)} and user_id=${kit.q(home.actorId)}`)
  // 6. The lot left its home.
  // The lot guard refuses this while the package is live; the case is a lot moved by a path that bypassed it.
  kit.sql(`alter table public.lots disable trigger lots_active_start_guard; update public.lots set project_id=null where id=${kit.q(home.lotId)}; alter table public.lots enable trigger lots_active_start_guard;`)
  out.lotLeftItsHome = { outcome: refusedAs(publish(), /lot home ancestry differs/), nothingChanged: unchanged() }
  kit.sql(`update public.lots set project_id=${kit.q(home.projectId)} where id=${kit.q(home.lotId)}`)
  // 7. All good: everything lands together.
  const done = publish()
  const after = packageSnapshot(kit, home)
  out.published = {
    ok: done.ok, package: after.status, lot: after.lot, phase: after.phase, releasedEvents: after.released_events, audits: after.published_audits, eventIdIsTheConfirmationIdentity: count(kit, `public.events where id=${kit.q(eventId)}`) === 1,
    reindexAdded: Object.fromEntries(Object.entries(reindexJobs(kit, home)).map(([type, n]) => [type, n - reindexBefore[type]])),
    notificationIntentJob: kit.rows(`select status, start_claim_token is not null claimed from public.outbox where id=${job.id}`)[0],
  }
  // 8. Publishing again, with the same still-valid claim, writes nothing more.
  const again = publish()
  const afterAgain = packageSnapshot(kit, home)
  out.publishedTwice = { outcome: refusedAs(again, /no longer releasing/), releasedEvents: afterAgain.released_events, audits: afterAgain.published_audits }
  // 9. The worker finishes its notification and completes the claim.
  out.completeAfterRelease = parsed(startsTransition(kit, home.orgId, job.id, job.token, "complete").out)
  out.jobAfterComplete = startsRow(kit, job.id).status
  out.packageLease = kit.rows(`select metadata->>'release_lease_token' as token from public.start_packages where id=${kit.q(home.packageId)}`)[0].token
  equal(check, "publication writes the package, lot, home, event, audit and reindex together or not at all: an unsettled step, a foreign or stale claim, a departed coordinator and a lot that left its home each publish nothing", spec.expected, out)
  return { orgId: home.orgId, packageId: home.packageId }
}

/** The package parked for the coordinator: the attempts ended in failure, nobody holds it. */
function parkInAttention(kit, home, jobId) {
  kit.sql(`update public.outbox set status='failed', retry_count=3, last_error='Plan version is no longer released', start_claim_token=null, start_job_lease_expires_at=null where id=${jobId};
    update public.start_packages set status='attention', metadata=metadata||'{"release_lease_token":null,"release_lease_at":null}'::jsonb where id=${kit.q(home.packageId)};`)
}

async function raceReleaseFinalizeCancelRetry(kit, spec, check) {
  const { equal } = lot()
  const rounds = []
  const winners = []
  const live = (snapshot) => snapshot.jobs.filter((status) => ["pending", "processing"].includes(status)).length
  const eventIdOf = (home) => confirmation().startsConfirmationId(home.orgId, home.packageId, "event")
  // A. The worker's publication, duplicated, against the coordinator's cancel on a release whose steps all settled.
  // The canceller starts a little later each round so that publication wins some rounds and cancel others.
  const spare = []
  for (const [round, cancelDelay] of [0, 0.03, 0.08].entries()) {
    const home = spare.pop() ?? await freshHome(kit)
    const job = await claimRelease(kit, home, { settle: true })
    const publishSql = script(null, `select 'R:'||public.publish_start_release(${kit.q(home.orgId)},${job.id},${kit.q(job.token)}::uuid,${kit.q(eventIdOf(home))}::uuid)::text;`)
    const cancelSql = script(null, `${cancelDelay ? `select pg_sleep(${cancelDelay});\n` : ""}select 'R:'||public.cancel_start_release(${kit.q(home.orgId)},${kit.q(home.packageId)},${kit.q(home.actorId)})::text;`)
    const before = packageSnapshot(kit, home)
    const outcomes = await race(kit, [publishSql, publishSql, cancelSql])
    const snapshot = packageSnapshot(kit, home)
    const added = (key) => snapshot[key] - before[key]
    const published = outcomes.slice(0, 2).filter((outcome) => outcome.ok).length
    const cancelled = outcomes[2].ok
    const releasedState = snapshot.status === "released" && snapshot.lot === "started" && snapshot.phase === "delivery" && added("released_events") === 1 && added("published_audits") === 1 && added("cancelled_events") === 0 && added("cancelled_audits") === 0 && snapshot.jobs[snapshot.jobs.length - 1] === "processing" && live(snapshot) === 1
    const cancelledState = snapshot.status === "ready" && snapshot.lot === "assigned" && snapshot.phase === "precon" && added("released_events") === 0 && added("published_audits") === 0 && added("cancelled_events") === 1 && added("cancelled_audits") === 1 && live(snapshot) === 0
    winners.push(published ? "release" : "cancel")
    if (cancelled) spare.push(home)
    rounds.push({
      kind: "publish-vs-cancel",
      exactlyOneSideWon: (published === 1 && !cancelled) || (published === 0 && cancelled),
      loserRefusedCleanly: cancelled ? outcomes.slice(0, 2).every((outcome) => /lease lost|no longer releasing|Release completion|lease/.test(outcome.stderr)) : /not cancellable/.test(outcomes[2].stderr) && /no longer releasing|lease lost/.test(outcomes.find((outcome, index) => index < 2 && !outcome.ok)?.stderr ?? "no loser"),
      finalState: releasedState || cancelledState ? "one consistent outcome: released with its one event and audit, or cancelled and idle" : `inconsistent ${JSON.stringify(snapshot)}`,
    })
  }
  // B. Coordinators cancelling and retrying one parked release together, through the services.
  const home = spare.pop() ?? await freshHome(kit)
  for (let round = 1; round <= 3; round += 1) {
    const job = await claimRelease(kit, home, { settle: true })
    parkInAttention(kit, home, job.id)
    const before = packageSnapshot(kit, home)
    // Whichever request starts second varies by round, so both orders get exercised.
    const [cancelDelay, retryDelay] = [[0, 0], [40, 0], [0, 40]][round - 1]
    const later = (ms, work) => new Promise((resolve) => setTimeout(resolve, ms)).then(work)
    const [cancelOutcome, retryOutcome] = await Promise.allSettled([
      later(cancelDelay, () => kit.as(home.org.team.starts, () => app("starts").cancelRelease(home.packageId))),
      later(retryDelay, () => kit.as(home.org.team.starts, () => app("starts").retryRelease(home.packageId))),
    ])
    const snapshot = packageSnapshot(kit, home)
    const retryMessage = retryOutcome.status === "rejected" ? String(retryOutcome.reason.message) : ""
    const retried = retryOutcome.status === "fulfilled"
    winners.push(retried ? "retry-then-cancel" : "cancel-then-retry-refused")
    rounds.push({
      kind: "cancel-vs-retry",
      cancel: cancelOutcome.status,
      retry: retried || /Only releases needing attention|not cancellable|still running|Failed to requeue/.test(retryMessage) ? "retried and then cancelled, or refused cleanly" : retryMessage,
      finalState: snapshot.status === "ready" && live(snapshot) === 0 && snapshot.released_events === 0 && snapshot.cancelled_events - before.cancelled_events === 1 && snapshot.cancelled_audits - before.cancelled_audits === 1 ? "ready and idle, cancelled once" : `inconsistent ${JSON.stringify(snapshot)}`,
      retryRecordedOnlyIfItRan: snapshot.retried_events - before.retried_events === (retried ? 1 : 0) && snapshot.retried_audits - before.retried_audits === (retried ? 1 : 0),
    })
  }
  // C. Two coordinators retrying together: one job, one winner.
  for (let round = 1; round <= 3; round += 1) {
    const job = await claimRelease(kit, home, { settle: true })
    parkInAttention(kit, home, job.id)
    const before = packageSnapshot(kit, home)
    const outcomes = await Promise.allSettled([
      kit.as(home.org.team.starts, () => app("starts").retryRelease(home.packageId)),
      kit.as(home.org.team.starts, () => app("starts").retryRelease(home.packageId)),
    ])
    const snapshot = packageSnapshot(kit, home)
    rounds.push({
      kind: "retry-vs-retry",
      retried: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      refusedCleanly: outcomes.filter((outcome) => outcome.status === "rejected" && /Only releases needing attention|still running|Failed to requeue/.test(String(outcome.reason.message))).length,
      finalPackage: snapshot.status, queuedJobs: snapshot.jobs.filter((status) => status === "pending").length,
      retriedEvents: snapshot.retried_events - before.retried_events, retriedAudits: snapshot.retried_audits - before.retried_audits,
    })
    // the coordinator ends this attempt before the next round
    await kit.as(home.org.team.starts, () => app("starts").cancelRelease(home.packageId))
  }
  equal(check, "cancel, retry and finalize racing on one release leave one consistent state: released with its one event and audit, or cancelled and idle, never both; two retries queue one job", spec.expected, { rounds })
  return { winners }
}

// ---------------------------------------------------------------------------
// EP07-14, -15, -16 on real storage (`--storage-env`, the acceptance bucket): the conditional server-side
// copy, the lost-response retry, the changed source, the real sweep delete and a release that copies for
// real. Each reports BLOCKED without storage; the no-storage subcase above stays as the fallback proof.

const storageLayer = () => require("../../../lib/storage/files-storage")
const sha256 = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex")
const objectKey = (storagePath) => `project-files/${storagePath.replace(/^\//, "")}`
const objectUrl = (storagePath) => `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${objectKey(storagePath).split("/").map(encodeURIComponent).join("/")}`
const rawStorage = () => {
  const { S3Client } = require("@aws-sdk/client-s3")
  return new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } })
}
const pdfBytes = (label, size = 65536) => Buffer.concat([Buffer.from(`%PDF-1.4 ${label} ${randomUUID()}\n`), Buffer.alloc(size, 0x20)]).subarray(0, size)
const attemptOf = (kit, home) => manifestOf(kit, home.projectId).drawing_copy_attempt
const sourceRow = (kit, home) => { const row = kit.rows(`select id, storage_path, mime_type, size_bytes, file_name from public.files where id=${kit.q(home.planFileId)}`)[0]; return { ...row, size_bytes: Number(row.size_bytes) } }
const publishFor = (kit, home) => kit.service(() => copyService().publishPlanDrawingCopy({ orgId: home.orgId, projectId: home.projectId, planVersionId: home.planVersionId, actorId: home.actorId, source: sourceRow(kit, home) }))
const readObject = (kit, orgId, storagePath) => kit.service(async () => Buffer.from(await storageLayer().downloadFilesObject({ supabase: null, orgId, path: storagePath })))
const objectState = async (kit, orgId, storagePath) => {
  try { await kit.service(() => storageLayer().headFilesObject({ orgId, path: storagePath })); return "present" } catch (error) {
    return storageLayer().isMissingFilesObject(error) ? "absent" : error.message
  }
}
/** The plan version's library PDF as a real object holding `bytes`, with the file record saying so. */
async function stagePlanPdf(kit, home, bytes) {
  const source = sourceRow(kit, home)
  await kit.service(() => storageLayer().uploadFilesObject({ supabase: null, orgId: home.orgId, path: source.storage_path, bytes, contentType: "application/pdf", upsert: true }))
  kit.sql(`update public.files set size_bytes=${bytes.length}, checksum=${kit.q(sha256(bytes))} where id=${kit.q(home.planFileId)}`)
}
/** What a worker records at reservation: the source's own size and version. */
const headEvidence = async (kit, home) => {
  const head = await kit.service(() => storageLayer().headFilesCopySource({ orgId: home.orgId, path: sourceRow(kit, home).storage_path }))
  return { size_bytes: head.size, source_etag: head.sourceEtag }
}
const reserveFor = async (kit, home) => parsed(svc(kit, script(null, rpc.reserve(kit, home, await headEvidence(kit, home)))))
const refusalOf = async (work) => { try { await work(); return "allowed" } catch (error) { return String(error.message) } }
const publishedRows = (kit, home) => ({
  files: count(kit, `public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`),
  drawingSets: count(kit, `public.drawing_sets where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)}`),
  revisions: count(kit, `public.drawing_revisions where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)}`),
  processorJobs: count(kit, `public.outbox where org_id=${kit.q(home.orgId)} and job_type='process_drawing_set' and payload->>'projectId'=${kit.q(home.projectId)}`),
})
const noPublishedRows = { files: 0, drawingSets: 0, revisions: 0, processorJobs: 0 }
const onePublishedRow = { files: 1, drawingSets: 1, revisions: 1, processorJobs: 1 }
const ageManifest = (kit, home) => kit.sql(`update public.projects set metadata=jsonb_set(metadata,'{plan_instantiation,drawing_copy_attempt,reserved_at}',to_jsonb(to_char(now()-interval '2 days','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where id=${kit.q(home.projectId)}`)
const sweepNow = () => planInstantiation().cleanupAbandonedPlanDrawingCopies(200)

async function planPdfCopiesPrivatelyInRealStorage(kit, spec, check) {
  const { equal } = lot()
  const home = await benchHome(kit)
  const bytes = pdfBytes("plan set")
  await stagePlanPdf(kit, home, bytes)
  const source = sourceRow(kit, home)
  const sourceBefore = await kit.service(() => storageLayer().headFilesCopySource({ orgId: home.orgId, path: source.storage_path }))
  const result = await publishFor(kit, home)
  shelveProcessorJobs(kit, home)
  const manifest = attemptOf(kit, home)
  const file = kit.rows(`select storage_path, visibility, source, category, size_bytes, metadata from public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`)[0]
  const copied = await readObject(kit, home.orgId, file.storage_path)
  const signed = await kit.service(() => storageLayer().createFilesDownloadUrl({ supabase: null, orgId: home.orgId, path: file.storage_path, expiresIn: 60 }))
  const member = await fetch(signed.downloadUrl)
  const unsigned = await fetch(objectUrl(file.storage_path))
  const otherOrg = await refusalOf(() => kit.service(() => storageLayer().createFilesDownloadUrl({ supabase: null, orgId: randomUUID(), path: file.storage_path, expiresIn: 60 })))
  const sourceAfter = await kit.service(() => storageLayer().headFilesCopySource({ orgId: home.orgId, path: source.storage_path }))
  equal(check, "the plan PDF is copied server-side onto the home's reserved path, byte for byte, private to its organisation, with the source untouched and the evidence recorded", spec.expected, {
    queued: result.queued,
    rows: publishedRows(kit, home),
    destination: { atReservedPath: file.storage_path === manifest.storage_path, bytesExact: sha256(copied) === sha256(bytes), sizeBytes: Number(file.size_bytes) === bytes.length },
    file: { visibility: file.visibility, source: file.source, category: file.category, evidenceRecorded: Boolean(file.metadata.source_storage_etag) && Boolean(file.metadata.storage_etag) },
    unsignedRead: unsigned.status,
    memberSignedRead: { status: member.status, privateCache: /private/.test(member.headers.get("cache-control") ?? "") && !/public/.test(member.headers.get("cache-control") ?? "") },
    anotherOrganisationsLink: /belong|organization|path/i.test(otherOrg) ? "refused" : otherOrg,
    sourceUntouched: sourceAfter.sourceEtag === sourceBefore.sourceEtag && sourceAfter.size === sourceBefore.size,
    manifest: manifest.status,
  })
  return { orgId: home.orgId, projectId: home.projectId }
}

async function planPdfCopyMemoryAndLatencyAreBounded(kit, spec, check) {
  const { equal } = lot()
  if (typeof global.gc !== "function") throw Error("Run with NODE_OPTIONS=--expose-gc to measure copy memory")
  const input = spec.inputs
  const home = await benchHome(kit)
  const source = sourceRow(kit, home)
  // Deterministic bytes, generated as they upload, so the run never holds the PDF either.
  const chunks = Math.ceil((input.documentMb * 1024 * 1024) / 32)
  const digest = require("node:crypto").createHash("sha256")
  let index = 0
  await kit.service(() => storageLayer().uploadFilesStream({ orgId: home.orgId, path: source.storage_path, contentType: "application/pdf", stream: new ReadableStream({
    pull(controller) {
      if (index >= chunks) return controller.close()
      const batch = []
      for (let n = 0; n < 2048 && index < chunks; n += 1, index += 1) batch.push(require("node:crypto").createHash("sha256").update(`plan-${index}`).digest())
      const bytes = Buffer.concat(batch); digest.update(bytes); controller.enqueue(bytes)
    } }) }))
  const size = chunks * 32, sourceSha = digest.digest("hex")
  kit.sql(`update public.files set size_bytes=${size}, checksum=${kit.q(sourceSha)} where id=${kit.q(home.planFileId)}`)
  const live = () => { global.gc(); const usage = process.memoryUsage(); return usage.heapUsed + usage.arrayBuffers }
  const baseline = live()
  let peak = baseline
  const sampler = setInterval(() => { peak = Math.max(peak, live()) }, 100)
  const started = Date.now()
  try { await publishFor(kit, home) } finally { clearInterval(sampler) }
  const latencyMs = Date.now() - started
  shelveProcessorJobs(kit, home)
  const file = kit.rows(`select storage_path from public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`)[0]
  const hashOf = async (storagePath) => {
    const url = (await kit.service(() => storageLayer().createFilesDownloadUrl({ supabase: null, orgId: home.orgId, path: storagePath, expiresIn: 300 }))).downloadUrl
    const hash = require("node:crypto").createHash("sha256")
    for await (const chunk of (await fetch(url)).body) hash.update(chunk)
    return hash.digest("hex")
  }
  const head = await kit.service(() => storageLayer().headFilesObject({ orgId: home.orgId, path: file.storage_path }))
  equal(check, "copying a PDF larger than the memory budget keeps the process inside it, finishes, and leaves an exact private copy", spec.expected, {
    documentMb: input.documentMb,
    growthWithinBudget: (peak - baseline) / (1024 * 1024) < input.memoryBudgetMb,
    copyHolds: { sizeBytes: Number(head.ContentLength) === size, bytesExact: (await hashOf(file.storage_path)) === sourceSha },
    published: publishedRows(kit, home),
  })
  // The bucket keeps nothing this large between runs.
  await kit.service(() => storageLayer().deleteFilesObjects({ supabase: null, orgId: home.orgId, paths: [source.storage_path, file.storage_path] }))
  return { orgId: home.orgId, peakGrowthMb: Math.round((peak - baseline) / (1024 * 1024)), latencyMs }
}

async function changedSourceCannotSucceedAndRecovers(kit, spec, check) {
  const { equal } = lot()
  const home = await benchHome(kit)
  const original = pdfBytes("plan set")
  await stagePlanPdf(kit, home, original)
  const reserved = await reserveFor(kit, home)
  // The source is swapped for different bytes of the same length after the reservation (the bypass STORE-01 uses).
  const { PutObjectCommand } = require("@aws-sdk/client-s3")
  const swapped = Buffer.from(original); swapped.write(`%PDF-1.4 SWAPPED ${randomUUID()}`)
  const source = sourceRow(kit, home)
  await rawStorage().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: objectKey(source.storage_path), Body: swapped, ContentType: "application/pdf" }))
  const refused = await refusalOf(() => publishFor(kit, home))
  const afterRefusal = { rows: publishedRows(kit, home), manifest: attemptOf(kit, home)?.status, destination: await objectState(kit, home.orgId, reserved.storage_path) }
  // The reservation is abandoned and swept; the next attempt reserves the new version and succeeds.
  ageManifest(kit, home)
  const swept = await sweepNow()
  const afterSweep = { manifest: attemptOf(kit, home)?.status ?? null, destination: await objectState(kit, home.orgId, reserved.storage_path) }
  const second = await publishFor(kit, home)
  shelveProcessorJobs(kit, home)
  const secondAttempt = attemptOf(kit, home)
  const newEtag = (await headEvidence(kit, home)).source_etag
  const file = kit.rows(`select storage_path from public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`)[0]
  equal(check, "a source replaced after reservation cannot be copied: nothing is published and no copy is referenced; the abandoned reservation is swept and a new attempt copies the new version", spec.expected, {
    copyOfAChangedSource: /no longer matches the reserved copy/.test(refused) ? "refused: source version changed" : refused,
    afterRefusal,
    sweptTheReservation: swept.claimed >= 1 && swept.failed.length === 0,
    afterSweep,
    secondAttempt: { queued: second.queued, rows: publishedRows(kit, home), newPath: secondAttempt.storage_path !== reserved.storage_path, reservedTheNewVersion: secondAttempt.source_etag === newEtag, bytesAreTheNewVersion: sha256(await readObject(kit, home.orgId, file.storage_path)) === sha256(swapped) },
  })
  return { orgId: home.orgId, projectId: home.projectId }
}

async function lostCopyResponseRetriesToTheSameReceipt(kit, spec, check) {
  const { equal } = lot()
  const home = await benchHome(kit)
  const bytes = pdfBytes("plan set")
  await stagePlanPdf(kit, home, bytes)
  const reserved = await reserveFor(kit, home)
  const source = sourceRow(kit, home)
  // The copy lands and its response is lost: the worker never learns the destination's version.
  await kit.service(() => storageLayer().copyFilesObject({ orgId: home.orgId, sourcePath: source.storage_path, destinationPath: reserved.storage_path,
    expectedSize: reserved.size_bytes, expectedSourceEtag: reserved.source_etag, contentType: "application/pdf" }))
  const afterLostResponse = { rows: publishedRows(kit, home), manifest: attemptOf(kit, home).status, destination: await objectState(kit, home.orgId, reserved.storage_path) }
  const retry = await publishFor(kit, home)
  shelveProcessorJobs(kit, home)
  const first = attemptOf(kit, home)
  const replay = await publishFor(kit, home)
  const replayed = attemptOf(kit, home)
  const file = kit.rows(`select storage_path from public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`)[0]
  equal(check, "a copy whose response was lost is retried onto the same reserved path and publishes one receipt, once; replaying the publication returns that receipt", spec.expected, {
    afterLostResponse,
    retry: { queued: retry.queued, rows: publishedRows(kit, home), samePath: file.storage_path === reserved.storage_path, bytesExact: sha256(await readObject(kit, home.orgId, file.storage_path)) === sha256(bytes), manifest: first.status },
    replay: { sameSet: replay.drawing_set_id === retry.drawing_set_id, sameReceipt: JSON.stringify(replayed.receipt) === JSON.stringify(first.receipt), rows: publishedRows(kit, home) },
  })
  return { orgId: home.orgId, projectId: home.projectId }
}

async function releaseEndToEndCopiesTheRealPlanSet(kit, spec, check) {
  const { equal } = lot()
  const home = await freshHome(kit, { pdf: true })
  const bytes = pdfBytes("plan set")
  await stagePlanPdf(kit, home, bytes)
  const queued = await kit.as(home.org.team.starts, () => app("starts").releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" }))
  if (!queued.released) throw Error(`The release was not queued: ${JSON.stringify(queued)}`)
  let status
  for (let pass = 0; pass < 6; pass += 1) {
    await runPipeline(kit)
    status = kit.rows(`select status from public.start_packages where id=${kit.q(home.packageId)}`)[0].status
    if (["released", "attention"].includes(status)) break
  }
  const step = kit.rows(`select status, detail from public.start_release_steps where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)[0]
  const manifest = attemptOf(kit, home)
  const file = kit.rows(`select storage_path from public.files where org_id=${kit.q(home.orgId)} and project_id=${kit.q(home.projectId)} and source='generated'`)[0]
  const swept = await sweepNow()
  equal(check, "a release copies the plan set for real through the worker: the drawings step completes with the published copy, the home has one file, set, revision and processor job, and the sweep leaves the published copy alone", spec.expected, {
    package: status,
    drawingsStep: step.status,
    rows: publishedRows(kit, home),
    manifest: manifest?.status,
    copyBytesExact: Boolean(file) && sha256(await readObject(kit, home.orgId, file.storage_path)) === sha256(bytes),
    sweepLeavesTheCopy: { claimedThisHome: manifest ? swept.claimed >= 0 : false, objectAfter: file ? await objectState(kit, home.orgId, file.storage_path) : "no file" },
  })
  return { orgId: home.orgId, projectId: home.projectId }
}

async function abandonedCopySweepDeletesOnlyTheReservedObject(kit, spec, check) {
  const { equal } = lot()
  // 1. A reserved copy that landed and was never published: its object goes, then its manifest.
  const lost = await benchHome(kit)
  await stagePlanPdf(kit, lost, pdfBytes("plan set"))
  const lostReservation = await reserveFor(kit, lost)
  await kit.service(() => storageLayer().copyFilesObject({ orgId: lost.orgId, sourcePath: sourceRow(kit, lost).storage_path, destinationPath: lostReservation.storage_path,
    expectedSize: lostReservation.size_bytes, expectedSourceEtag: lostReservation.source_etag, contentType: "application/pdf" }))
  const landed = await objectState(kit, lost.orgId, lostReservation.storage_path)
  ageManifest(kit, lost)
  // 2. A published copy: its object stays, readable.
  const kept = await benchHome(kit)
  await stagePlanPdf(kit, kept, pdfBytes("plan set"))
  await publishFor(kit, kept)
  shelveProcessorJobs(kit, kept)
  const keptFile = kit.rows(`select storage_path from public.files where org_id=${kit.q(kept.orgId)} and project_id=${kit.q(kept.projectId)} and source='generated'`)[0]
  // 3. A forged manifest naming an object that is not a plan copy: never handed to the delete.
  const forgedHome = await benchHome(kit)
  const forgedPath = `${forgedHome.orgId}/books-exports/close-archive-${randomUUID().slice(0, 8)}.json.gz`
  await kit.service(() => storageLayer().uploadFilesObject({ supabase: null, orgId: forgedHome.orgId, path: forgedPath, bytes: Buffer.from("books archive"), contentType: "application/gzip", upsert: false }))
  kit.sql(`update public.projects set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('plan_instantiation',jsonb_build_object('seq',1,'drawing_copy_attempt',jsonb_build_object('status','reserved','reserved_at',to_char(now()-interval '2 days','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'attempt_id',${kit.q(randomUUID())},'plan_version_id',${kit.q(forgedHome.planVersionId)},'source_file_id',${kit.q(forgedHome.planFileId)},'actor_id',${kit.q(forgedHome.actorId)},'storage_path',${kit.q(forgedPath)},'size_bytes',13,'source_etag','forged'))) where id=${kit.q(forgedHome.projectId)}`)
  const swept = await sweepNow()
  equal(check, "the sweep deletes the object of a reservation that was copied and never published, then clears its manifest; a published copy stays readable; a forged manifest naming another object is skipped and that object stays", spec.expected, {
    sweptCleanly: swept.failed.length === 0,
    abandonedCopy: { objectBefore: landed, objectAfter: await objectState(kit, lost.orgId, lostReservation.storage_path), manifest: attemptOf(kit, lost)?.status ?? null },
    publishedCopy: { objectAfter: await objectState(kit, kept.orgId, keptFile.storage_path), bytes: (await readObject(kit, kept.orgId, keptFile.storage_path)).length > 0, manifest: attemptOf(kit, kept).status },
    forgedManifest: { objectAfter: await objectState(kit, forgedHome.orgId, forgedPath), manifest: attemptOf(kit, forgedHome).status },
  })
  kit.sql(`update public.projects set metadata=metadata #- '{plan_instantiation,drawing_copy_attempt}' where id=${kit.q(forgedHome.projectId)}`)
  await kit.service(() => storageLayer().deleteFilesObjects({ supabase: null, orgId: forgedHome.orgId, paths: [forgedPath] }))
  return { orgId: lost.orgId }
}

const subcases = {
  "plan-pdf-copy-without-storage-reports-no-success": planPdfCopyWithoutStorage,
  "drawing-copy-reserved-then-published-atomically-and-replayed": drawingCopyReservedThenPublishedAtomically,
  "race-plan-drawing-copy-reserve-and-publish": raceDrawingCopy,
  "drawing-processor-claims-enforce-ownership-and-retries": drawingProcessorClaims,
  "notice-worker-claims-enforce-ownership-and-retries": noticeWorkerClaims,
  "abandoned-copy-cleanup-never-deletes-referenced-objects": abandonedCopyCleanup,
  "race-stale-worker-claims-and-copy-cleanup": raceStaleClaimsAndCleanup,
  "release-finalizes-package-home-lot-event-audit-and-intent-together": releaseFinalizesTogether,
  "release-publication-is-all-or-nothing": publicationIsAllOrNothing,
  "race-release-finalize-cancel-retry": raceReleaseFinalizeCancelRetry,
  "plan-pdf-copies-privately-in-real-storage": planPdfCopiesPrivatelyInRealStorage,
  "plan-pdf-copy-memory-and-latency-are-bounded": planPdfCopyMemoryAndLatencyAreBounded,
  "changed-source-cannot-succeed-and-recovers": changedSourceCannotSucceedAndRecovers,
  "lost-copy-response-retries-to-the-same-receipt": lostCopyResponseRetriesToTheSameReceipt,
  "release-end-to-end-copies-the-real-plan-set": releaseEndToEndCopiesTheRealPlanSet,
  "abandoned-copy-sweep-deletes-only-the-reserved-object": abandonedCopySweepDeletesOnlyTheReservedObject,
}
module.exports = { subcases }
