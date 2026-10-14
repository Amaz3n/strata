// RELEASE-01 — a release resumes, a lot cannot be pulled from under a live package, and a new gate
// reaches the packages already open (EP07-04, EP07-11, EP07-12, EP07-13, EP07-17), as the starts
// coordinator through Arc's services, with faults planted in the database where the real code
// would have been killed:
//
//   release-resumes-after-injected-crash-without-duplicates       a fault after the first budget line, after the second schedule item,
//                                                                 between the schedule handler and its settlement, and after the first
//                                                                 checklist item; each run is retried; the home ends with one budget, the
//                                                                 template's schedule and checklists once, one release event and one audit
//   cancel-mid-step-then-rerelease-builds-each-artifact-once      the coordinator cancels a release stopped part way through the schedule
//   incomplete-receipt-cannot-publish                             a step whose artifacts are fewer than it promised is refused by
//                                                                 settle_release_step; the release cannot publish; the replay completes it
//   lot-detach-while-package-active-is-refused-and-cancel-heals-strandings
//                                                                 EP07-11: the guard, the repair of a package stranded before it, and a
//                                                                 second cancel that changes nothing
//   new-gate-definition-reaches-open-packages-and-release-completes
//                                                                 EP07-17: a new gate reaches open and ready packages, a ready one returns
//                                                                 to open, and the release completes once it is answered
//   stale-worker-selection-writes-are-refused                     EP07-12: selection groups and exceptions are fenced to the claim
//   race-desk-mutation-vs-actor-revocation                        EP07-13: two real sessions, a desk RPC held open against the revocation
//   race-gate-or-package-edit-vs-queue-release                    EP07-11/13/17: an edit, a cancel or a gate change against the queue
//   race-lot-detach-vs-desk-write                                 EP07-11: a detach against a desk RPC held open
//
// Homes: one developed lot each of the RELEASE-01 org's tranche (lots 0-9). Faults are triggers on this
// org's rows only and are dropped in a `finally`. The drawings step is settled directly (the stack has
// no file storage; the storage legs are LOT-01's), and says so where it happens. Seeds depend on the
// shared helpers satisfying the release rules the way a user would (superintendent before release).
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race, asMember } = require("./sessions.cjs")

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const labelled = (outcome, pattern, label = "refused") => outcome === "allowed" ? "allowed" : pattern.test(outcome) ? label : String(outcome).slice(0, 300)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LOTS = { crash: 0, cancel: 1, receipt: 2, guard: 3, fanout: 4, fanoutSecond: 5, raceDesk: 6, raceQueue: 7, raceDetach: 8, spare: 9 }
const ORGS = new WeakMap()
/** A production builder with Cypress Landing, its plans and tranche 1 (lots 0-9) owned and developed. */
function releaseOrg(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "RELEASE-01 resumable releases" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    return org
  })())
  return ORGS.get(kit)
}

const BUILT_ORGS = new WeakMap()
/**
 * A builder whose releases build the budget and the checklists themselves: no price book (the price book the product
 * seed imports is voided before any package opens, so the budget step is not delegated to purchase orders) and a
 * released plan version carrying two checklists of two items each, authored through the checklist and plan services.
 */
function planBuiltOrg(kit) {
  if (!BUILT_ORGS.has(kit)) BUILT_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "RELEASE-01 plan-built releases" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    kit.sql(`update public.vendor_price_agreements set status='void' where org_id=${kit.q(org.orgId)}`)
    const inspections = app("inspections"), plans = app("house-plans")
    const templateIds = []
    for (const name of ["Framing walk", "Slab pour"]) {
      const template = await kit.as(org.owner, () => inspections.createChecklistTemplate({ name, kind: "quality", items: [{ prompt: `${name}: layout matches the plan`, response_type: "pass_fail" }, { prompt: `${name}: work is clean and complete`, response_type: "pass_fail" }] }))
      templateIds.push(template.id)
    }
    const plan = org.plans[1]
    const version = await kit.as(org.owner, () => plans.createPlanVersion(plan.id, { copyFromVersionId: plan.versionId, label: "With checklists" }))
    await kit.as(org.owner, () => plans.updatePlanVersion(version.id, { label: "With checklists", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: templateIds, selectionCategoryIds: [] }))
    await kit.as(org.owner, () => plans.releasePlanVersion(version.id))
    org.planBuilt = { ...plan, versionId: version.id }
    return org
  })())
  return BUILT_ORGS.get(kit)
}

const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, from) => Number(one(kit, `select count(*)::int n from ${from}`).n)
const svc = (kit, body) => kit.sql(`set role service_role;\n${body}`)

