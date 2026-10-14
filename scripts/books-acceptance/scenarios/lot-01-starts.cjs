// LOT-01 workflow proof: starts. See lot-01.cjs for the chain these subcases build on.
//
// The starts pipeline is a claim-and-fence protocol: the coordinator queues a release, a
// worker claims the job under a token, and every write the worker makes is checked in
// its own transaction against that token, the package lease, the home it owns and the
// actor who queued it. These subcases drive the real services as the coordinator, and
// play the worker exactly as the pipeline does (service-role RPCs, and a PostgREST client
// that carries the claim headers), including a stale worker after the job was re-claimed.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")

const chain = () => require("./lot-01.cjs").helpers
const eq = (check, label, expected, observed) => chain().equal(check, label, expected, observed)
const dbServer = () => require("../../../lib/supabase/server")
const serviceClient = () => dbServer().createServiceSupabaseClient()
const workerClient = (job) => dbServer().createStartsWorkerSupabaseClient(Number(job.id), job.token)
const contextOf = () => require("../../../lib/services/context")

const JOB_PRIORITY = 1_000_000
const HOUR = "now() + interval '1 hour'"

// ---------------------------------------------------------------------------
// Small helpers

const messageOf = (error) => (typeof error === "string" ? error : error?.message ?? String(error))
/** What an attempt did: "allowed", or the refusal text. A PostgREST result carries its error in `.error`. */
async function attempt(work) {
  try {
    const result = await work()
    if (result && typeof result === "object" && "error" in result && result.error) return messageOf(result.error)
    return "allowed"
  } catch (error) {
    return messageOf(error)
  }
}
/** Names a refusal by the first pattern it matches; an unrecognised message is kept verbatim so the check shows it. */
function named(message, table) {
  if (message === "allowed") return "allowed"
  for (const [name, pattern] of Object.entries(table)) if (pattern.test(message)) return name
  return `UNRECOGNISED: ${message}`
}
const REFUSED = {
  "worker lease lost": /Starts worker lease lost/i,
  "package lease lost": /Start package lease lost/i,
  "package no longer releasing": /no longer releasing/i,
  "actor membership ended": /no longer an active organization member/i,
  "actor lost permission": /no longer has .*permission/i,
  "outside division": /outside (actor|your) division access/i,
  "wrong project": /Starts worker (project|budget|inspection|schedule|dependency|purchase order|budget line|generation run) mismatch|vendor mismatch/i,
  "wrong lot": /Starts worker lot mismatch/i,
  "wrong package": /Starts worker package mismatch/i,
  "worker cannot delete": /cannot delete/i,
  "browser cannot use worker headers": /Browser cannot use starts worker headers/i,
  "server action required": /authorized server action|require an authorized server/i,
  "no permission to call": /permission denied for function/i,
  "land transfer scope": /land transfer (scope|home) mismatch/i,
  "journal mismatch": /Starts (journal|job-cost|posting|inventory)/i,
  "not a PO": /non-PO commitments/i,
  "not ready": /not ready to release|already being released/i,
  "active package exists": /already has an active start package/i,
  "lot not found": /Lot not found/i,
  "home ownership mismatch": /Prepared start home .*ownership mismatch/i,
  "invalid transition": /Invalid starts lease transition/i,
  "release not durable": /requires a durably released package/i,
}

const sqlq = (kit, value) => kit.q(value)
function outboxRow(kit, id) {
  return kit.rows(`select id::text, status, retry_count, last_error, (start_claim_token is not null) has_token, start_claim_token::text token,
      round(extract(epoch from start_job_lease_expires_at - clock_timestamp()))::int lease_s, round(extract(epoch from run_at - clock_timestamp()))::int run_in_s,
      payload from public.outbox where id=${id}`)[0]
}

/** A starts job as the app enqueues one: the service role writes the outbox row, pending, with the actor in the payload. It waits an hour unless told otherwise, so no other run's pipeline picks it up before the proof claims it. */
function insertJob(kit, org, { jobType = "trade_schedule_change_notice", payload = {}, retryCount = 0, tag = "qa", runAt = HOUR } = {}) {
  const body = { project_id: randomUUID(), actor_id: org.team.starts.userId, qa: tag, ...payload }
  return Number(kit.sql(`insert into public.outbox(org_id,job_type,status,payload,retry_count,run_at,priority)
    values(${sqlq(kit, org.orgId)},${sqlq(kit, jobType)},'pending',${sqlq(kit, JSON.stringify(body))}::jsonb,${retryCount},${runAt},${JOB_PRIORITY}) returning id`).split("\n")[0])
}
const park = (kit, id) => kit.sql(`update public.outbox set run_at=${HOUR}, priority=${JOB_PRIORITY} where id=${id} and status='pending'`)
function giveBack(kit, row) {
  kit.sql(`update public.outbox set status='pending', start_claim_token=null, start_job_lease_expires_at=null, updated_at=now() where id=${row.job_id} and start_claim_token=${sqlq(kit, row.claim_token)}`)
}
/**
 * Claims the job the way the pipeline does (`claim_starts_jobs`, a global queue). The stack's queue is
 * shared with other runs, so anything else this call picks up is handed straight back, untouched.
 */
async function claimJob(kit, id) {
  const service = serviceClient()
  for (let tries = 0; tries < 10; tries += 1) {
    // first in the shared queue: one above the highest priority waiting (an earlier aborted run may have left synthetic jobs behind)
    kit.sql(`update public.outbox set run_at=clock_timestamp(), priority=(select coalesce(max(priority),0)+1 from public.outbox where status='pending') where id=${id} and status='pending'`)
    const { data, error } = await service.rpc("claim_starts_jobs", { p_limit: 1 })
    if (error) throw Error(`claim_starts_jobs: ${error.message}`)
    let mine = null
    for (const row of data ?? []) {
      if (String(row.job_id) === String(id)) mine = row
      else giveBack(kit, row)
    }
    if (mine) return { id: Number(mine.job_id), orgId: mine.org_id, token: mine.claim_token, claimed: mine }
  }
  throw Error(`Could not claim starts job ${id}: ${JSON.stringify(outboxRow(kit, id))}`)
}
async function transition(job, action, { token = job.token, orgId = job.orgId, error = null } = {}) {
  const { data, error: failure } = await serviceClient().rpc("transition_starts_job_lease", { p_org_id: orgId, p_id: job.id, p_token: token, p_action: action, p_error: error })
  return failure ? `error: ${failure.message}` : data
}
/** Synthetic jobs this proof inserted must not linger in the shared queue for other runs' pipelines to trip over. */
const retire = (kit, org) => kit.sql(`update public.outbox set status='completed', start_claim_token=null, start_job_lease_expires_at=null where org_id=${sqlq(kit, org.orgId)} and payload ? 'qa' and job_type='trade_schedule_change_notice' and status<>'completed'`)
const expireLease = (kit, id) => kit.sql(`update public.outbox set start_job_lease_expires_at=clock_timestamp() - interval '1 second' where id=${id} and status='processing'`)
async function recoverLeases() {
  const { data, error } = await serviceClient().rpc("recover_starts_job_leases", { p_limit: 500 })
  if (error) throw Error(`recover_starts_job_leases: ${error.message}`)
  return data
}

// ---------------------------------------------------------------------------
// Homes. Spec homes on the community's other developed lots (index 0 is the chain's presold home, 3 the second
// reservation): a ready package needs only the plan pinned and the gates cleared. File storage is not on the
// stack, so the plan-set copy step ('drawings') is the one thing a full release settles directly (see releaseHome).

const SLOT = { artifacts: 4, core: 5, stale: 8, creationAuth: 6, creationPositive: 7, spare: 9, raceRelease: [12, 13, 14], raceHome: [15, 16, 17] }
const MEMO = new WeakMap()
function memo(kit, key, make) {
  const map = MEMO.get(kit) ?? (MEMO.set(kit, new Map()), MEMO.get(kit))
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}
const orgOf = async (kit) => (await chain().stage(kit, "land")).org