const HOMES = new WeakMap()
/** A ready spec home on the key's lot, built once per run (a lot has one active package). */
function readyHome(kit, key) {
  if (!HOMES.has(kit)) HOMES.set(kit, new Map())
  const homes = HOMES.get(kit)
  if (!homes.has(key)) homes.set(key, buildReadyHome(kit, key))
  return homes.get(key)
}
async function buildReadyHome(kit, key) {
  const built = key === "crash"
  const org = built ? await planBuiltOrg(kit) : await releaseOrg(kit)
  const plan = built ? org.planBuilt : org.plans[1]
  const lot = org.lots[LOTS[key]]
  seed.pinSpecPlan(kit, { lot, plan })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true })
  return { org, orgId: org.orgId, lot, lotId: lot.id, projectId: gates.projectId, packageId: gates.packageId, planVersionId: plan.versionId, actor: org.team.starts }
}

/** The released home's owned-inventory accounting, which the finalize step's land transfer needs. */
async function adoptInventory(kit, home) {
  const policies = app("books/revenue-policies")
  const proposal = await kit.as(home.org.owner, () => policies.proposeRevenuePolicy({ projectId: home.projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: "2026-06-01", rationale: "A spec home earns its revenue at closing." }))
  await kit.as(home.org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
  await kit.as(home.org.owner, () => app("books/inventory").enableProjectInventory({ projectId: home.projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/ownership` }))
}
const queueRelease = (kit, home) => kit.as(home.actor, () => app("starts").releaseStart(home.packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "Acceptance harness: week capacity is not under test" }))
/** The plan-set copy needs file storage, so that one step is settled directly and nothing else about the release is. */
const settleDrawings = (kit, home) => kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), error=null, detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)

async function runPipeline(kit) {
  for (let tries = 1; ; tries += 1) {
    try { return await kit.service(() => app("starts-pipeline").runStartsPipeline()) } catch (error) {
      if (tries >= 4 || !/fetch failed/.test(error.message)) throw error
    }
  }
}
/** One more go at this home's release: its job is due now, with its retries back at zero (a planted fault is not a real failure). */
const dueNow = (kit, home) => kit.sql(`update public.outbox set status='pending', retry_count=0, run_at=now(), start_claim_token=null, start_job_lease_expires_at=null, priority=1000000 where id=(select max(id) from public.outbox where org_id=${kit.q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)}) and status in ('pending','failed')`)
/**
 * Queueing a release also wakes the worker, which starts at once; a subcase that needs a fault in place plants it
 * BEFORE it queues, and waits here for that first run to stop before it looks at the home.
 */
async function quiesce(kit, home) {
  const jobs = (status) => count(kit, `public.outbox where org_id=${kit.q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} and ${status}`)
  let quiet = 0, waiting = 0
  for (let tries = 0; tries < 80 && quiet < 3; tries += 1) {
    await sleep(500)
    const busy = jobs("status='processing'") > 0
    const due = jobs("status='pending' and run_at<=now()") > 0
    // A due job nobody has claimed after two seconds is claimed here: the wake-up is best effort.
    if (due && !busy && (waiting += 1) >= 4) { await runPipeline(kit); waiting = 0 }
    quiet = busy || due ? 0 : quiet + 1
  }
}
/** A release the coordinator cancelled ends as a failed job by design; it is retired so the org's outbox can drain. */
const retireCancelled = (kit, home) => kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} and status='failed' and last_error='Release cancelled by coordinator'`)
async function runUntilSettled(kit, home) {
  for (let tries = 0; tries < 6; tries += 1) {
    dueNow(kit, home)
    await runPipeline(kit)
    const status = packageStatus(kit, home)
    if (["released", "attention"].includes(status)) return status
  }
  return packageStatus(kit, home)
}
const packageStatus = (kit, home) => one(kit, `select status from public.start_packages where id=${kit.q(home.packageId)}`).status

/**
 * A fault is a trigger that raises while `condition` holds, for this home only. `after` names the table it watches.
 * It stands where the real worker would have been killed: the rows before it are committed, the rest never happen.
 */
function plantFault(kit, name, { table, event = "insert", when }) {
  kit.sql(`create or replace function public.qa_fault_${name}() returns trigger language plpgsql as $f$ begin
    if ${when} then raise exception 'QA injected crash: ${name}'; end if; return new; end $f$;
    drop trigger if exists qa_fault_${name} on public.${table};
    create trigger qa_fault_${name} before ${event} on public.${table} for each row execute function public.qa_fault_${name}();`)
  return () => kit.sql(`drop trigger if exists qa_fault_${name} on public.${table}; drop function if exists public.qa_fault_${name}();`)
}
async function withFault(kit, name, spec, work) {
  const remove = plantFault(kit, name, spec)
  try { return await work() } finally { remove() }
}

/** What the home holds, counted from the rows themselves. */
function artifacts(kit, home) {
  const p = kit.q(home.projectId), v = kit.q(home.planVersionId)
  const snapshot = one(kit, `select jsonb_array_length(coalesce(bundle_snapshot->'schedule_template'->'items','[]')) schedule, jsonb_array_length(coalesce(bundle_snapshot->'checklists','[]')) checklists from public.house_plan_versions where id=${v}`)
  return {
    budgets: count(kit, `public.budgets where project_id=${p}`),
    scheduleMatchesTemplate: count(kit, `public.schedule_items where project_id=${p} and metadata->>'release_key' like 'schedule:%'`) === Number(snapshot.schedule),
    inspectionsMatchChecklists: count(kit, `public.inspections where project_id=${p} and metadata->>'release_key' like 'checklist:%'`) === Number(snapshot.checklists),
    inspectionsWithoutItems: count(kit, `public.inspections i where i.project_id=${p} and i.metadata->>'release_key' like 'checklist:%' and not exists(select 1 from public.inspection_items n where n.inspection_id=i.id)`),
    duplicateScheduleKeys: count(kit, `(select metadata->>'release_key' from public.schedule_items where project_id=${p} and metadata->>'release_key' is not null group by 1 having count(*)>1) d`),
  }
}
const ledger = (kit, home) => {
  const steps = Object.fromEntries(kit.rows(`select step_key, status from public.start_release_steps where start_package_id=${kit.q(home.packageId)}`).map((row) => [row.step_key, row.status]))
  return {
    package: packageStatus(kit, home),
    allStepsCompleted: ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"].every((key) => ["completed", "skipped"].includes(steps[key])),
    releasedEvents: count(kit, `public.events where entity_id=${kit.q(home.packageId)} and event_type='start.released'`),
    publishAudits: count(kit, `public.audit_log where entity_id=${kit.q(home.packageId)} and source='starts.release_published'`),
    projectLedgerMarks: Object.keys(one(kit, `select coalesce(metadata->'plan_instantiation'->'produced','{}') p from public.projects where id=${kit.q(home.projectId)}`).p).sort(),
  }
}

// ---------------------------------------------------------------------------
// EP07-04, EP07-17

async function releaseResumesAfterInjectedCrash(kit, spec, check) {
  const home = await readyHome(kit, "crash")
  await adoptInventory(kit, home)
  const p = kit.q(home.projectId)
  const partial = {}
  const stepStatus = (step) => one(kit, `select status from public.start_release_steps where start_package_id=${kit.q(home.packageId)} and step_key=${kit.q(step)}`).status
  const keyedItems = () => count(kit, `public.schedule_items where project_id=${p} and metadata->>'release_key' like 'schedule:%'`)
  const budgetState = () => ({ budgets: count(kit, `public.budgets where project_id=${p}`), lines: count(kit, `public.budget_lines where budget_id in (select id from public.budgets where project_id=${p})`) })
  const budgetBuilt = () => ({
    keyedBudgets: count(kit, `public.budgets where project_id=${p} and metadata->>'release_key'='budget'`),
    budgetLinesMatchTotal: one(kit, `select coalesce((select sum(l.amount_cents) from public.budget_lines l where l.budget_id=b.id),0)=coalesce(b.total_cents,0) and exists(select 1 from public.budget_lines l where l.budget_id=b.id) ok from public.budgets b where b.project_id=${p} and b.metadata->>'release_key'='budget'`)?.ok === true,
  })

  // The first run starts as the release is queued, so each fault is planted before the run that meets it.
  await withFault(kit, "budget", { table: "budget_lines", when: `new.sort_order>=1 and (select project_id from public.budgets where id=new.budget_id)=${p}` }, async () => {
    await queueRelease(kit, home)
    settleDrawings(kit, home)
    await quiesce(kit, home)
    partial.afterBudgetFault = { package: packageStatus(kit, home), ...budgetState(), budgetStep: stepStatus("budget") }
  })
  await withFault(kit, "schedule", { table: "schedule_items", when: `new.project_id=${p} and new.metadata->>'release_key'='schedule:2'` }, async () => {
    dueNow(kit, home); await runPipeline(kit); await quiesce(kit, home)
    partial.afterScheduleFault = { package: packageStatus(kit, home), budgetStep: stepStatus("budget"), ...budgetBuilt(), items: keyedItems(), scheduleStep: stepStatus("schedule") }
  })
  await withFault(kit, "settle_schedule", { table: "start_release_steps", event: "update", when: `new.step_key='schedule' and new.status='completed'` }, async () => {
    dueNow(kit, home); await runPipeline(kit); await quiesce(kit, home)
    partial.afterSettlementFault = { itemsBuilt: artifacts(kit, home).scheduleMatchesTemplate, scheduleStep: stepStatus("schedule"), projectLedgerMarksSchedule: ledger(kit, home).projectLedgerMarks.includes("schedule") }
  })
  await withFault(kit, "checklist", { table: "inspection_items", when: `new.sort_order>=1 and (select project_id from public.inspections where id=new.inspection_id)=${p}` }, async () => {
    dueNow(kit, home); await runPipeline(kit); await quiesce(kit, home)
    partial.afterChecklistFault = { package: packageStatus(kit, home), scheduleStep: stepStatus("schedule"), checklistStep: stepStatus("checklists"), inspectionBuiltWithoutItems: artifacts(kit, home).inspectionsWithoutItems >= 1 }
  })

  const finalStatus = await runUntilSettled(kit, home)
  await kit.drainOutbox(home.orgId)
  equal(check, "a release killed at the second budget line, the third schedule item, the settlement of the schedule step and the second checklist item leaves a partial home each time and no failure is final", spec.expected.partial, partial)
  equal(check, "run again to the end, the home holds one approved budget whose lines total it, the template's schedule and both checklists once each with no duplicate key, one release event and one audit", spec.expected.final, { finalStatus, ...artifacts(kit, home), ...budgetBuilt(), ledger: ledger(kit, home) })
  return { orgId: home.orgId, packageId: home.packageId }
}

async function cancelMidStepThenRereleaseBuildsEachArtifactOnce(kit, spec, check) {
  const home = await readyHome(kit, "cancel")
  await adoptInventory(kit, home)
  const p = kit.q(home.projectId)
  let midway
  await withFault(kit, "cancel_schedule", { table: "schedule_items", when: `new.project_id=${p} and (select count(*) from public.schedule_items where project_id=new.project_id and metadata->>'release_key' like 'schedule:%')>=2` }, async () => {
    await queueRelease(kit, home)
    settleDrawings(kit, home)
    await quiesce(kit, home)
    midway = { items: count(kit, `public.schedule_items where project_id=${p} and metadata->>'release_key' like 'schedule:%'`) }
  })
  const cancelled = await kit.as(home.actor, () => app("starts").cancelRelease(home.packageId))
  retireCancelled(kit, home)
  const afterCancel = { package: packageStatus(kit, home), budgetStepKept: cancelled.preserved.includes("budget"), scheduleStepReset: cancelled.reset.includes("schedule"), items: midway.items }
  const again = await queueRelease(kit, home)
  settleDrawings(kit, home)
  const finalStatus = await runUntilSettled(kit, home)
  await kit.drainOutbox(home.orgId)
  equal(check, "cancelling a release stopped part way through the schedule keeps the budget step, resets the schedule step and leaves the two items it built", spec.expected.cancelled, afterCancel)
  equal(check, "released again, the schedule is completed from its tail and every artifact exists exactly once", spec.expected.final, { queuedAgain: again.released === true, finalStatus, ...artifacts(kit, home), ledger: ledger(kit, home) })
  return { orgId: home.orgId, packageId: home.packageId }
}

async function incompleteReceiptCannotPublish(kit, spec, check) {
  const home = await readyHome(kit, "receipt")
  await adoptInventory(kit, home)
  const p = kit.q(home.projectId)
  let refused
  // The step "builds" its items and one of them is gone before the step closes: fewer than it promised.
  kit.sql(`create or replace function public.qa_fault_lose_item() returns trigger language plpgsql security definer as $f$ begin
    delete from public.schedule_items where id=new.id and metadata->>'release_key'='schedule:1'; return null; end $f$;
    drop trigger if exists qa_fault_lose_item on public.schedule_items;
    create trigger qa_fault_lose_item after insert on public.schedule_items for each row when (new.project_id='${home.projectId}') execute function public.qa_fault_lose_item();`)
  try {
    await queueRelease(kit, home)
    settleDrawings(kit, home)
    await quiesce(kit, home)
    const step = one(kit, `select status, error from public.start_release_steps where start_package_id=${kit.q(home.packageId)} and step_key='schedule'`)
    refused = { scheduleStep: step.status, error: /receipt is incomplete/.test(step.error ?? "") ? "receipt is incomplete" : step.error, package: packageStatus(kit, home), checklistsStarted: one(kit, `select status from public.start_release_steps where start_package_id=${kit.q(home.packageId)} and step_key='checklists'`).status, releasedEvents: count(kit, `public.events where entity_id=${kit.q(home.packageId)} and event_type='start.released'`) }
  } finally { kit.sql(`drop trigger if exists qa_fault_lose_item on public.schedule_items; drop function if exists public.qa_fault_lose_item();`) }
  const published = await attempt(async () => svc(kit, `select public.publish_start_release(${kit.q(home.orgId)}, 0, ${kit.q(randomUUID())}::uuid, ${kit.q(randomUUID())}::uuid);`))
  const finalStatus = await runUntilSettled(kit, home)
  await kit.drainOutbox(home.orgId)
  equal(check, "a schedule step that left fewer items than it promised does not complete, nothing after it runs, and the package is not released", spec.expected.refused, { ...refused, publishWithoutAClaim: labelled(published, /lease lost/, "refused") })
  equal(check, "the replay builds the missing item and the release completes with every item present", spec.expected.final, { finalStatus, scheduleMatchesTemplate: artifacts(kit, home).scheduleMatchesTemplate, ledger: ledger(kit, home) })
  return { orgId: home.orgId, packageId: home.packageId, projectId: p }
}

// ---------------------------------------------------------------------------
// EP07-11

async function lotDetachWhilePackageActiveIsRefusedAndCancelHealsStrandings(kit, spec, check) {
  const org = await releaseOrg(kit)
  const lot = org.lots[LOTS.guard]
  const starts = app("starts"), lots = app("lots")
  const opened = await kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false }))
  const lotRow = () => one(kit, `select project_id::text, status, community_id::text from public.lots where id=${kit.q(lot.id)}`)
  const before = lotRow()
  const serviceDetach = labelled(await attempt(() => kit.as(org.owner, () => lots.detachProjectFromLot(lot.id))), /Cancel this lot's start package/, "refused: cancel the package first")
  const sql = (statement) => { try { kit.sql(`${asMember(org.owner)}\n${statement}`); return "allowed" } catch (error) { return error.message } }
  const sessionDetach = labelled(sql(`update public.lots set project_id=null, status='assigned' where id=${kit.q(lot.id)};`), /Cancel the start package before detaching/, "refused: cancel the package first")
  kit.sql(`insert into public.communities(org_id,name) select ${kit.q(org.orgId)},'RELEASE-01 Inland' where not exists(select 1 from public.communities where org_id=${kit.q(org.orgId)} and name='RELEASE-01 Inland')`)
  const other = one(kit, `select id::text from public.communities where org_id=${kit.q(org.orgId)} and name='RELEASE-01 Inland'`)
  const move = other ? labelled(sql(`update public.lots set community_id=${kit.q(other.id)} where id=${kit.q(lot.id)};`), /Cancel the start package before detaching or moving/, "refused: cancel the package first") : "no other community"
  const stillAttached = JSON.stringify(lotRow()) === JSON.stringify(before)

  // A lot detached before the guard existed: nothing reached its package. Planted the way that data was left.
  kit.sql(`alter table public.lots disable trigger lots_active_start_guard; update public.lots set project_id=null, status='assigned' where id=${kit.q(lot.id)}; alter table public.lots enable trigger lots_active_start_guard;`)
  const stranded = { lotHasHome: lotRow().project_id !== null, update: labelled(await attempt(() => kit.as(org.team.starts, () => starts.updateStartPackage(opened.id, { notes: "stranded" }))), /ancestry differs/, "refused: ancestry differs") }
  await kit.as(org.team.starts, () => starts.cancelStartPackage(opened.id, { reason: "Stranded when the lot was detached" }))
  const afterFirst = one(kit, `select status, metadata->>'cancellation_reason' reason from public.start_packages where id=${kit.q(opened.id)}`)
  const second = await attempt(() => kit.as(org.team.starts, () => starts.cancelStartPackage(opened.id, { reason: "A different reason that must not replace the first" })))
  const afterSecond = one(kit, `select status, metadata->>'cancellation_reason' reason from public.start_packages where id=${kit.q(opened.id)}`)
  const trail = { audits: count(kit, `public.audit_log where entity_id=${kit.q(opened.id)} and source='starts.package_cancelled'`), events: count(kit, `public.events where entity_id=${kit.q(opened.id)} and event_type='start_package.cancelled'`) }
  const reopened = await attempt(() => kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false })))
  equal(check, "an owner cannot detach or move a lot that has a live package, in the service or as a member session, and the lot is unchanged", spec.expected.guard, { serviceDetach, sessionDetach, move, stillAttached })
  equal(check, "a package stranded before the guard fails the desk's ancestry check, can still be cancelled, a second cancel changes nothing and keeps the first reason, and the lot opens a new package", spec.expected.heal, { stranded, firstCancel: afterFirst, secondCancel: second, afterSecond, trail, reopened })
  return { orgId: org.orgId, lotId: lot.id }
}

// ---------------------------------------------------------------------------
// EP07-17

async function newGateDefinitionReachesOpenPackagesAndReleaseCompletes(kit, spec, check) {
  const home = await readyHome(kit, "fanout")
  const org = home.org
  const starts = app("starts")
  const second = await kit.as(org.team.starts, () => starts.openStartPackage(org.lots[LOTS.fanoutSecond].id, { isFinanced: false }))
  const key = `qa_soil_${randomUUID().slice(0, 6)}`
  const gatesOf = (packageId) => kit.rows(`select d.key, g.status from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id where g.start_package_id=${kit.q(packageId)} and d.key=${kit.q(key)}`)
  const before = { readyPackage: packageStatus(kit, home), gate: gatesOf(home.packageId).length, openPackageGate: gatesOf(second.id).length }
  const definition = { key, label: "Soil report on file", checkKind: "manual", appliesWhen: "always", sortOrder: 70 }
  const saved = await kit.as(org.owner, () => starts.upsertGateDefinition({ ...definition, isActive: true }))
  const reached = { readyPackage: packageStatus(kit, home), gate: gatesOf(home.packageId), openPackageGate: gatesOf(second.id), notReadyEvent: count(kit, `public.events where entity_id=${kit.q(home.packageId)} and event_type='start_package.not_ready'`) >= 1 }
  const refused = labelled(await attempt(() => queueRelease(kit, home)), /not ready/i, "refused: not ready")
  const gate = (await kit.as(org.team.starts, () => starts.getStartPackage(home.packageId))).gates.find((entry) => entry.key === key)
  await kit.as(org.team.starts, () => starts.attestGate(home.packageId, gate.id, { evidenceFileId: seed.homeFile(kit, org, home.projectId, "soil-report.pdf") }))
  const ready = packageStatus(kit, home)
  await adoptInventory(kit, home)
  await queueRelease(kit, home)
  settleDrawings(kit, home)
  const finalStatus = await runUntilSettled(kit, home)
  await kit.drainOutbox(home.orgId)
  // The gate is this subcase's: it is switched off so no later home in the org opens with an unanswered gate.
  await kit.as(org.owner, () => starts.upsertGateDefinition({ ...definition, id: saved.id, isActive: false }))
  const viewer = await attempt(() => kit.as(org.team.sales, () => starts.upsertGateDefinition({ key: `${key}_x`, label: "Not allowed", checkKind: "manual", appliesWhen: "always", sortOrder: 71, isActive: true })))
  equal(check, "a new gate reaches the ready package and the open one, the ready package returns to open and cannot be released", spec.expected.reach, { before, reached: { ...reached, gate: reached.gate.map((row) => row.status), openPackageGate: reached.openPackageGate.map((row) => row.status) }, refused })
  equal(check, "answered with evidence the package is ready again and the release completes, and a member without start.release cannot define a gate", spec.expected.complete, { ready, finalStatus, ledger: ledger(kit, home), salesDefinesAGate: labelled(viewer, /start\.release/, "refused: start.release") })
  return { orgId: org.orgId, packageId: home.packageId, key }
}