/** Lots 12-19 start 'controlled' in the seed; the land manager develops the ones the race rounds use. */
function developRaceLots(kit) {
  return memo(kit, "develop", async () => {
    const org = await orgOf(kit)
    const ids = [...SLOT.raceRelease, ...SLOT.raceHome].map((index) => org.lots[index].id)
    // These lots are not in the first takedown; the land is bought in Books (as for the first tranche) before the land manager may develop them.
    await kit.as(org.owner, () => app("books/inventory").acquireLandInventory({ date: "2026-06-02", allocations: ids.map((lotId) => ({ lotId, amountCents: org.landCentsPerLot })),
      cashAccountId: seed.glId(kit, org, "1000"), cashCents: org.landCentsPerLot * ids.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing later lots", evidenceUrl: `${seed.EVIDENCE}/later-lots` }))
    await kit.as(org.team.land, () => app("lots").bulkUpdateLots(org.communityId, { lotIds: ids, patch: { status: "developed" } }))
  })
}
/** A spec home with a ready start package (plan pinned, every gate cleared by the people who own them). */
const readyHome = (kit, index) => memo(kit, `home-${index}`, () => makeReadyHome(kit, index))
async function makeReadyHome(kit, index) {
  const org = await orgOf(kit)
  if (index >= 10) await developRaceLots(kit)
  const lot = org.lots[index]
  seed.pinSpecPlan(kit, { lot, plan: org.plans[0] })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true })
  await seed.assignSuperintendent(kit, org, { projectId: gates.projectId })
  if (gates.ready.status !== "ready") throw Error(`Package for lot ${lot.lot_number} is ${gates.ready.status}, not ready`)
  return { org, lot, packageId: gates.packageId, projectId: gates.projectId }
}
/** Owned-inventory accounting for the home, with the revenue policy a spec home needs first (the seed's releaseHome does the same for a sold one). */
async function adoptInventory(kit, org, projectId) {
  const adopt = () => kit.as(org.owner, () => app("books/inventory").enableProjectInventory({ projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/ownership` }))
  await adopt().catch(async (error) => {
    if (!/earn revenue differently|recognizes revenue at sale/.test(error.message)) throw error
    const policies = app("books/revenue-policies")
    const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: "2026-06-01", rationale: "A spec home earns its revenue at closing." }))
    await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    await adopt()
  })
}
const queueRelease = async (kit, org, packageId, actor = org.team.starts) => {
  await kit.as(actor, () => app("starts").releaseStart(packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" }))
  const id = Number(kit.rows(`select id from public.outbox where org_id=${sqlq(kit, org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${sqlq(kit, packageId)} order by id desc limit 1`)[0].id)
  park(kit, id)
  return id
}
const packageRow = (kit, id) => kit.rows(`select status, project_id, lot_id, notes, metadata->>'release_lease_token' lease_token, metadata->>'release_lease_at' lease_at from public.start_packages where id=${sqlq(kit, id)}`)[0]
const packageLease = async (job, action, packageOrgId) => {
  const { data, error } = await serviceClient().rpc("transition_starts_package_lease", { p_org_id: packageOrgId, p_job_id: job.id, p_token: job.token, p_action: action })
  return error ? `error: ${error.message}` : data
}
/** Expires the claim, lets the reaper requeue it, claims it again (a new token) and, which also releases the dead worker's package lease. */
async function reclaim(kit, org, packageId, previous) {
  expireLease(kit, previous.id)
  await recoverLeases()
  return claimJob(kit, previous.id)
}

// ---------------------------------------------------------------------------
// EP07-05: the trade notice recovery desk

async function tradeNoticeRecoveryDesk(kit, expected, check) {
  const { org } = await chain().stage(kit, "release")
  const packageId = org.packageId
  const starts = app("starts")
  const tag = randomUUID()
  const vendors = org.vendorIds
  const notice = (vendor, status, extra = {}) => Number(kit.sql(`insert into public.outbox(org_id,job_type,status,payload,retry_count,last_error,run_at,start_claim_token,start_job_lease_expires_at)
    values(${sqlq(kit, org.orgId)},'start_release_trade_notice',${sqlq(kit, status)},${sqlq(kit, JSON.stringify({ start_package_id: extra.packageId ?? packageId, company_id: vendors[vendor], actor_id: org.team.starts.userId, qa: tag }))}::jsonb,
      ${extra.retries ?? 0},${extra.error ? sqlq(kit, extra.error) : "null"},${status === "pending" ? HOUR : "clock_timestamp()"},
      ${status === "processing" ? "gen_random_uuid()" : "null"},${status === "processing" ? HOUR : "null"}) returning id`).split("\n")[0])
  const failedA = notice("Cypress Sitework", "failed", { retries: 3, error: "Email provider unavailable" })
  const failedB = notice("Gulf Concrete", "failed", { retries: 3, error: "Vendor contact has no email" })
  const done = notice("Palmetto Framing", "completed")
  const waiting = notice("Coastal Plumbing", "pending")
  const running = notice("Bright Electric", "processing")
  const elsewhere = notice("Cypress Sitework", "failed", { retries: 3, error: "Belongs to another house", packageId: randomUUID() })
  const names = Object.fromEntries(Object.entries(vendors).map(([name, id]) => [id, name]))

  const desk = async (actor = org.team.starts) => (await kit.as(actor, () => starts.getStartPackage(packageId))).tradeNotices
  const shape = (notices) => Object.fromEntries(notices.filter((n) => n.companyId && Object.values(vendors).includes(n.companyId)).map((n) => [`${names[n.companyId]}#${n.id}`, { status: n.status, retryCount: n.retryCount, error: n.error }]))
  const before = await desk()
  const mine = [failedA, failedB, done, waiting, running]
  const dbIds = kit.rows(`select id::text from public.outbox where org_id=${sqlq(kit, org.orgId)} and job_type='start_release_trade_notice' and payload->>'start_package_id'=${sqlq(kit, packageId)} order by id`).map((r) => r.id)
  const deskView = Object.fromEntries(before.filter((n) => mine.map(String).includes(n.id)).map((n) => [names[n.companyId], { status: n.status, retryCount: n.retryCount, error: n.error }]))

  const retry = (actor, id, pkg = packageId) => attempt(() => kit.as(actor, () => starts.retryStartTradeNotice(pkg, String(id))))
  const NOTICE = {
    "refused: needs start.release": /Missing permission: start\.release/,
    "refused: only failed notices": /Only failed trade notices can be retried/,
    "refused: not found": /Trade notice not found|Start package not found/,
    "refused: outside division": /outside your division access/,
  }
  const rowsOf = (...ids) => kit.rows(`select id::text, status, retry_count, last_error, payload->>'actor_id' actor from public.outbox where id in (${ids.join(",")}) order by id`)

  // Ineligible states, wrong scope and wrong role: all refused, nothing changes.
  const foreign = await memo(kit, "foreign-org", () => seed.productionBuilder(kit, { name: "LOT-01 starts foreign coordinator", periods: ["2026-06"] }))
  const scoped = kit.addMember(org, "org_starts_coordinator")
  kit.sql(`update public.memberships set division_scope='assigned' where org_id=${sqlq(kit, org.orgId)} and user_id=${sqlq(kit, scoped.userId)}`)
  const refusals = {
    completed: named(await retry(org.team.starts, done), NOTICE),
    pending: named(await retry(org.team.starts, waiting), NOTICE),
    processing: named(await retry(org.team.starts, running), NOTICE),
    unknownNotice: named(await retry(org.team.starts, 999999999), NOTICE),
    noticeOfAnotherHouse: named(await retry(org.team.starts, elsewhere), NOTICE),
    superintendent: named(await retry(org.team.superintendent, failedA), NOTICE),
    purchasingManager: named(await retry(org.team.purchasing, failedA), NOTICE),
    salesConsultant: named(await retry(org.team.sales, failedA), NOTICE),
    coordinatorOfAnotherBuilder: named(await retry(foreign.team.starts, failedA), NOTICE),
    coordinatorWithoutDivisionReach: named(await retry(scoped, failedA), NOTICE),
  }
  const untouched = rowsOf(failedA, failedB, done, waiting, running, elsewhere)
  const stillSame = untouched.map((r) => `${r.id}:${r.status}:${r.retry_count}`).join(",") ===
    [[failedA, "failed", 3], [failedB, "failed", 3], [done, "completed", 0], [waiting, "pending", 0], [running, "processing", 0], [elsewhere, "failed", 3]].map(([id, status, n]) => `${id}:${status}:${n}`).join(",")

  // Two coordinators retry the same failed notice at once: one requeue.
  const contested = await Promise.allSettled([
    kit.as(org.team.starts, () => starts.retryStartTradeNotice(packageId, String(failedA))),
    kit.as(org.owner, () => starts.retryStartTradeNotice(packageId, String(failedA))),
  ])
  const afterContest = rowsOf(failedA)[0]
  await kit.as(org.team.starts, () => starts.retryStartTradeNotice(packageId, String(failedB)))
  const afterOwn = rowsOf(failedB)[0]
  const auditFor = (id) => Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${sqlq(kit, org.orgId)} and entity_type='start_trade_notice' and after_data->>'start_package_id'=${sqlq(kit, packageId)} and before_data->>'id'=${sqlq(kit, String(id))}`)[0].n)
  const events = (id) => Number(kit.rows(`select count(*)::int n from public.events where org_id=${sqlq(kit, org.orgId)} and event_type='start.trade_notice_retried' and entity_id=${sqlq(kit, packageId)} and payload->>'notice_id'=${sqlq(kit, String(id))}`)[0].n)

  // The worker then runs them (the cron route's pipeline) and the desk shows what actually happened.
  kit.sql(`update public.outbox set run_at=clock_timestamp(), priority=${JOB_PRIORITY} where id in (${failedA},${failedB})`)
  await kit.service(() => app("starts-pipeline").runStartsPipeline())
  const finalRows = rowsOf(failedA, failedB)
  const finalDesk = (await desk()).filter((n) => [failedA, failedB].map(String).includes(n.id))
  const truthful = finalRows.every((row) => (row.status === "completed" && row.last_error === null) || (["pending", "failed"].includes(row.status) && Number(row.retry_count) >= 1 && !!row.last_error))
  const deskAgrees = finalDesk.every((n) => finalRows.find((r) => r.id === n.id)?.status === n.status)

  eq(check, "the desk lists every trade notice of the house with its real state, retry count and error", expected.expected.desk, {
    listsEveryNoticeOfTheHouse: mine.every((id) => dbIds.includes(String(id))) && dbIds.every((id) => before.some((n) => n.id === id)),
    notIncludingAnotherHousesNotice: !before.some((n) => n.id === String(elsewhere)),
    notices: deskView,
  })
  eq(check, "only failed notices are requeued: the coordinator's retry resets them to pending with the retry count cleared and the requeuing coordinator as actor", expected.expected.requeue, {
    failedNoticeAfterContestedRetry: { status: afterContest.status, retryCount: Number(afterContest.retry_count), error: afterContest.last_error, actorIsACoordinatorWhoAsked: [org.team.starts.userId, org.owner.userId].includes(afterContest.actor) },
    otherFailedNotice: { status: afterOwn.status, retryCount: Number(afterOwn.retry_count), error: afterOwn.last_error, actor: afterOwn.actor === org.team.starts.userId ? "the requeuing coordinator" : afterOwn.actor },
    contestedRetryWinners: contested.filter((r) => r.status === "fulfilled").length,
    contestedRetryLoserRefusedAsStale: contested.filter((r) => r.status === "rejected").every((r) => /Notice state changed|Only failed trade notices/.test(r.reason.message)),
  })
  eq(check, "the requeue is evented and audited exactly once (the audit row is the record of who asked)", expected.expected.trail, { audit: auditFor(failedA), event: events(failedA) })
  eq(check, "completed, pending, processing, unknown and another house's notices are refused; wrong role and wrong scope are refused; nothing changes", expected.expected.refusals, { ...refusals, noRowChanged: stillSame })
  eq(check, "after the worker runs the requeued notices, the notice shows its truthful result (completed, or retried with its error), and the desk agrees with the queue", expected.expected.afterWorker, { truthful, deskAgrees })
  return { orgId: org.orgId, packageId, notices: { failedA, failedB, done, waiting, running, elsewhere } }
}

// ---------------------------------------------------------------------------
// EP07-10: the tokenized claim protocol

async function claimTokensEnforceTheCurrentLease(kit, expected, check) {
  const org = await orgOf(kit)
  const claimRow = (job) => outboxRow(kit, job.id)
  const id = insertJob(kit, org, { tag: "claim-lifecycle" })
  const queued = outboxRow(kit, id)
  const first = await claimJob(kit, id)
  const claimed = claimRow(first)

  // heartbeat: wrong token, wrong org, unknown action refused; the current token renews
  kit.sql(`update public.outbox set start_job_lease_expires_at=clock_timestamp() + interval '10 seconds' where id=${id}`)
  const wrongToken = await transition(first, "heartbeat", { token: randomUUID() })
  const wrongOrg = await transition(first, "heartbeat", { orgId: randomUUID() })
  const leaseAfterRefused = claimRow(first).lease_s
  const unknownAction = named(await transition(first, "release"), REFUSED)
  const renewed = await transition(first, "heartbeat")
  const leaseAfterRenew = claimRow(first).lease_s

  // defer: back to the queue, token gone, retry count untouched, one minute out
  const deferred = await transition(first, "defer")
  const afterDefer = claimRow(first)
  const staleAfterDefer = { heartbeat: await transition(first, "heartbeat"), complete: await transition(first, "complete"), retry: await transition(first, "retry", { error: "late" }) }

  // re-claim: a new token; the previous holder is now stale for every transition
  const second = await claimJob(kit, id)
  const staleAfterReclaim = {}
  for (const action of ["heartbeat", "defer", "complete", "retry"]) staleAfterReclaim[action] = await transition(first, action, { error: "stale worker" })
  const afterStale = claimRow(second)

  // retry: counted, backed off, error kept, token released
  const retried = await transition(second, "retry", { error: "Email provider unavailable" })
  const afterRetry = claimRow(second)
  park(kit, id)

  // an expired lease cannot be used; the reaper requeues it and counts the attempt
  const third = await claimJob(kit, id)
  expireLease(kit, id)
  const expiredHeartbeat = await transition(third, "heartbeat")
  const expiredComplete = await transition(third, "complete")
  const leaseStillExpired = claimRow(third).lease_s <= 0
  await recoverLeases()
  const afterReap = claimRow(third)
  park(kit, id)
  const lateAfterReap = await transition(third, "complete")

  // a claim that is still within its lease is not touched by the reaper
  const fourth = await claimJob(kit, id)
  await recoverLeases()
  const liveAfterReap = claimRow(fourth)
  // the third expiry parks the job as failed rather than retrying forever
  expireLease(kit, id)
  await recoverLeases()
  const afterThirdExpiry = claimRow(fourth)

  // complete: the current token finishes the job once
  const doneId = insertJob(kit, org, { tag: "claim-complete" })
  const doneJob = await claimJob(kit, doneId)
  const completed = await transition(doneJob, "complete")
  const afterComplete = outboxRow(kit, doneId)
  const secondComplete = await transition(doneJob, "complete")
  const retryAfterComplete = await transition(doneJob, "retry", { error: "x" })

  // the last permitted retry fails the job
  const lastId = insertJob(kit, org, { tag: "claim-last-retry", retryCount: 2 })
  const lastJob = await claimJob(kit, lastId)
  const lastRetry = await transition(lastJob, "retry", { error: "Third failure" })
  const afterLast = outboxRow(kit, lastId)

  // a release job cannot be completed until its package durably released (token alone is not enough)
  const homeless = await readyHome(kit, SLOT.spare)
  const releaseJobId = await queueRelease(kit, org, homeless.packageId)
  const releaseJob = await claimJob(kit, releaseJobId)
  const completeUnreleased = named(await transition(releaseJob, "complete"), REFUSED)
  await kit.as(org.team.starts, () => app("starts").cancelRelease(homeless.packageId))

  const ids = [id, doneId, lastId]
  const duplicates = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${sqlq(kit, org.orgId)} and payload->>'qa' in ('claim-lifecycle','claim-complete','claim-last-retry')`)[0].n)

  eq(check, "claim hands out one unexpired token and a three minute lease", expected.expected.claim, {
    queuedAs: { status: queued.status, retryCount: queued.retry_count, tokenless: !queued.has_token },
    claimed: { status: claimed.status, tokenReturnedMatchesRow: claimed.token === first.token, leaseAboutThreeMinutes: claimed.lease_s > 160 && claimed.lease_s <= 180 },
  })
  eq(check, "heartbeat: only the current token on the right organisation renews the lease; anything else is refused and changes nothing", expected.expected.heartbeat, {
    wrongToken, wrongOrganisation: wrongOrg, unknownAction, leaseUntouchedByRefusals: leaseAfterRefused <= 10,
    currentToken: renewed, leaseRenewedToAboutThreeMinutes: leaseAfterRenew > 160 && leaseAfterRenew <= 180,
  })
  eq(check, "defer returns the job to the queue a minute out with the token gone and the retry count unchanged", expected.expected.defer, {
    result: deferred, status: afterDefer.status, retryCount: afterDefer.retry_count, tokenGone: !afterDefer.has_token, runsAboutAMinuteLater: afterDefer.run_in_s > 40 && afterDefer.run_in_s <= 60,
  })
  eq(check, "a worker whose claim was deferred or re-claimed is stale for heartbeat, defer, complete and retry; the new holder's claim is untouched", expected.expected.staleToken, {
    afterDefer: staleAfterDefer,
    newTokenDiffers: second.token !== first.token,
    afterReclaim: staleAfterReclaim,
    newHolderStillProcessing: afterStale.status === "processing" && afterStale.token === second.token && afterStale.retry_count === 0,
  })
  eq(check, "retry records the error, counts the attempt, backs the job off and releases the token", expected.expected.retry, {
    result: retried, status: afterRetry.status, retryCount: afterRetry.retry_count, error: afterRetry.last_error, tokenGone: !afterRetry.has_token, backedOffTwoMinutes: afterRetry.run_in_s > 100 && afterRetry.run_in_s <= 120,
  })
  eq(check, "an expired lease cannot heartbeat or complete; recovery requeues it, counts the attempt, leaves an explicit reason; the old token stays dead", expected.expected.expiredLease, {
    heartbeat: expiredHeartbeat, complete: expiredComplete, leaseWasExpired: leaseStillExpired,
    requeued: { status: afterReap.status, retryCount: afterReap.retry_count, error: afterReap.last_error, tokenGone: !afterReap.has_token },
    lateCompleteAfterRecovery: lateAfterReap,
  })
  eq(check, "recovery leaves a live claim alone and fails a job whose lease has expired for the third time", expected.expected.recovery, {
    liveClaim: { status: liveAfterReap.status, sameToken: liveAfterReap.token === fourth.token, retryCount: liveAfterReap.retry_count },
    thirdExpiry: { status: afterThirdExpiry.status, retryCount: afterThirdExpiry.retry_count, tokenGone: !afterThirdExpiry.has_token },
  })
  eq(check, "complete finishes the job once for its current token; a repeat or a retry after completion is refused; a third failed retry fails the job", expected.expected.complete, {
    result: completed, status: afterComplete.status, error: afterComplete.last_error, tokenGone: !afterComplete.has_token,
    repeatedComplete: secondComplete, retryAfterComplete,
    lastRetry: { result: lastRetry, status: afterLast.status, retryCount: afterLast.retry_count },
    rowsCreated: duplicates, jobs: ids.length,
  })
  eq(check, "a release job cannot be completed while its package is not durably released, whatever the token", expected.expected.releaseJobComplete, { completeUnreleased })
  retire(kit, org)
  return { orgId: org.orgId, jobs: ids }
}

// ---------------------------------------------------------------------------
// EP07-10 #1: browser clients cannot forge actor or ownership

async function browserClientsCannotForgeOwnership(kit, expected, check) {
  const { org } = await chain().stage(kit, "release")
  const { packageId, projectId } = org
  const forgedCount = () => Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${sqlq(kit, org.orgId)} and payload->>'actor_id'=${sqlq(kit, org.owner.userId)} and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')`)[0].n)
  const forgedBefore = forgedCount()
  const jobId = insertJob(kit, org, { tag: "browser-forge" })
  const live = await claimJob(kit, jobId)
  const before = outboxRow(kit, jobId)
  const pkgBefore = packageRow(kit, packageId)
  const { createClient } = require("@supabase/supabase-js")
  const browser = (actor, headers = {}) => createClient(kit.apiUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${kit.localJwt({ sub: actor.userId, role: "authenticated", aud: "authenticated" })}`, ...headers } },
  })
  const owner = browser(org.owner)
  const coordinator = browser(org.team.starts)
  const forged = browser(org.team.starts, { "x-starts-job-id": String(live.id), "x-starts-claim-token": live.token })
  const refusal = (message) => named(message, REFUSED)
  // a refusal is an error or (when row-level security hides the row) nothing changed; both leave the DB as it was
  const changed = async (work) => { const result = await attempt(work); return result }

  const insertRelease = await changed(() => owner.from("outbox").insert({ org_id: org.orgId, job_type: "start_release", payload: { start_package_id: packageId, actor_id: org.owner.userId } }))
  const insertNotice = await changed(() => coordinator.from("outbox").insert({ org_id: org.orgId, job_type: "trade_schedule_change_notice", payload: { project_id: projectId, actor_id: org.team.starts.userId } }))
  const insertTokened = await changed(() => owner.from("outbox").insert({ org_id: org.orgId, job_type: "reindex_search", payload: {}, start_claim_token: randomUUID() }))
  const updateJob = await attempt(async () => { const r = await owner.from("outbox").update({ status: "pending", start_claim_token: null, payload: { actor_id: org.owner.userId } }).eq("id", jobId).select("id"); return r.error ? r : r.data?.length ? "updated" : { error: { message: "no row visible" } } })
  const deleteJob = await attempt(async () => { const r = await owner.from("outbox").delete().eq("id", jobId).select("id"); return r.error ? r : r.data?.length ? "deleted" : { error: { message: "no row visible" } } })
  const updatePackage = await attempt(async () => { const r = await owner.from("start_packages").update({ status: "ready", notes: "forged" }).eq("id", packageId).select("id"); return r.error ? r : r.data?.length ? "updated" : { error: { message: "no row visible" } } })
  const writeStep = await attempt(async () => { const r = await owner.from("start_release_steps").update({ status: "completed" }).eq("start_package_id", packageId).select("id"); return r.error ? r : r.data?.length ? "updated" : { error: { message: "no row visible" } } })
  const forgedHeaderWrite = await attempt(() => forged.from("schedule_items").insert({ org_id: org.orgId, project_id: projectId, name: "Forged by a browser claiming a worker" }))
  const forgedHeaderPackage = await attempt(async () => { const r = await forged.from("start_packages").update({ notes: "forged" }).eq("id", packageId).select("id"); return r.error ? r : { error: { message: "no row visible" } } })
  const rpc = {}
  for (const [name, args] of Object.entries({
    claim_starts_jobs: { p_limit: 1 },
    transition_starts_job_lease: { p_org_id: org.orgId, p_id: jobId, p_token: live.token, p_action: "complete", p_error: null },
    recover_starts_job_leases: { p_limit: 5 },
    queue_start_release: { p_org_id: org.orgId, p_package_id: packageId, p_actor_id: org.owner.userId, p_scheduled_start_date: seed.isoDay(0), p_target_week: seed.isoDay(0), p_slot_target: 99, p_confirm_over_slot: true },
    publish_start_release: { p_org_id: org.orgId, p_job_id: jobId, p_token: live.token, p_event_id: randomUUID() },
    transition_starts_package_lease: { p_org_id: org.orgId, p_job_id: jobId, p_token: live.token, p_action: "acquire" },
  })) rpc[name] = refusal(await attempt(() => owner.rpc(name, args)))

  // the actor of a release is the signed-in coordinator: the job the service queues carries it
  const homeless = await readyHome(kit, SLOT.spare)
  const released = await queueRelease(kit, org, homeless.packageId, org.team.starts)
  const queuedBy = kit.rows(`select payload->>'actor_id' actor from public.outbox where id=${released}`)[0].actor
  const releasedBy = kit.rows(`select released_by::text from public.start_packages where id=${sqlq(kit, homeless.packageId)}`)[0].released_by
  await kit.as(org.team.starts, () => app("starts").cancelRelease(homeless.packageId))

  const after = outboxRow(kit, jobId)
  const pkgAfter = packageRow(kit, packageId)
  const forgedRows = forgedCount() - forgedBefore
  const forgedSchedule = Number(kit.rows(`select count(*)::int n from public.schedule_items where project_id=${sqlq(kit, projectId)} and name like 'Forged%'`)[0].n)
  await transition(live, "complete")

  const BROWSER = { refused: /authorized server action|require an authorized server|Browser cannot use starts worker headers|no row visible|row-level security|permission denied/i }
  const label = (message) => named(message, BROWSER)
  eq(check, "a browser cannot enqueue, rewrite or delete starts jobs, nor set a claim token, and cannot reach the job RPCs", expected.expected.jobs, {
    insertReleaseJob: label(insertRelease), insertNoticeJob: label(insertNotice), insertAnyJobWithAClaimToken: label(insertTokened),
    rewriteClaimedJob: label(updateJob), deleteClaimedJob: label(deleteJob),
    jobUnchanged: before.status === after.status && before.token === after.token && JSON.stringify(before.payload) === JSON.stringify(after.payload),
    forgedJobsInTheQueue: forgedRows,
    rpc,
  })
  eq(check, "a browser cannot write the package or its step ledger, and cannot pose as a worker with a live job's headers", expected.expected.records, {
    updatePackage: label(updatePackage), updateReleaseStep: label(writeStep),
    postureWithWorkerHeaders: { scheduleWrite: label(forgedHeaderWrite), packageWrite: label(forgedHeaderPackage) },
    packageUnchanged: pkgBefore.status === pkgAfter.status && pkgBefore.notes === pkgAfter.notes,
    forgedScheduleRows: forgedSchedule,
  })
  eq(check, "the actor of a release is the signed-in coordinator who queued it, never a value the caller supplies", expected.expected.actor, {
    jobActorIsCoordinator: queuedBy === org.team.starts.userId, packageReleasedByIsCoordinator: releasedBy === org.team.starts.userId,
  })
  retire(kit, org)
  return { orgId: org.orgId, jobId }
}

// ---------------------------------------------------------------------------
// EP07-10 multi_session: two sessions claiming one job; stale token against re-claim

const serviceSession = (body) => `set role service_role;\n${body}`
const claimScript = (jobId) => serviceSession(`select pg_sleep(greatest(0, extract(epoch from (select run_at - clock_timestamp() from public.outbox where id=${jobId}))));
create temp table got on commit preserve rows as select * from public.claim_starts_jobs(1);
update public.outbox set status='pending',start_claim_token=null,start_job_lease_expires_at=null,updated_at=now() where id in (select job_id from got where job_id<>${jobId}) and start_claim_token in (select claim_token from got);
select coalesce((select claim_token::text from got where job_id=${jobId}),'none');`)
const transitionScript = (kit, job, token, action) => serviceSession(`select public.transition_starts_job_lease(${sqlq(kit, job.orgId)},${job.id},${sqlq(kit, token)},${sqlq(kit, action)},'raced');`)
const answer = (result) => (result.ok ? result.stdout.split("\n").pop() : `error: ${result.stderr.split("\n").pop()}`)

async function raceClaimSameJob(kit, expected, check) {
  const org = await orgOf(kit)
  const rounds = []
  for (let round = 1; round <= 3; round += 1) {
    // two sessions claim the same job
    // due two seconds from now: each session waits for that instant, so both claim at the same moment
    const id = insertJob(kit, org, { tag: `race-claim-${round}`, runAt: "clock_timestamp() + interval '2 seconds'" })
    const claims = (await race(kit, [claimScript(id), claimScript(id)])).map(answer)
    const winners = claims.filter((token) => token !== "none" && !token.startsWith("error"))
    const row = outboxRow(kit, id)
    const claim = { winners: winners.length, errors: claims.filter((c) => c.startsWith("error")).length, dbTokenIsTheWinners: winners.length === 1 && row.token === winners[0], status: row.status }
    const job = { id, orgId: org.orgId, token: winners[0] }

    // two sessions use the same token: complete against retry, one outcome
    const idB = insertJob(kit, org, { tag: `race-same-token-${round}` })
    const jobB = await claimJob(kit, idB)
    const [first, second] = (await race(kit, [transitionScript(kit, jobB, jobB.token, "complete"), transitionScript(kit, jobB, jobB.token, "retry")])).map(answer)
    const rowB = outboxRow(kit, idB)
    const consistent = (first === "t" && second === "f" && rowB.status === "completed" && rowB.retry_count === 0) || (first === "f" && second === "t" && rowB.status === "pending" && rowB.retry_count === 1)
    const sameToken = { winners: [first, second].filter((x) => x === "t").length, consistentWithTheWinner: consistent || `no: complete=${first} retry=${second} row=${rowB.status}/${rowB.retry_count}/${rowB.last_error}` }

    // a stale worker against the live one after a re-claim
    const idC = insertJob(kit, org, { tag: `race-stale-${round}` })
    const stale = await claimJob(kit, idC)
    expireLease(kit, idC)
    await recoverLeases()
    const live = await claimJob(kit, idC)
    const [staleAnswer, liveAnswer] = (await race(kit, [transitionScript(kit, stale, stale.token, "complete"), transitionScript(kit, live, live.token, "complete")])).map(answer)
    const rowC = outboxRow(kit, idC)
    // another run's pipeline on the shared queue may also have picked the requeued job up in between, so the count is 'at least the reaper's one'
    const reclaim = { stale: staleAnswer, live: liveAnswer, status: rowC.status, reaperCountedTheLostClaim: rowC.retry_count >= 1 }

    // nothing was duplicated
    const rows = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${sqlq(kit, org.orgId)} and payload->>'qa' like ${sqlq(kit, `race-%-${round}`)}`)[0].n)
    // the loser of the first claim was left with nothing of ours; finish the winner so no claim is left behind
    if (job.token) await transition(job, "complete")
    rounds.push({ claim, sameToken, reclaim, rows })
  }
  eq(check, "three rounds: two sessions claim one job (one winner, one token), two sessions with one token (one outcome), a stale token against the re-claimed one (only the live token wins); no duplicate rows", expected.expected.rounds, rounds)
  retire(kit, org)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP07-11: core release ownership

async function coreReleaseWritesValidateCurrentOwnership(kit, expected, check) {
  const home = await readyHome(kit, SLOT.core)
  const { org, lot, packageId, projectId } = home
  const other = await chain().stage(kit, "release")
  const releaser = kit.addMember(org, "org_starts_coordinator")
  const starts = app("starts")
  const jobId = await queueRelease(kit, org, packageId, releaser)
  const job1 = await claimJob(kit, jobId)
  const leaseHeld = await packageLease(job1, "acquire", org.orgId)
  const w1 = workerClient(job1)
  const lotBefore = kit.rows(`select swing, address from public.lots where id=${sqlq(kit, lot.id)}`)[0]
  const stepOf = (pkg) => kit.rows(`select id::text from public.start_release_steps where start_package_id=${sqlq(kit, pkg)} order by step_key limit 1`)[0].id
  const gateOf = (pkg) => kit.rows(`select id::text from public.start_package_gates where start_package_id=${sqlq(kit, pkg)} order by created_at limit 1`)[0].id
  const rowGuard = async (work) => { const r = await work(); return r.error ? r : r.data?.length === 1 ? "allowed" : { error: { message: "no row changed" } } }
  const writes = (client, tag) => ({
    package: () => attempt(() => rowGuard(() => client.from("start_packages").update({ notes: tag }).eq("org_id", org.orgId).eq("id", packageId).select("id"))),
    home: () => attempt(() => rowGuard(() => client.from("projects").update({ description: tag }).eq("org_id", org.orgId).eq("id", projectId).select("id"))),
    lot: () => attempt(() => rowGuard(() => client.from("lots").update({ notes: tag }).eq("org_id", org.orgId).eq("id", lot.id).select("id"))),
    step: () => attempt(() => rowGuard(() => client.from("start_release_steps").update({ detail: { qa: tag } }).eq("org_id", org.orgId).eq("id", stepOf(packageId)).select("id"))),
    gate: () => attempt(() => rowGuard(() => client.from("start_package_gates").update({ notes: tag }).eq("org_id", org.orgId).eq("id", gateOf(packageId)).select("id"))),
  })
  const run = async (client, tag) => { const w = writes(client, tag); const out = {}; for (const key of Object.keys(w)) out[key] = named(await w[key](), REFUSED); return out }

  // the live owner may write its own package, home, lot, step and gate
  const owner1 = await run(w1, "first owner")
  const homeNow = () => kit.rows(`select description from public.projects where id=${sqlq(kit, projectId)}`)[0].description
  const landed = homeNow() === "first owner" && packageRow(kit, packageId).notes === "first owner"
  // ... and nothing that belongs to another house or lot
  const foreign = {
    home: named(await attempt(() => rowGuard(() => w1.from("projects").update({ description: "intruder" }).eq("org_id", org.orgId).eq("id", other.org.projectId).select("id"))), REFUSED),
    lot: named(await attempt(() => rowGuard(() => w1.from("lots").update({ notes: "intruder" }).eq("org_id", org.orgId).eq("id", other.org.lots[0].id).select("id"))), REFUSED),
    package: named(await attempt(() => rowGuard(() => w1.from("start_packages").update({ notes: "intruder" }).eq("org_id", org.orgId).eq("id", other.org.packageId).select("id"))), REFUSED),
    step: named(await attempt(() => rowGuard(() => w1.from("start_release_steps").update({ detail: { qa: "intruder" } }).eq("org_id", org.orgId).eq("id", stepOf(other.org.packageId)).select("id"))), REFUSED),
    gate: named(await attempt(() => rowGuard(() => w1.from("start_package_gates").update({ notes: "intruder" }).eq("org_id", org.orgId).eq("id", gateOf(other.org.packageId)).select("id"))), REFUSED),
    deletePackage: named(await attempt(() => w1.from("start_packages").delete().eq("org_id", org.orgId).eq("id", packageId)), REFUSED),
    deleteLot: named(await attempt(() => w1.from("lots").delete().eq("org_id", org.orgId).eq("id", lot.id)), REFUSED),
  }
  const untouched = kit.rows(`select (select count(*)::int from public.projects where description='intruder') homes, (select count(*)::int from public.lots where notes='intruder') lots,
    (select count(*)::int from public.start_packages where notes='intruder') packages`)[0]
  // ancestry cannot be rewritten by the owner either
  const moveLot = named(await attempt(() => rowGuard(() => w1.from("lots").update({ project_id: other.org.projectId }).eq("org_id", org.orgId).eq("id", lot.id).select("id"))), { "ancestry immutable": /ancestry and plan are immutable/ })
  const movePackage = named(await attempt(() => rowGuard(() => w1.from("start_packages").update({ project_id: other.org.projectId }).eq("org_id", org.orgId).eq("id", packageId).select("id"))), { "ancestry immutable": /ancestry is immutable/ })

  // the reaper reclaims the job: a new worker holds a new token, and until the previous lease is stale the new one cannot take the package
  expireLease(kit, jobId)
  await recoverLeases()
  const job2 = await claimJob(kit, jobId)
  const w2 = workerClient(job2)
  const staleBeforeAcquire = await run(w1, "stale before takeover")
  const newBeforeAcquire = { package: named(await writes(w2, "too early").package(), REFUSED), home: named(await writes(w2, "too early").home(), REFUSED), lot: named(await writes(w2, "too early").lot(), REFUSED) }
  const releasedByRecovery = packageRow(kit, packageId).lease_token === null
  const acquired = await packageLease(job2, "acquire", org.orgId)
  const staleAfterTakeover = await run(w1, "stale after takeover")
  const newOwner = await run(w2, "second owner")
  const finalHome = homeNow()
  const lotAfter = kit.rows(`select swing, address, notes from public.lots where id=${sqlq(kit, lot.id)}`)[0]

  // the actor who queued the release must still be allowed to: end the membership and the live owner is refused
  kit.sql(`update public.memberships set status='suspended' where org_id=${sqlq(kit, org.orgId)} and user_id=${sqlq(kit, releaser.userId)}`)
  const actorGone = await run(w2, "after the coordinator left")
  kit.sql(`update public.memberships set status='active' where org_id=${sqlq(kit, org.orgId)} and user_id=${sqlq(kit, releaser.userId)}`)
  kit.sql(`insert into public.membership_permission_overrides(membership_id,permission_key,effect) select id,'start.release','deny' from public.memberships where org_id=${sqlq(kit, org.orgId)} and user_id=${sqlq(kit, releaser.userId)}`)
  const actorDenied = await run(w2, "after the permission was denied")
  kit.sql(`delete from public.membership_permission_overrides where membership_id in (select id from public.memberships where org_id=${sqlq(kit, org.orgId)} and user_id=${sqlq(kit, releaser.userId)})`)
  const actorBack = await run(w2, "permission restored")

  // publication and completion by a stale token are refused
  const stalePublish = named(await attempt(() => serviceClient().rpc("publish_start_release", { p_org_id: org.orgId, p_job_id: job1.id, p_token: job1.token, p_event_id: randomUUID() })), REFUSED)
  // cancelling the release preempts the live worker in the same transaction
  const cancelled = await kit.as(releaser, () => starts.cancelRelease(packageId))
  const afterCancel = await run(w2, "after cancel")
  const jobAfterCancel = outboxRow(kit, jobId)
  const pkgAfterCancel = packageRow(kit, packageId)
  await kit.as(org.team.starts, () => starts.getStartPackage(packageId))

  const allOwned = (m) => Object.values(m).every((v) => v === "allowed")
  const allRefused = (m, label) => Object.values(m).every((v) => v === label)
  eq(check, "the live owner writes its own package, home, lot, step and gate; nothing of another house or lot; deletes and ancestry rewrites are refused", expected.expected.liveOwner, {
    leaseTaken: leaseHeld, ownWrites: allOwned(owner1), ownWritesLanded: landed,
    anotherHouse: foreign,
    nothingLandedOnOthers: untouched,
    rewriteLotHome: moveLot, rewritePackageHome: movePackage,
    lotUntouchedOtherwise: lotBefore.swing === lotAfter.swing && lotBefore.address === lotAfter.address,
  })
  eq(check, "after the job is re-claimed the previous worker is refused on package, home, lot, step and gate while the new token is refused until it holds the package lease, then writes", expected.expected.reclaim, {
    previousWorkerRefusedBeforeTakeover: allRefused(staleBeforeAcquire, "worker lease lost"),
    newWorkerRefusedUntilItHoldsThePackage: allRefused(newBeforeAcquire, "package lease lost"),
    deadWorkersPackageLeaseReleasedByRecovery: releasedByRecovery, newWorkerTakesThePackage: acquired,
    previousWorkerRefusedAfterTakeover: allRefused(staleAfterTakeover, "worker lease lost"),
    newWorkerWrites: allOwned(newOwner), homeHoldsTheNewOwnersWrite: finalHome === "second owner",
    publishWithTheStaleToken: stalePublish,
  })
  eq(check, "the live worker's authority follows the coordinator who queued the release: refused after the membership ends or start.release is denied, allowed again when restored", expected.expected.actorAuthority, {
    membershipEnded: allRefused(actorGone, "actor membership ended"),
    permissionDenied: allRefused(actorDenied, "actor lost permission"),
    restored: allOwned(actorBack),
  })
  eq(check, "cancelling the release revokes the claim in the same transaction: the package returns to ready and the preempted worker is refused", expected.expected.cancel, {
    cancelPreservedAndReset: { preserved: cancelled.preserved.length >= 1, reset: cancelled.reset.length >= 1 },
    package: pkgAfterCancel.status, leaseCleared: pkgAfterCancel.lease_token === null,
    job: { status: jobAfterCancel.status, error: jobAfterCancel.last_error, tokenGone: !jobAfterCancel.has_token },
    preemptedWorker: allRefused(afterCancel, "worker lease lost"),
  })
  return { orgId: org.orgId, packageId, jobId }
}

// ---------------------------------------------------------------------------
// EP07-11 #1: new home creation is authorized and atomic

async function newHomeCreationIsAuthorizedAndAtomic(kit, expected, check) {
  const org = await orgOf(kit)
  const starts = app("starts")
  const lot = org.lots[SLOT.creationAuth]
  const positive = org.lots[SLOT.creationPositive]
  const q = (v) => sqlq(kit, v)
  const asService = (statement, { headers = null } = {}) => `set role service_role;${headers ? `select set_config('request.headers',${q(JSON.stringify(headers))},false);` : ""}${statement}`
  const sqlAttempt = (text) => { try { kit.sql(text); return "allowed" } catch (error) { return error.message } }
  const call = (actorId, lotId, home = null, orgId = org.orgId) => `select public.open_start_package(${q(orgId)},${q(actorId)},${q(lotId)},false,null,${home ? `${q(JSON.stringify(home))}::jsonb` : "null"})`
  const homeBundle = (projectId, overrides = {}) => ({
    projectId,
    project: { org_id: org.orgId, created_by: org.team.starts.userId, property_type: "production", phase: "precon", name: `QA home ${projectId.slice(0, 8)}`, status: "active", ...(overrides.project ?? {}) },
    billingContract: null,
    financialSettings: { org_id: org.orgId, project_id: projectId, created_by: org.team.starts.userId, billing_model: "fixed_price", ...(overrides.financialSettings ?? {}) },
    accountingDimensions: {},
  })
  const state = (lotId) => kit.rows(`select l.project_id::text, l.status, (select count(*)::int from public.start_packages p where p.lot_id=l.id and p.status<>'cancelled') packages from public.lots l where l.id=${q(lotId)}`)[0]
  const projectsNamed = (prefix) => Number(kit.rows(`select count(*)::int n from public.projects where org_id=${q(org.orgId)} and name like ${q(`${prefix}%`)}`)[0].n)
  const scoped = kit.addMember(org, "org_starts_coordinator")
  kit.sql(`update public.memberships set division_scope='assigned' where org_id=${q(org.orgId)} and user_id=${q(scoped.userId)}`)
  const noManage = kit.addMember(org, "org_starts_coordinator")
  kit.sql(`insert into public.membership_permission_overrides(membership_id,permission_key,effect) select id,'project.manage','deny' from public.memberships where org_id=${q(org.orgId)} and user_id=${q(noManage.userId)}`)
  const browserJwt = kit.localJwt({ sub: org.owner.userId, role: "authenticated", aud: "authenticated" })
  const claims = JSON.stringify({ sub: org.owner.userId, role: "authenticated", aud: "authenticated" })

  const before = state(lot.id)
  const CREATE = { "refused: needs start.write": /no longer has start\.write permission/, "refused: needs project.manage to create a home": /no longer has project\.manage permission/, "refused: outside division": /outside actor division access/,
    "refused: worker claim": /cannot be created inside a worker claim/, "refused: browser role": /permission denied for function|authorized server action/, "refused: lot not in this organisation": /Lot not found/,
    "refused: prepared home belongs to someone else": /Prepared start home .*ownership mismatch/, "refused: lot already has an active package": /already has an active start package/ }
  const refusals = {
    actorWithoutStartWrite: named(sqlAttempt(asService(call(org.team.superintendent.userId, lot.id))), CREATE),
    actorWithoutProjectManage: named(sqlAttempt(asService(call(noManage.userId, lot.id, homeBundle(randomUUID())))), CREATE),
    actorWithoutDivisionReach: named(sqlAttempt(asService(call(scoped.userId, lot.id, homeBundle(randomUUID())))), CREATE),
    insideAWorkerClaim: named(sqlAttempt(asService(call(org.team.starts.userId, lot.id, homeBundle(randomUUID())), { headers: { "x-starts-job-id": "1", "x-starts-claim-token": randomUUID() } })), CREATE),
    aBrowserSession: named(sqlAttempt(`set role authenticated;select set_config('request.jwt.claims',${q(claims)},false);${call(org.owner.userId, lot.id, homeBundle(randomUUID()))}`), CREATE),
    aLotOfAnotherOrganisation: named(sqlAttempt(asService(call(org.team.starts.userId, lot.id, homeBundle(randomUUID()), randomUUID()))), CREATE),
    homePreparedForAnotherActor: named(sqlAttempt(asService(call(org.team.starts.userId, lot.id, homeBundle(randomUUID(), { project: { created_by: org.owner.userId } })))), CREATE),
    homePreparedForAnotherOrganisation: named(sqlAttempt(asService(call(org.team.starts.userId, lot.id, homeBundle(randomUUID(), { project: { org_id: randomUUID() } })))), CREATE),
  }
  const afterRefusals = state(lot.id)

  // a failure after the home row is written leaves nothing behind
  const orphanId = randomUUID()
  const failedMidway = named(sqlAttempt(asService(call(org.team.starts.userId, lot.id, homeBundle(orphanId, { financialSettings: { created_by: org.owner.userId } })))), { ...CREATE, "refused: prepared home belongs to someone else": /ownership mismatch/ })
  const orphan = Number(kit.rows(`select count(*)::int n from public.projects where id=${q(orphanId)}`)[0].n)
  const afterMidway = state(lot.id)

  // the real service path: home, link, package and gates commit together, once
  const gateDefinitions = Number(kit.rows(`select count(*)::int n from public.start_gate_definitions where org_id=${q(org.orgId)} and is_active`)[0].n)
  const opened = await kit.as(org.team.starts, () => starts.openStartPackage(positive.id, { isFinanced: false }))
  const afterOpen = state(positive.id)
  const gates = Number(kit.rows(`select count(*)::int n from public.start_package_gates where start_package_id=${q(opened.id)}`)[0].n)
  const trail = kit.rows(`select (select count(*)::int from public.audit_log where org_id=${q(org.orgId)} and source='starts.home_created' and entity_id in (${q(afterOpen.project_id)},${q(positive.id)})) "homeAudits",
    (select count(*)::int from public.audit_log where org_id=${q(org.orgId)} and source='starts.package_opened' and entity_id=${q(opened.id)}) "packageAudits",
    (select count(*)::int from public.events where org_id=${q(org.orgId)} and event_type='start_package.opened' and entity_id=${q(opened.id)} and payload->>'created_home'='true') events,
    (select property_type||'/'||phase from public.projects where id=${q(afterOpen.project_id)}) posture`)[0]
  const reopen = named(await attempt(() => kit.as(org.team.starts, () => starts.openStartPackage(positive.id, { isFinanced: false }))), CREATE)
  const homesAfterReopen = Number(kit.rows(`select count(*)::int n from public.projects where org_id=${q(org.orgId)} and id=${q(afterOpen.project_id)}`)[0].n)
  // cleanup: cancelling the package keeps the home; opening again reuses it instead of building another
  await kit.as(org.team.starts, () => starts.cancelStartPackage(opened.id, { reason: "QA: cancelled to prove the home is reused" }))
  const reopened = await kit.as(org.team.starts, () => starts.openStartPackage(positive.id, { isFinanced: false }))
  const afterReopen = state(positive.id)

  eq(check, "an actor without start.write, without project.manage, without division reach, a claim, a browser session, another organisation or a home prepared for someone else cannot create a home; the lot stays as it was", expected.expected.refusals, { ...refusals, lotUntouched: JSON.stringify(before) === JSON.stringify(afterRefusals) })
  eq(check, "a failure after the home row is written rolls everything back: no orphan home, the lot has no home and no package", expected.expected.atomic, {
    failedMidway, orphanHomes: orphan, lotStill: { hasHome: afterMidway.project_id !== null, status: afterMidway.status, activePackages: afterMidway.packages },
  })
  eq(check, "opening a package creates the production home, links the lot, adds the package and every active gate together, with audit and event; a second open is refused and does not build another home", expected.expected.created, {
    lot: { status: afterOpen.status, linkedToTheNewHome: afterOpen.project_id !== null, activePackages: afterOpen.packages },
    packageHome: opened.projectId === afterOpen.project_id,
    gatesOpened: gates === gateDefinitions && gates > 0,
    trail: { homeAudits: trail.homeAudits >= 1, packageAudits: trail.packageAudits, events: trail.events, posture: trail.posture },
    secondOpen: reopen, homesAfterSecondOpen: homesAfterReopen,
  })
  eq(check, "cancelling the package keeps the home and opening again reuses it: still one home on the lot", expected.expected.reuse, {
    sameHome: afterReopen.project_id === afterOpen.project_id, activePackages: afterReopen.packages, packageHome: reopened.projectId === afterOpen.project_id,
  })
  return { orgId: org.orgId, lotId: lot.id }
}

// ---------------------------------------------------------------------------
// EP07-11 multi_session: concurrent releases of one package; concurrent home creation for one lot

async function raceReleaseAndHomeCreationYieldOneHome(kit, expected, check) {
  const org = await orgOf(kit)
  const starts = app("starts")
  const q = (v) => sqlq(kit, v)
  const rounds = []
  for (let round = 0; round < 3; round += 1) {
    // two coordinators release one package at the same moment
    const home = await readyHome(kit, SLOT.raceRelease[round])
    const settled = await Promise.allSettled([
      kit.as(org.team.starts, () => starts.releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" })),
      kit.as(org.owner, () => starts.releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" })),
    ])
    kit.sql(`update public.outbox set run_at=${HOUR} where org_id=${q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)} and status='pending'`)
    const jobs = kit.rows(`select id::text, status from public.outbox where org_id=${q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)}`)
    const detail = kit.rows(`select (select count(*)::int from public.start_release_steps where start_package_id=${q(home.packageId)}) steps,
      (select count(*)::int from public.audit_log where org_id=${q(org.orgId)} and source='starts.release_queued' and entity_id=${q(home.packageId)}) audits,
      (select count(*)::int from public.events where org_id=${q(org.orgId)} and event_type in ('start.release_queued','start.released_over_slot') and entity_id=${q(home.packageId)}) events,
      (select status from public.start_packages where id=${q(home.packageId)}) status`)[0]
    const loser = settled.find((r) => r.status === "rejected")
    const release = {
      winners: settled.filter((r) => r.status === "fulfilled" && r.value.released === true).length,
      loserRefused: loser ? named(loser.reason.message, REFUSED) : "no loser",
      queuedJobs: jobs.length, package: detail.status, steps: detail.steps, audits: detail.audits, events: detail.events,
    }
    await kit.as(org.team.starts, () => starts.cancelRelease(home.packageId))

    // the same contention at the database: two sessions run queue_start_release for the (again ready) package together
    const week = kit.rows(`select target_week::text w from public.start_packages where id=${q(home.packageId)}`)[0].w
    const queue = serviceSession(`select public.queue_start_release(${q(org.orgId)},${q(home.packageId)},${q(org.team.starts.userId)},${q(seed.isoDay(0))}::date,${q(week)}::date,99,true);`)
    const queued = (await race(kit, [queue, queue])).map((r) => (r.ok ? (/"queued": ?true/.test(r.stdout) ? "queued" : `UNRECOGNISED: ${r.stdout}`) : named(r.stderr, REFUSED)))
    kit.sql(`update public.outbox set run_at=${HOUR} where org_id=${q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)} and status='pending'`)
    const sqlJobs = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)} and status='pending'`)[0].n)
    release.databaseRace = { queued: queued.filter((r) => r === "queued").length, loserRefused: queued.find((r) => r !== "queued") ?? "no loser", pendingJobs: sqlJobs }
    await kit.as(org.team.starts, () => starts.cancelRelease(home.packageId))

    // two coordinators open a package on one lot at the same moment
    await developRaceLots(kit)
    const lot = org.lots[SLOT.raceHome[round]]
    const opened = await Promise.allSettled([
      kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false })),
      kit.as(org.owner, () => starts.openStartPackage(lot.id, { isFinanced: false })),
    ])
    const lotState = kit.rows(`select project_id::text, status from public.lots where id=${q(lot.id)}`)[0]
    const homeCount = Number(kit.rows(`select count(*)::int n from public.projects where org_id=${q(org.orgId)} and name = (select c.code || ' ' || l.lot_number from public.lots l join public.communities c on c.id=l.community_id where l.id=${q(lot.id)})`)[0].n)
    const packages = kit.rows(`select id::text, project_id::text from public.start_packages where lot_id=${q(lot.id)} and status<>'cancelled'`)
    const gates = Number(kit.rows(`select count(*)::int n from public.start_package_gates where start_package_id in (select id from public.start_packages where lot_id=${q(lot.id)})`)[0].n)
    const definitions = Number(kit.rows(`select count(*)::int n from public.start_gate_definitions where org_id=${q(org.orgId)} and is_active`)[0].n)
    const homeLoser = opened.find((r) => r.status === "rejected")
    const creation = {
      winners: opened.filter((r) => r.status === "fulfilled").length,
      loserRefused: homeLoser ? named(homeLoser.reason.message, REFUSED) : "no loser",
      homesForTheLot: homeCount, lotLinkedToThatHome: lotState.project_id !== null, packages: packages.length,
      packageOnTheLotsHome: packages.every((p) => p.project_id === lotState.project_id), gatesAreOneSet: gates === definitions,
    }
    rounds.push({ release, creation })
  }
  eq(check, "three rounds: two coordinators releasing one package queue exactly one job and one step ledger; two opening one lot create exactly one home, one package, one set of gates; the loser is a clean refusal", expected.expected.rounds, rounds)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP07-12: generated artifacts bind the active job and the owned home

async function generatedArtifactWritesBindTheJobAndHome(kit, expected, check) {
  const home = await readyHome(kit, SLOT.artifacts)
  const { org, lot, packageId, projectId } = home
  const other = await chain().stage(kit, "release")
  const q = (v) => sqlq(kit, v)
  // the home is adopted for owned-inventory accounting, as a release requires of an owned lot
  await adoptInventory(kit, org, projectId)
  const jobId = await queueRelease(kit, org, packageId)
  const startDate = kit.rows(`select scheduled_start_date::text d from public.start_packages where id=${q(packageId)}`)[0].d
  const job1 = await claimJob(kit, jobId)
  await packageLease(job1, "acquire", org.orgId)
  const w1 = workerClient(job1)
  const foreignBudget = kit.rows(`select id::text from public.budgets where project_id=${q(other.org.projectId)} limit 1`)[0]?.id
  const foreignInspection = kit.sql(`insert into public.inspections(org_id,project_id,inspection_number,kind,title) values(${q(org.orgId)},${q(other.org.projectId)},9001,'safety','Another house inspection') returning id`).split("\n")[0]
  const vendor = org.vendorIds["Gulf Concrete"]
  const sched = (client, project, name) => client.from("schedule_items").insert({ org_id: org.orgId, project_id: project, name }).select("id").single()
  const label = (message) => named(message, REFUSED)
  let budgetVersion = 100

  const writes = async (client, tag, { project = projectId } = {}) => {
    const out = {}
    const s = await sched(client, project, `${tag} task`)
    out.schedule = label(await attempt(async () => s))
    const b = await client.from("budgets").insert({ org_id: org.orgId, project_id: project, version: (budgetVersion += 1) }).select("id").single()
    out.budget = label(await attempt(async () => b))
    out.budgetLine = label(await attempt(() => client.from("budget_lines").insert({ org_id: org.orgId, budget_id: b.data?.id ?? foreignBudget, description: `${tag} line` })))
    const i = await client.from("inspections").insert({ org_id: org.orgId, project_id: project, inspection_number: Math.floor(Math.random() * 1e6), kind: "safety", title: `${tag} inspection` }).select("id").single()
    out.inspection = label(await attempt(async () => i))
    out.inspectionItem = label(await attempt(() => client.from("inspection_items").insert({ org_id: org.orgId, inspection_id: i.data?.id ?? foreignInspection, prompt: `${tag} item` })))
    out.purchaseOrder = label(await attempt(() => client.from("commitments").insert({ org_id: org.orgId, project_id: project, company_id: vendor, title: `${tag} PO`, commitment_type: "purchase_order" })))
    return out
  }
  const own = await writes(w1, "owner")
  const landed = Number(kit.rows(`select count(*)::int n from public.schedule_items where project_id=${q(projectId)} and name='owner task'`)[0].n)
  const intruder = await writes(w1, "intruder", { project: other.org.projectId })
  const intruderLanded = Number(kit.rows(`select count(*)::int n from public.schedule_items where name='intruder task'`)[0].n) +
    Number(kit.rows(`select count(*)::int n from public.commitments where title='intruder PO'`)[0].n)
  const subcontract = label(await attempt(() => w1.from("commitments").insert({ org_id: org.orgId, project_id: projectId, company_id: vendor, title: "not a PO", commitment_type: "subcontract" })))

  // land posting: the home's own transfer posts under the live claim; a different lot or date is a scope mismatch
  const rpcLand = (client, lotId, date) => client.rpc("transfer_books_land_to_start", { p_org_id: org.orgId, p_lot_id: lotId, p_date: date, p_actor_id: org.team.starts.userId })
  const wrongLot = label(await attempt(() => rpcLand(w1, other.org.lots[0].id, startDate)))
  const wrongDate = label(await attempt(() => rpcLand(w1, lot.id, seed.isoDay(-3))))
  const forgedJournal = label(await attempt(() => w1.from("journal_entries").insert({ org_id: org.orgId, entry_date: startDate, entry_kind: "adjusting", status: "posted", memo: "forged", posting_key: `forged:${randomUUID()}`, projection_version: 1, policy_version: 1, source_type: "inventory_start", source_id: other.org.lots[0].id, created_by: org.team.starts.userId })))
  const landStale = label(await attempt(() => rpcLand(workerClient({ id: job1.id, token: randomUUID() }), lot.id, startDate)))
  const posted = await attempt(() => rpcLand(w1, lot.id, startDate))
  const entries = kit.rows(`select count(*)::int n, coalesce(sum(l.debit_cents),0)::bigint debit from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=${q(org.orgId)} and e.source_type='inventory_start' and e.source_id=${q(lot.id)}`)[0]
  const repeat = await attempt(() => rpcLand(w1, lot.id, startDate))
  const entriesAfterRepeat = Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${q(org.orgId)} and source_type='inventory_start' and source_id=${q(lot.id)}`)[0].n)

  // the job is re-claimed: the stale worker is refused for every artifact and the posting; the live owner still writes
  const job2 = await reclaim(kit, org, packageId, job1)
  await packageLease(job2, "acquire", org.orgId)
  const w2 = workerClient(job2)
  const stale = await writes(w1, "stale")
  const staleLand = label(await attempt(() => rpcLand(w1, lot.id, startDate)))
  const staleRows = Number(kit.rows(`select count(*)::int n from public.schedule_items where project_id=${q(projectId)} and name like 'stale%'`)[0].n) +
    Number(kit.rows(`select count(*)::int n from public.commitments where project_id=${q(projectId)} and title like 'stale%'`)[0].n)
  const live = await writes(w2, "live")
  const liveRows = Number(kit.rows(`select count(*)::int n from public.schedule_items where project_id=${q(projectId)} and name='live task'`)[0].n)
  await kit.as(org.team.starts, () => app("starts").cancelRelease(packageId))

  const each = (m, v) => Object.fromEntries(Object.keys(m).map((k) => [k, m[k] === v ? v : m[k]]))
  eq(check, "the live claim writes schedule, budget, budget line, inspection, inspection item and purchase order on its own home", expected.expected.ownHome, { writes: own, scheduleLanded: landed })
  eq(check, "the same claim cannot write any of them on another house, nor a non-PO commitment, nor a forged journal entry", expected.expected.anotherHouse, { writes: intruder, nothingLanded: intruderLanded, nonPurchaseOrderCommitment: subcontract, forgedJournalEntry: forgedJournal })
  eq(check, "land posting binds the claim, the lot and the start date: wrong lot or date and a wrong token are refused; the right one posts once and a repeat posts nothing more", expected.expected.landPosting, {
    wrongLot, wrongDate, wrongToken: landStale, posted, entries: { count: Number(entries.n) >= 1, debitCents: Number(entries.debit) > 0 }, repeat, entriesAfterRepeat,
  })
  eq(check, "after the job is re-claimed the stale worker is refused for every artifact and the land posting, nothing of its lands, and the live owner's writes succeed", expected.expected.staleWorker, {
    stale, staleLandPosting: staleLand, staleRowsLanded: staleRows, live, liveScheduleRows: liveRows,
  })
  return { orgId: org.orgId, packageId, projectId }
}

// ---------------------------------------------------------------------------
// EP07-12 multi_session: a stale worker and the live owner write at the same moment

async function raceStaleWorkerAfterReclaim(kit, expected, check) {
  const home = await readyHome(kit, SLOT.stale)
  const { org, packageId, projectId } = home
  const q = (v) => sqlq(kit, v)
  const jobId = await queueRelease(kit, org, packageId)
  let stale = await claimJob(kit, jobId)
  await packageLease(stale, "acquire", org.orgId)
  const insertScript = (job, name) => serviceSession(`select set_config('request.headers',${q(JSON.stringify({ "x-starts-job-id": String(job.id), "x-starts-claim-token": job.token }))},false);
insert into public.schedule_items(org_id,project_id,name) values(${q(org.orgId)},${q(projectId)},${q(name)});`)
  const rounds = []
  for (let round = 1; round <= 3; round += 1) {
    // the reaper counts each expired claim; a job that has expired three times is failed, so each round starts from a fresh count
    kit.sql(`update public.outbox set retry_count=0 where id=${jobId}`)
    const live = await reclaim(kit, org, packageId, stale)
    await packageLease(live, "acquire", org.orgId)
    const [staleResult, liveResult] = await race(kit, [insertScript(stale, `round ${round} stale`), insertScript(live, `round ${round} live`)])
    const rows = kit.rows(`select name from public.schedule_items where project_id=${q(projectId)} and name like ${q(`round ${round} %`)} order by name`).map((r) => r.name)
    rounds.push({
      staleWriter: staleResult.ok ? "allowed" : named(staleResult.stderr, REFUSED),
      liveWriter: liveResult.ok ? "allowed" : named(liveResult.stderr, REFUSED),
      rowsThatLanded: rows,
    })
    stale = live
  }
  await kit.as(org.team.starts, () => app("starts").cancelRelease(packageId))
  eq(check, "three rounds: the job is re-claimed, then the previous worker and the new owner write at the same moment; only the live owner's row lands", expected.expected.rounds, rounds)
  return { orgId: org.orgId, packageId }
}

// ---------------------------------------------------------------------------
// EP13-04: the cron route's telemetry

async function startsCronTelemetryIsTruthful(kit, expected, check) {
  const org = await orgOf(kit)
  const { NextRequest } = require("next/server")
  const route = require("../../../app/api/jobs/starts-pipeline/route")
  const q = (v) => sqlq(kit, v)
  const get = (secret = process.env.CRON_SECRET) => route.GET(new NextRequest("http://127.0.0.1/api/jobs/starts-pipeline", { method: "GET", headers: secret ? { authorization: `Bearer ${secret}` } : {} }))
  const runsSince = (since) => kit.rows(`select status, http_status, error, duration_ms, finished_at is not null finished, started_at >= ${q(since)}::timestamptz recent from public.job_runs where job_name='starts-pipeline' and started_at >= ${q(since)}::timestamptz order by id`)
  const now = () => kit.sql("select clock_timestamp()::text")
  const quiet = async (work) => { const errors = []; const original = console.error; console.error = (...args) => errors.push(args.map(String).join(" ")); try { return { value: await work(), errors } } finally { console.error = original } }

  // The queue is shared with every other run on the stack: drain what is due first so the accepted run below starts from a quiet queue.
  for (let pass = 0; pass < 2; pass += 1) await kit.service(() => app("starts-pipeline").runStartsPipeline())

  // not authorised: refused, nothing recorded
  const t0 = now()
  const unauthorised = await get("not-the-secret")
  const unauthorisedRuns = runsSince(t0).length

  // accepted: 202 at once, and no telemetry is written until the work has finished
  const t1 = now()
  const accepted = await get()
  const acceptedBody = await accepted.json()
  const recordedBeforeTheWorkEnds = runsSince(t1).length
  await kit.settle()
  const completedRuns = runsSince(t1)

  // partially failed: a job the worker cannot do fails after its claim; the run is recorded as failed (207) with the summary
  const poison = insertJob(kit, org, { tag: "cron-poison", payload: { actor_id: null }, runAt: "clock_timestamp()" })
  kit.sql(`update public.outbox set payload=payload - 'actor_id' where id=${poison}`)
  const t2 = now()
  const partial = await get()
  await kit.settle()
  const partialRuns = runsSince(t2)
  const poisoned = outboxRow(kit, poison)
  park(kit, poison)
  const partialBody = (() => { try { return JSON.parse(partialRuns[0]?.error ?? "{}") } catch { return {} } })()

  // crashed: the pipeline throws before it can finish; the run is recorded as failed with the error and the crash is rethrown
  const server = dbServer()
  const original = server.createServiceSupabaseClient
  // The service client is a shared singleton: a fault is injected through a proxy, never by changing the client itself.
  const faulty = (override) => () => {
    const client = original()
    return new Proxy(client, { get(target, property) {
      const patched = override(target, property)
      if (patched) return patched
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
  }
  server.createServiceSupabaseClient = faulty((client, property) => property === "rpc"
    ? (name, ...rest) => (name === "recover_starts_job_leases" ? Promise.resolve({ data: null, error: { message: "injected: lease recovery unavailable" } }) : client.rpc(name, ...rest)) : null)
  const t3 = now()
  let crashed
  try {
    await get()
    crashed = await quiet(() => kit.settle().then(() => "no crash surfaced", (error) => error.message))
  } finally { server.createServiceSupabaseClient = original }
  const crashRuns = runsSince(t3)

  // the telemetry write itself failing is reported explicitly and does not change the response
  server.createServiceSupabaseClient = faulty((client, property) => property === "from"
    ? (table) => (table === "job_runs" ? { insert: () => Promise.resolve({ error: { message: "injected: job_runs unavailable" } }), delete: () => ({ lt: () => Promise.resolve({ error: null }) }) } : client.from(table)) : null)
  const t4 = now()
  let telemetry
  try {
    const response = await get()
    telemetry = await quiet(async () => { await kit.settle(); return response.status })
  } finally { server.createServiceSupabaseClient = original }
  const telemetryRuns = runsSince(t4)

  eq(check, "an unauthorised call is refused and records nothing", expected.expected.unauthorised, { status: unauthorised.status, runsRecorded: unauthorisedRuns })
  eq(check, "an accepted request answers 202 and records no success before the work has finished", expected.expected.accepted, { status: accepted.status, body: acceptedBody.ok === true, recordedBeforeTheWorkEnds })
  eq(check, "once the work finishes, one run is recorded with its real status, http status, finish time and duration", expected.expected.completed, {
    runs: completedRuns.length, status: completedRuns[0]?.status, finished: completedRuns[0]?.finished, durationRecorded: completedRuns[0]?.duration_ms >= 0,
    consistent: completedRuns[0]?.status === "success" ? completedRuns[0].http_status === 200 && completedRuns[0].error === null : completedRuns[0]?.http_status === 207,
  })
  eq(check, "partially failed work answers 207 and is recorded as failed with the summary naming how many failed; the job keeps its error and retry count", expected.expected.partial, {
    response: partial.status, runs: partialRuns.length, status: partialRuns[0]?.status, httpStatus: partialRuns[0]?.http_status, notOk: partialBody.ok === false, failedCounted: partialBody.failed >= 1,
    job: { status: poisoned.status, retryCount: poisoned.retry_count, error: poisoned.last_error },
  })
  eq(check, "a crashed pipeline is recorded as failed with its error and the crash still surfaces", expected.expected.crashed, {
    runs: crashRuns.length, status: crashRuns[0]?.status, httpStatus: crashRuns[0]?.http_status, errorNamesTheCrash: /injected: lease recovery unavailable/.test(crashRuns[0]?.error ?? ""), crashSurfaced: /Failed to recover expired starts claims/.test(crashed.value),
  })
  eq(check, "when the telemetry write itself fails it is reported as an explicit error and nothing false is recorded", expected.expected.telemetryFault, {
    responseUnchanged: telemetry.value, runsRecorded: telemetryRuns.length, reported: telemetry.errors.some((line) => /Unable to persist cron result: injected: job_runs unavailable/.test(line)),
  })
  retire(kit, org)
  return { orgId: org.orgId, poisonedJob: poison }
}

const subcases = {
  "trade-notice-recovery-desk": tradeNoticeRecoveryDesk,
  "claim-tokens-enforce-the-current-lease": claimTokensEnforceTheCurrentLease,
  "browser-clients-cannot-forge-starts-ownership": browserClientsCannotForgeOwnership,
  "race-claim-same-job": raceClaimSameJob,
  "core-release-writes-validate-current-ownership": coreReleaseWritesValidateCurrentOwnership,
  "new-home-creation-is-authorized-and-atomic": newHomeCreationIsAuthorizedAndAtomic,
  "race-release-and-home-creation-yield-one-home": raceReleaseAndHomeCreationYieldOneHome,
  "generated-artifact-writes-bind-the-job-and-home": generatedArtifactWritesBindTheJobAndHome,
  "race-stale-worker-after-reclaim": raceStaleWorkerAfterReclaim,
  "starts-cron-telemetry-is-truthful": startsCronTelemetryIsTruthful,
}

module.exports = { subcases }