// ---------------------------------------------------------------------------
// EP07-12

async function staleWorkerSelectionWritesAreRefused(kit, spec, check) {
  const home = await readyHome(kit, "spare")
  const headers = (job, token) => `select set_config('request.headers','${JSON.stringify({ "x-starts-job-id": String(job), "x-starts-claim-token": token })}',false);`
  const write = (table, projectId) => table === "project_selection_groups"
    ? `insert into public.project_selection_groups(org_id,project_id,group_id) values(${kit.q(home.orgId)},${kit.q(projectId)},gen_random_uuid());`
    : `insert into public.selection_exceptions(org_id,project_id,selection_id,option_id,reason) values(${kit.q(home.orgId)},${kit.q(projectId)},gen_random_uuid(),gen_random_uuid(),'lead_time_exceeded');`
  const forged = (table) => { try { svc(kit, `\\o /dev/null\n${headers(999999, randomUUID())}\n\\o\n${write(table, home.projectId)}`); return "allowed" } catch (error) { return /worker lease lost/.test(error.message) ? "refused: worker lease lost" : error.message.slice(0, 200) } }
  equal(check, "a claim that does not exist cannot write selection groups or exceptions, and nothing is left behind", spec.expected, {
    groups: forged("project_selection_groups"), exceptions: forged("selection_exceptions"),
    rows: count(kit, `public.project_selection_groups where project_id=${kit.q(home.projectId)}`) + count(kit, `public.selection_exceptions where project_id=${kit.q(home.projectId)}`),
  })
  return { orgId: home.orgId }
}

// ---------------------------------------------------------------------------
// EP07-13, EP07-11: two real sessions

const serviceSession = (body) => `set role service_role;\n${body}`
const epoch = "select 'T:'||extract(epoch from clock_timestamp());"
const stamps = (stdout) => [...stdout.matchAll(/T:([0-9.]+)/g)].map((match) => Number(match[1]))
const HOLD = 2

async function raceDeskMutationVsActorRevocation(kit, spec, check) {
  const home = await readyHome(kit, "raceDesk")
  const org = home.org
  const q = kit.q
  const member = kit.addMember(org, "org_starts_coordinator")
  const membership = () => one(kit, `select id::text from public.memberships where org_id=${q(org.orgId)} and user_id=${q(member.userId)}`).id
  const edit = (n) => `select public.update_start_package(${q(org.orgId)},${q(home.packageId)},${q(member.userId)},'{"notes":"race ${n}"}'::jsonb,false);`
  const kinds = [
    { name: "membership suspended", revoke: () => `update public.memberships set status='suspended' where id=${q(membership())};`, restore: () => `update public.memberships set status='active' where id=${q(membership())};` },
    { name: "start.write denied", revoke: () => `insert into public.membership_permission_overrides(membership_id,permission_key,effect) values(${q(membership())},'start.write','deny');`, restore: () => `delete from public.membership_permission_overrides where membership_id=${q(membership())};` },
    { name: "membership suspended again", revoke: () => `update public.memberships set status='suspended' where id=${q(membership())};`, restore: () => `update public.memberships set status='active' where id=${q(membership())};` },
  ]
  const rounds = []
  for (const [round, kind] of kinds.entries()) {
    const notesBefore = one(kit, `select coalesce(notes,'') n from public.start_packages where id=${q(home.packageId)}`).n
    const holder = serviceSession(`begin;\n${epoch}\n${edit(round)}\nselect pg_sleep(${HOLD});\ncommit;\n${epoch}`)
    const revoker = `select pg_sleep(0.4);\n${epoch}\n${kind.revoke()}\n${epoch}`
    const [a, b] = await race(kit, [holder, revoker])
    kit.sql(kind.restore())
    const notes = one(kit, `select coalesce(notes,'') n from public.start_packages where id=${q(home.packageId)}`).n
    const [, bEnd] = stamps(b.stdout), [bStart] = stamps(b.stdout)
    rounds.push({
      revocation: kind.name,
      revocationBlockedBehindTheOpenTransaction: b.ok && bEnd - bStart >= HOLD - 0.6,
      holderCommitted: a.ok,
      holderLeftItsAuditAndEvent: a.ok ? count(kit, `public.audit_log where entity_id=${q(home.packageId)} and source='starts.package_updated' and after_data->>'notes'='race ${round}'`) === 1 : true,
      serialEquivalent: a.ok ? notes === `race ${round}` : notes === notesBefore && /no longer/.test(a.stderr),
    })
  }
  equal(check, "three rounds: a desk RPC held open blocks the revocation until it commits; the edit lands with its audit, or is refused with nothing written", spec.expected, { rounds })
  return { orgId: org.orgId, packageId: home.packageId }
}

async function raceGateOrPackageEditVsQueueRelease(kit, spec, check) {
  const org = await releaseOrg(kit)
  const q = kit.q
  const rounds = []
  const actions = [
    { name: "financing change", call: (h) => `select public.update_start_package(${q(h.orgId)},${q(h.packageId)},${q(h.actor.userId)},'{"is_financed":true}'::jsonb,false);` },
    { name: "cancel", call: (h) => `select public.cancel_start_package(${q(h.orgId)},${q(h.packageId)},${q(h.actor.userId)},'Cancelled while a release was being queued');` },
  ]
  // Each round needs a ready package of its own; the queue is the same for both.
  for (const [round, action] of actions.entries()) {
    const home = await readyHome(kit, round === 0 ? "raceQueue" : "raceDetach")
    const week = one(kit, `select coalesce(target_week, date_trunc('week', ${q(seed.isoDay(0))}::date)::date)::text w from public.start_packages where id=${q(home.packageId)}`).w
    const queue = serviceSession(`select 'Q:'||((public.queue_start_release(${q(home.orgId)},${q(home.packageId)},${q(home.actor.userId)},${q(seed.isoDay(0))}::date,${q(week)}::date,99,true))->>'queued');`)
    const edit = serviceSession(`select 'E:'||(${action.call(home).replace(/;$/, "")})::text;`)
    const [a, b] = await race(kit, [queue, edit])
    const status = packageStatus(kit, home)
    const financed = one(kit, `select is_financed from public.start_packages where id=${q(home.packageId)}`).is_financed === true
    const [queueWon, editWon] = [a.ok, b.ok]
    // Serial order decides who wins. A cancel excludes the queue either way. A financing change leaves a ready package
    // ready, so edit-then-queue lets both through; queue-then-edit refuses the edit (the package is releasing).
    rounds.push({
      action: action.name,
      atLeastOneWon: queueWon || editWon,
      loserRefusedCleanly: [a, b].filter((r) => !r.ok).every((r) => /not ready to release|cannot be cancelled|Only open or ready|already being released/.test(r.stderr)),
      consistent: queueWon
        ? status === "releasing" && (action.name === "cancel" ? !editWon : financed === editWon)
        : editWon && (action.name === "cancel" ? status === "cancelled" : ["open", "ready"].includes(status) && financed),
    })
    kit.sql(`update public.outbox set status='completed' where org_id=${q(home.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)} and status in ('pending','processing')`)
  }
  equal(check, "an edit or a cancel against the queue, released together: the outcome is one of the serial orders, any refusal is a clean one, and the package ends in the state that order leaves", spec.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceLotDetachVsDeskWrite(kit, spec, check) {
  const home = await readyHome(kit, "spare")
  const { org, lot } = home
  const q = kit.q
  const pkg = { id: home.packageId }
  const actor = org.team.starts
  const edit = serviceSession(`begin;\n${epoch}\nselect public.update_start_package(${q(org.orgId)},${q(pkg.id)},${q(actor.userId)},'{"notes":"detach race"}'::jsonb,false);\nselect pg_sleep(${HOLD});\ncommit;`)
  const detach = `select pg_sleep(0.4);\nupdate public.lots set project_id=null, status='assigned' where id=${q(lot.id)};`
  const [a, b] = await race(kit, [edit, detach])
  equal(check, "a detach against a desk write held open is refused whichever order the sessions run in, and the lot keeps its home", spec.expected, {
    deskWriteOutcome: a.ok ? "committed" : /Only open or ready|not found|ancestry/.test(a.stderr) ? "refused cleanly" : a.stderr.slice(0, 200),
    detach: b.ok ? "allowed" : /Cancel the start package/.test(b.stderr) ? "refused: cancel the package first" : b.stderr.slice(0, 200),
    lotKeepsItsHome: one(kit, `select project_id is not null ok from public.lots where id=${q(lot.id)}`).ok === true,
  })
  return { orgId: org.orgId, lotId: lot.id }
}

module.exports = {
  id: "RELEASE-01",
  subcases: {
    "release-resumes-after-injected-crash-without-duplicates": releaseResumesAfterInjectedCrash,
    "cancel-mid-step-then-rerelease-builds-each-artifact-once": cancelMidStepThenRereleaseBuildsEachArtifactOnce,
    "incomplete-receipt-cannot-publish": incompleteReceiptCannotPublish,
    "lot-detach-while-package-active-is-refused-and-cancel-heals-strandings": lotDetachWhilePackageActiveIsRefusedAndCancelHealsStrandings,
    "new-gate-definition-reaches-open-packages-and-release-completes": newGateDefinitionReachesOpenPackagesAndReleaseCompletes,
    "stale-worker-selection-writes-are-refused": staleWorkerSelectionWritesAreRefused,
    "race-desk-mutation-vs-actor-revocation": raceDeskMutationVsActorRevocation,
    "race-gate-or-package-edit-vs-queue-release": raceGateOrPackageEditVsQueueRelease,
    "race-lot-detach-vs-desk-write": raceLotDetachVsDeskWrite,
  },
}
