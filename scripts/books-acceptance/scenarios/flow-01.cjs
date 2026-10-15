// FLOW-01 — starts flow capacity (EP07-01, EP07-02, EP07-03). One production builder
// (Cypress Landing in the Gulf Coast division, The Mangrove offered, the first tranche bought
// and developed). Every subcase acts through `kit.as`, so row-level security and permission
// checks are the real ones:
//
//   starts-financing-gate-holds-financed-sale-until-loan-approval-evidenced  EP07-01  loan approval or proof of funds, with the document on the home
//   starts-attested-evidence-archived-before-publication-blocks-release      EP07-01  an attestation stands on its file until the house publishes
//   starts-release-without-superintendent-is-refused                         EP07-03  the release transaction refuses a house nobody runs
//   starts-assigning-past-capacity-is-refused-without-override               EP07-03  per-person limits, the org default, the audited override
//   race-two-assignments-to-the-last-open-capacity-slot                      EP07-03  two sessions, one open slot, exactly one assignment
//   starts-division-throughput-cap-spans-communities                         EP07-02  division and org caps count every community, over target needs a reason
//   race-two-releases-into-one-throughput-cap                                EP07-02  two sessions release into a cap of one, exactly one queues
//   starts-viewer-cannot-write-slots-or-targets-through-the-data-api         EP07-02  slots, targets, limits and superintendents are server-written
//   starts-release-impact-preview-matches-closing-schedule                   EP07-02  a start date's effect on a promised closing
//
// Lots (Cypress Landing, 1-10 developed): 1 financed sale, 2 cash sale, 3 sold home for the
// impact preview, 4 attested evidence (a spec home), 5 no superintendent, 6-8 capacity, 9 and 10
// the throughput cap. Capacity is measured against what the person already runs when a subcase
// starts, so no subcase depends on another having run.
//
// SQL is used only for what a subcase is not about and says so where it happens: evidence file
// records (the stack has no file storage), a house in another community of the division that
// already released (a second community's whole start chain is not the subject), an archived file,
// the direct writes the database must refuse, and reads that check the outcome.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")

const context = () => require("../../../lib/services/context")
const math = () => require("../../../lib/starts/even-flow-math")
const impact = () => require("../../../lib/starts/close-impact")

const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
const outcome = async (work) => ((await attempt(work)) === "allowed" ? "allowed" : "refused")
const sqlAttempt = (kit, statement) => {
  try { kit.sql(statement); return "allowed" } catch (error) { const line = /ERROR:\s+([^\n]+)/.exec(error.message); return line ? line[1].trim() : error.message }
}
const one = (kit, sql) => kit.rows(sql)[0]
const day = (offset) => seed.isoDay(offset)
const rel = (date) => (date ? `D${Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86400000)}` : null)
const serviceSession = (body) => `set role service_role;\n${body}`

/** A REST write as the member's own session, as a browser would send it: "refused" with the database's words, or "allowed". */
const rest = (kit, actor, write) => attempt(() => kit.as(actor, async () => {
  const { supabase } = await context().requireOrgContext()
  const { error, data } = await write(supabase)
  if (error) throw new Error(error.message)
  if (Array.isArray(data) && data.length === 0) throw new Error("no row changed")
}))
/** Houses a person runs now, so a subcase sets its limits relative to it. */
const housesOf = (kit, org, userId) => Number(one(kit, `select count(*)::int n from public.projects where org_id=${kit.q(org.orgId)} and superintendent_id=${kit.q(userId)} and status not in ('completed','cancelled')`).n)
const unassign = (kit, projectIds) => kit.sql(`update public.projects set superintendent_id=null where id in (${projectIds.map((id) => kit.q(id)).join(",")})`)

// ---------------------------------------------------------------------------
// The builder, built once per run and shared by the subcases.

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "FLOW-01 starts flow" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  org.viewer = kit.addMember(org, "org_viewer")
  org.projectLead = kit.addMember(org, "org_project_lead")
  org.nextLot = 2
  return { org }
}

/** A spec home on a developed lot: plan pinned, package opened, every gate a person owns cleared; its superintendent is each subcase's own business. */
async function specHome(kit, org, index, extra = {}) {
  const lot = org.lots[index]
  seed.pinSpecPlan(kit, { lot, plan: org.plans[0] })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true, superintendent: false, ...extra })
  return { lot, packageId: gates.packageId, projectId: gates.projectId }
}

/** A sold home: the buyer's executed agreement on a developed lot, financed unless the terms say cash. */
async function soldHome(kit, org, index, buyer, terms = {}) {
  const lot = org.lots[index]
  const prospect = await seed.registerBuyer(kit, org, buyer)
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot.id, depositCents: 1000000, receivedOn: "2026-06-06" })
  const swing = one(kit, `select swing from public.lots where id=${kit.q(lot.id)}`).swing === "left" ? "left" : "right"
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: { ...seed.configuration(org, { lotId: lot.id, plan: org.plans[0], swing, skus: [] }), ...terms } })
  return { lot, ...sale }
}

const gateStatus = (gates, key) => gates.find((gate) => gate.key === key)?.status
const milestoneRow = (kit, projectId, key) => one(kit, `select m.id, m.version, m.status from public.agreement_milestones m join public.contracts c on c.id=m.contract_id and c.status='active' where m.project_id=${kit.q(projectId)} and m.template_key=${kit.q(key)}`)

// ---------------------------------------------------------------------------
// 1. EP07-01: the financing gate reads evidence, never absence.

async function financingGate(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts"), milestones = app("agreement-milestones")
  const refresh = async (packageId) => gateStatus(await kit.as(org.team.starts, () => starts.refreshAutoGates(packageId)), "financing")
  const resolve = (row, fields) => kit.as(org.owner, () => milestones.resolveAgreementMilestone({ milestoneId: row.id, version: row.version, ...fields }))
  const observed = {}

  // A financed sale: nothing attached holds the gate, however quiet the agreement is.
  const financed = await soldHome(kit, org, 0, { name: "Lena Ortiz", email: "lena.ortiz@acceptance.example.test" })
  const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(financed.lot.id, { isFinanced: true }))
  observed.financedOpened = await refresh(pkg.id)
  await resolve(milestoneRow(kit, financed.projectId, "lender:loan_application"), { resolution: "satisfied", resolvedOn: day(0), evidenceFileId: null })
  observed.afterApplication = await refresh(pkg.id)
  const approval = milestoneRow(kit, financed.projectId, "lender:loan_approval")
  const approvalFile = seed.homeFile(kit, org, financed.projectId, "loan-approval.pdf")
  await resolve(approval, { resolution: "satisfied", resolvedOn: day(0), evidenceFileId: approvalFile })
  observed.afterApproval = await refresh(pkg.id)
  // The lender withdraws: reopening the approval holds the gate again.
  await resolve(milestoneRow(kit, financed.projectId, "lender:loan_approval"), { resolution: "open", note: "Lender withdrew the approval pending a new appraisal" })
  observed.afterReopen = await refresh(pkg.id)
  // Waived with a reason is not a document.
  await resolve(milestoneRow(kit, financed.projectId, "lender:loan_approval"), { resolution: "waived", resolvedOn: day(0), note: "Buyer says the approval letter is coming" })
  observed.afterWaiver = await refresh(pkg.id)
  // Satisfied again, then the document leaves the home (archived: the record is the file's, not the milestone's).
  await resolve(milestoneRow(kit, financed.projectId, "lender:loan_approval"), { resolution: "open", note: "Waiver was a mistake; the letter is needed" })
  const second = seed.homeFile(kit, org, financed.projectId, "loan-approval-signed.pdf")
  await resolve(milestoneRow(kit, financed.projectId, "lender:loan_approval"), { resolution: "satisfied", resolvedOn: day(0), evidenceFileId: second })
  observed.satisfiedAgain = await refresh(pkg.id)
  kit.sql(`update public.files set archived_at=now() where id=${kit.q(second)}`)
  observed.afterArchive = await refresh(pkg.id)

  // A cash sale proves its funds instead.
  const cash = await soldHome(kit, org, 1, { name: "Marco Silva", email: "marco.silva@acceptance.example.test" }, { financing: "cash" })
  const cashPkg = await kit.as(org.team.starts, () => starts.openStartPackage(cash.lot.id, { isFinanced: false }))
  observed.cashMilestones = kit.rows(`select template_key, required_before, evidence_required from public.agreement_milestones where project_id=${kit.q(cash.projectId)} and kind='financing'`)
  observed.cashOpened = await refresh(cashPkg.id)
  await resolve(milestoneRow(kit, cash.projectId, "buyer:proof_of_funds"), { resolution: "satisfied", resolvedOn: day(0), evidenceFileId: seed.homeFile(kit, org, cash.projectId, "proof-of-funds.pdf") })
  observed.cashProved = await refresh(cashPkg.id)

  check.equal("a sold home's financing gate clears only on the lender's loan approval (financed) or proof of funds (cash) satisfied with its document on the home: nothing attached, an open, reopened or waived record and an archived file all hold it", expected.expected, observed)
  return { orgId: org.orgId, packageId: pkg.id }
}

// ---------------------------------------------------------------------------
// 2. EP07-01: an attestation stands on its file until the house publishes.

async function attestedEvidenceArchived(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts")
  await kit.as(org.team.starts, () => starts.upsertGateDefinition({ key: "soil_report", label: "Soil report on file", checkKind: "manual", appliesWhen: "always", sortOrder: 95, isActive: true }))
  let evidenceId = null
  const home = await specHome(kit, org, 3, {
    beforeApproval: async ({ packageId, projectId }) => {
      const detail = await kit.as(org.team.starts, () => starts.getStartPackage(packageId))
      evidenceId = seed.homeFile(kit, org, projectId, "soil-report.pdf")
      await kit.as(org.team.starts, () => starts.attestGate(packageId, detail.gates.find((gate) => gate.key === "soil_report").id, { evidenceFileId: evidenceId, notes: "Geotech report received" }))
    },
  })
  const ready = await kit.as(org.team.starts, () => starts.getStartPackage(home.packageId))
  // A spec home has no buyer, so there is nothing for its financing gate to prove.
  const observed = { readyWithEvidence: ready.status, specFinancing: gateStatus(ready.gates, "financing") }
  await seed.assignSuperintendent(kit, org, { projectId: home.projectId })
  // The report is withdrawn from the home between readiness and publication.
  kit.sql(`update public.files set archived_at=now() where id=${kit.q(evidenceId)}`)
  const released = await seed.releaseHome(kit, org, { packageId: home.packageId, projectId: home.projectId })
  observed.afterArchive = released.released.status === "released" ? "released" : "held"
  observed.refusal = /soil_report gate's evidence is no longer on the home/.test(one(kit, `select coalesce(last_error,'') e from public.outbox where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} order by id desc limit 1`).e)
  // The release stays parked; its job is settled and the custom gate retired so no later subcase meets either.
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)}`)
  await kit.as(org.team.starts, () => starts.upsertGateDefinition({ key: "soil_report", label: "Soil report on file", checkKind: "manual", appliesWhen: "always", sortOrder: 95, isActive: false }))
  unassign(kit, [home.projectId])
  check.equal("a manual gate attested with a file stays passed, but publication re-checks the file is still on the home and not archived: the release does not publish a house whose evidence has gone", expected.expected, observed)
  return { orgId: org.orgId, packageId: home.packageId }
}

// ---------------------------------------------------------------------------
// 3. EP07-03: a house is released with a superintendent.

async function releaseNeedsSuperintendent(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts")
  const home = await specHome(kit, org, 4)
  const observed = {}
  const serviceRefusal = await attempt(() => kit.as(org.team.starts, () => starts.releaseStart(home.packageId, { scheduledStartDate: day(0) })))
  observed.service = /Assign a superintendent/.test(serviceRefusal) ? "refused: no superintendent" : serviceRefusal
  const week = math().mondayOfIsoWeek(day(0))
  const rpc = (actor) => `select public.queue_start_release(${kit.q(org.orgId)},${kit.q(home.packageId)},${kit.q(actor.userId)},${kit.q(day(0))}::date,${kit.q(week)}::date,99,false)`
  const sqlRefusal = sqlAttempt(kit, rpc(org.team.starts))
  observed.database = /Assign a superintendent/.test(sqlRefusal) ? "refused: no superintendent" : sqlRefusal
  observed.packageStillReady = one(kit, `select status from public.start_packages where id=${kit.q(home.packageId)}`).status
  // A superintendent who has left the org is no superintendent.
  await kit.as(org.team.starts, () => starts.setProjectSuperintendent(home.projectId, org.team.superintendent.userId))
  kit.sql(`update public.memberships set status='suspended' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.team.superintendent.userId)}`)
  const suspended = sqlAttempt(kit, rpc(org.team.starts))
  observed.suspended = /no longer an active member/.test(suspended) ? "refused: not active" : suspended
  kit.sql(`update public.memberships set status='active' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.team.superintendent.userId)}`)
  const queued = await kit.as(org.team.starts, () => starts.releaseStart(home.packageId, { scheduledStartDate: day(0) }))
  observed.withSuperintendent = queued.released === true
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)};
update public.start_packages set status='cancelled' where id=${kit.q(home.packageId)}`)
  unassign(kit, [home.projectId])
  check.equal("the release refuses a house with no superintendent, or one who is no longer an active member, in the service and in the release transaction; with one assigned it queues", expected.expected, observed)
  return { orgId: org.orgId, packageId: home.packageId }
}

// ---------------------------------------------------------------------------
// 4. EP07-03: limits per person and per org, assignment past them audited.

async function assigningPastCapacity(kit, expected, check) {
  const { org } = await world(kit)
  try {
    return await assigningPastCapacityRun(kit, org, expected, check)
  } finally {
    // Leave the org as found even when a check throws: built-in limits, nobody holding these houses.
    const capacity = app("superintendent-capacity")
    await kit.as(org.team.starts, () => capacity.clearSuperintendentLimits(org.team.superintendent.userId))
    await kit.as(org.team.starts, () => capacity.setSuperintendentLimits({ userId: null, warnHouses: 10, maxHouses: 15 }))
    kit.sql(`update public.projects set superintendent_id=null where org_id=${kit.q(org.orgId)} and superintendent_id=${kit.q(org.team.superintendent.userId)}`)
  }
}

async function assigningPastCapacityRun(kit, org, expected, check) {
  const starts = app("starts"), capacity = app("superintendent-capacity")
  const person = org.team.superintendent
  const homes = []
  for (const index of [5, 6, 7]) homes.push(await specHome(kit, org, index))
  const fourth = await houseFixture(kit, org, "capacity-fourth")
  const base = housesOf(kit, org, person.userId)
  const limits = (userId, warnOver, maxOver) => kit.as(org.team.starts, () => capacity.setSuperintendentLimits({ userId, warnHouses: base + warnOver, maxHouses: base + maxOver }))
  const assign = (actor, home, reason) => kit.as(actor, () => starts.setProjectSuperintendent(home.projectId, person.userId, reason ? { overReason: reason } : {}))
  const observed = {}
  // The org default: stretched one house in, a limit of two.
  await limits(null, 1, 2)
  observed.first = (await assign(org.team.starts, homes[0])).assigned
  observed.second = (await assign(org.team.starts, homes[1])).assigned
  const third = await assign(org.team.starts, homes[2])
  observed.third = { assigned: third.assigned, requiresOverride: third.requiresOverride === true, canOverride: third.canOverride, houses: third.houses - base, limit: third.limit - base }
  observed.thirdStillUnassigned = one(kit, `select superintendent_id is null n from public.projects where id=${kit.q(homes[2].projectId)}`).n
  observed.projectLeadWithReason = await outcome(() => assign(org.projectLead, homes[2], "Covering the Kowalski house for two weeks"))
  observed.shortReason = await outcome(() => assign(org.team.starts, homes[2], "short"))
  const listed = (await kit.as(org.team.starts, () => starts.listSuperintendentCandidates())).find((row) => row.id === person.userId)
  observed.picker = { houses: listed.activeHouses - base, warnAt: listed.warnAt - base, limit: listed.limit - base, remaining: listed.remaining, load: listed.load }
  // The person's own numbers outrank the org default.
  await limits(person.userId, 3, 4)
  observed.withinOwnLimit = (await assign(org.team.starts, homes[2])).assigned
  // At that limit, a releaser goes past it with a reason, and the audit keeps why.
  await limits(person.userId, 1, 3)
  const atLimit = await kit.as(org.team.starts, () => starts.setProjectSuperintendent(fourth.projectId, person.userId))
  observed.atOwnLimit = atLimit.assigned
  const reason = "Covering a medical leave through the month"
  const override = await assign(org.team.starts, fourth, reason)
  observed.override = { assigned: override.assigned, overCapacity: override.overCapacity }
  const audited = one(kit, `select after_data->>'over_capacity' is_over, after_data->>'reason' reason from public.audit_log where entity_id=${kit.q(fourth.projectId)} and source='starts.superintendent_assigned' order by id desc limit 1`)
  observed.audit = { overCapacity: audited.is_over, reason: audited.reason === reason }
  observed.scoping = Number(one(kit, `select count(*)::int n from public.project_members where project_id=${kit.q(fourth.projectId)} and user_id=${kit.q(person.userId)}`).n)
  observed.limitsAreStartRelease = await outcome(() => kit.as(org.projectLead, () => capacity.setSuperintendentLimits({ userId: null, warnHouses: 5, maxHouses: 6 })))
  check.equal("a superintendent is assigned only up to their limit (their own, else the org default, else ten and fifteen); the next house answers with the limit instead of assigning, a releaser goes past it with a reason that the audit keeps, and nobody else can set limits", expected.expected, observed)
  return { orgId: org.orgId, projectId: fourth.projectId }
}

// ---------------------------------------------------------------------------
// 5. EP07-03: two assignments, one open slot.

async function raceAssignments(kit, expected, check) {
  const { org } = await world(kit)
  const person = org.team.superintendent
  const capacity = app("superintendent-capacity")
  const rounds = []
  for (let round = 0; round < 2; round += 1) {
    // Each round: the person runs one more house against a limit of two more, and two sessions each offer another.
    const a = await houseFixture(kit, org, `race-a-${round}`)
    const b = await houseFixture(kit, org, `race-b-${round}`)
    const held = await houseFixture(kit, org, `race-held-${round}`)
    const base = housesOf(kit, org, person.userId)
    await kit.as(org.team.starts, () => capacity.setSuperintendentLimits({ userId: person.userId, warnHouses: base + 1, maxHouses: base + 2 }))
    kit.sql(`update public.projects set superintendent_id=${kit.q(person.userId)} where id=${kit.q(held.projectId)}`)
    const script = (home) => serviceSession(`select public.assign_project_superintendent(${kit.q(org.orgId)},${kit.q(home.projectId)},${kit.q(person.userId)},${kit.q(org.team.starts.userId)},null)::text;`)
    const results = await race(kit, [script(a), script(b)])
    const answers = results.map((result) => (result.ok ? (/"assigned": ?true/.test(result.stdout) ? "assigned" : /"requires_override": ?true/.test(result.stdout) ? "needs override" : `UNRECOGNISED: ${result.stdout}`) : result.stderr))
    rounds.push({
      assigned: answers.filter((answer) => answer === "assigned").length,
      held: answers.filter((answer) => answer === "needs override").length,
      housesOverBase: housesOf(kit, org, person.userId) - base,
    })
    unassign(kit, [a.projectId, b.projectId, held.projectId])
  }
  await kit.as(org.team.starts, () => capacity.clearSuperintendentLimits(person.userId))
  check.equal("two sessions each assigning a house to a superintendent with one open slot: exactly one is assigned, the other is told the limit, and the person never runs more houses than their limit", expected.expected, { rounds })
  return { orgId: org.orgId }
}

/** A bare production house for capacity fixtures: a project with no package, opened as the starts desk would not. */
async function houseFixture(kit, org, name, divisionId = null) {
  const projectId = randomUUID()
  // Planning, as every house is until it releases: it counts against its superintendent from the day it is assigned.
  kit.sql(`insert into public.projects(id,org_id,name,status,phase,property_type,division_id,created_by) values(${kit.q(projectId)},${kit.q(org.orgId)},${kit.q(name)},'planning','precon','production',${divisionId ? kit.q(divisionId) : "null"},${kit.q(org.owner.userId)})`)
  return { projectId }
}

// ---------------------------------------------------------------------------
// 6. EP07-02: division and org caps count every community.

async function divisionCapSpansCommunities(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts"), flow = app("even-flow")
  // A week no earlier run on this stack has released into: scenario orgs are reused, and the caps count what is already there.
  // The week after every start this org has ever targeted: deterministic, and never one an earlier run released into.
  const latest = one(kit, `select coalesce(max(target_week), current_date)::text m from public.start_packages where org_id=${kit.q(org.orgId)}`).m
  const week = math().addWeeks(math().mondayOfIsoWeek(latest), 2)
  const weeksOut = Math.round((Date.parse(`${week}T00:00:00Z`) - Date.parse(`${math().mondayOfIsoWeek(day(0))}T00:00:00Z`)) / (7 * 86400000))
  // Fixture: a second community of the division that already released a house this week.
  const bayshore = randomUUID(), lot = randomUUID(), home = randomUUID()
  kit.sql(`insert into public.communities(id,org_id,name,code,division_id,status) values(${kit.q(bayshore)},${kit.q(org.orgId)},'Bayshore','BAY',${kit.q(org.divisionId)},'active');
insert into public.lots(id,org_id,community_id,division_id,lot_number,status) values(${kit.q(lot)},${kit.q(org.orgId)},${kit.q(bayshore)},${kit.q(org.divisionId)},'1','developed');
insert into public.projects(id,org_id,name,status,phase,property_type,created_by) values(${kit.q(home)},${kit.q(org.orgId)},'Bayshore 1','active','delivery','production',${kit.q(org.owner.userId)});
insert into public.start_packages(org_id,lot_id,community_id,project_id,status,target_week,scheduled_start_date,released_at,actual_start_date,released_by) values(${kit.q(org.orgId)},${kit.q(lot)},${kit.q(bayshore)},${kit.q(home)},'released',${kit.q(week)},${kit.q(week)},now(),${kit.q(week)},${kit.q(org.owner.userId)})`)
  const first = await specHome(kit, org, 8)
  await seed.assignSuperintendent(kit, org, { projectId: first.projectId })
  const observed = {}
  observed.targetByViewer = await outcome(() => kit.as(org.viewer, () => flow.setThroughputTarget({ weekStart: week, divisionId: org.divisionId, targetStarts: 1 })))
  await kit.as(org.team.starts, () => flow.setThroughputTarget({ weekStart: week, divisionId: org.divisionId, targetStarts: 1 }))
  const blocked = await kit.as(org.team.starts, () => starts.releaseStart(first.packageId, { scheduledStartDate: week }))
  observed.divisionBlocked = blocked.requiresConfirm ? { limit: blocked.slot.limit, exceeded: blocked.slot.exceeded } : blocked
  observed.packageStillReady = one(kit, `select status from public.start_packages where id=${kit.q(first.packageId)}`).status
  observed.shortReason = await outcome(() => kit.as(org.team.starts, () => starts.releaseStart(first.packageId, { scheduledStartDate: week, overTargetReason: "short" })))
  const reason = "Buyer's rate lock expires next week"
  const confirmed = await kit.as(org.team.starts, () => starts.releaseStart(first.packageId, { scheduledStartDate: week, overTargetReason: reason }))
  observed.confirmed = confirmed.released === true
  const audit = one(kit, `select after_data->>'over_slot' is_over, after_data->>'over_reason' reason from public.audit_log where entity_id=${kit.q(first.packageId)} and source='starts.release_queued' order by id desc limit 1`)
  observed.audit = { overSlot: audit.is_over, reason: audit.reason === reason }
  observed.event = Number(one(kit, `select count(*)::int n from public.events where entity_id=${kit.q(first.packageId)} and event_type='start.released_over_slot'`).n)
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(first.packageId)}`)
  // The org-wide cap counts the same houses: lifting the division's leaves the org's.
  await kit.as(org.team.starts, () => flow.setThroughputTarget({ weekStart: week, divisionId: org.divisionId, targetStarts: null }))
  await kit.as(org.team.starts, () => flow.setThroughputTarget({ weekStart: week, divisionId: null, targetStarts: 2 }))
  const second = await specHome(kit, org, 9)
  await seed.assignSuperintendent(kit, org, { projectId: second.projectId })
  const orgBlocked = await kit.as(org.team.starts, () => starts.releaseStart(second.packageId, { scheduledStartDate: week }))
  observed.orgBlocked = orgBlocked.requiresConfirm ? { limit: orgBlocked.slot.limit, exceeded: orgBlocked.slot.exceeded } : orgBlocked
  observed.deskCaps = (await kit.as(org.team.starts, () => flow.getThroughputWeeks({ weeksBack: 0, weeksAhead: weeksOut + 1 }))).filter((entry) => entry.weekStart === week).map((entry) => ({ scope: entry.scopeName, target: entry.target, filled: entry.filled }))
  await kit.as(org.team.starts, () => flow.setThroughputTarget({ weekStart: week, divisionId: null, targetStarts: null }))
  kit.sql(`update public.start_packages set status='cancelled' where id=${kit.q(first.packageId)};
update public.projects set superintendent_id=null where id in (${kit.q(first.projectId)},${kit.q(second.projectId)})`)
  check.equal("a division's or the organization's weekly throughput target counts the houses of every community it covers: a release past it answers with the limit that tripped, needs a reason of at least ten characters, and the reason is audited and on the event; only a start.slots holder sets targets", expected.expected, observed)
  return { orgId: org.orgId, packageId: first.packageId }
}

// ---------------------------------------------------------------------------
// 7. EP07-02: two releases into a cap of one.

async function raceReleasesIntoCap(kit, expected, check) {
  const { org } = await world(kit)
  const flow = app("even-flow")
  const rounds = []
  // Two future weeks, one round each, so the earlier round's releases do not count.
  for (let round = 0; round < 2; round += 1) {
    const week = math().addWeeks(math().mondayOfIsoWeek(day(0)), 3 + round)
    const a = await houseFixture(kit, org, `cap-a-${round}`), b = await houseFixture(kit, org, `cap-b-${round}`)
    const ready = []
    for (const house of [a, b]) {
      const lotId = randomUUID(), packageId = randomUUID()
      kit.sql(`insert into public.lots(id,org_id,community_id,division_id,project_id,lot_number,status) values(${kit.q(lotId)},${kit.q(org.orgId)},${kit.q(org.communityId)},${kit.q(org.divisionId)},${kit.q(house.projectId)},${kit.q(`cap-${packageId.slice(0, 6)}`)},'assigned');
update public.projects set superintendent_id=${kit.q(org.team.superintendent.userId)}, division_id=${kit.q(org.divisionId)} where id=${kit.q(house.projectId)};
insert into public.start_packages(id,org_id,lot_id,community_id,project_id,status,target_week) values(${kit.q(packageId)},${kit.q(org.orgId)},${kit.q(lotId)},${kit.q(org.communityId)},${kit.q(house.projectId)},'ready',${kit.q(week)})`)
      ready.push(packageId)
    }
    await kit.as(org.team.starts, () => flow.setThroughputTarget({ weekStart: week, divisionId: org.divisionId, targetStarts: 1 }))
    const script = (packageId) => serviceSession(`select public.queue_start_release(${kit.q(org.orgId)},${kit.q(packageId)},${kit.q(org.team.starts.userId)},${kit.q(week)}::date,${kit.q(week)}::date,99,false)::text;`)
    const results = await race(kit, ready.map(script))
    const answers = results.map((result) => (result.ok ? (/"queued": ?true/.test(result.stdout) ? "queued" : /"limit": ?"division"/.test(result.stdout) ? "held by division cap" : `UNRECOGNISED: ${result.stdout}`) : result.stderr))
    rounds.push({
      queued: answers.filter((answer) => answer === "queued").length,
      held: answers.filter((answer) => answer === "held by division cap").length,
      releasing: Number(one(kit, `select count(*)::int n from public.start_packages where id in (${ready.map((id) => kit.q(id)).join(",")}) and status='releasing'`).n),
    })
    kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id' in (${ready.map((id) => kit.q(id)).join(",")});
update public.start_packages set status='cancelled' where id in (${ready.map((id) => kit.q(id)).join(",")})`)
  }
    check.equal("two sessions releasing into a division cap of one in the same week: exactly one is queued and the other is held by the division cap, never both", expected.expected, { rounds })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 8. EP07-02 / EP07-03: nothing here is writable through the data API.

async function dataApiLockdown(kit, expected, check) {
  const { org } = await world(kit)
  const flow = app("even-flow"), capacity = app("superintendent-capacity")
  const week = math().addWeeks(math().mondayOfIsoWeek(day(0)), 6)
  const home = await houseFixture(kit, org, "lockdown")
  const observed = {}
  // The coordinator sets a slot through the service, and it is audited; the viewer's attempts all refuse.
  const audited = () => Number(one(kit, `select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='community_release_slot' and after_data->>'week_start'=${kit.q(week)}`).n)
  const auditedBefore = audited()
  await kit.as(org.team.starts, () => flow.setReleaseSlot(org.communityId, week, { targetStarts: 3 }))
  observed.slotAudited = audited() - auditedBefore
  observed.viewerSlotService = await outcome(() => kit.as(org.viewer, () => flow.setReleaseSlot(org.communityId, week, { targetStarts: 99 })))
  const viewerRest = {
    updateSlot: await rest(kit, org.viewer, (supabase) => supabase.from("community_release_slots").update({ target_starts: 99 }).eq("community_id", org.communityId).eq("week_start", week).select("id")),
    insertSlot: await rest(kit, org.viewer, (supabase) => supabase.from("community_release_slots").insert({ org_id: org.orgId, community_id: org.communityId, week_start: math().addWeeks(week, 1), target_starts: 99 })),
    insertTarget: await rest(kit, org.viewer, (supabase) => supabase.from("release_throughput_targets").insert({ org_id: org.orgId, week_start: week, target_starts: 0 })),
    insertLimit: await rest(kit, org.viewer, (supabase) => supabase.from("superintendent_capacity").insert({ org_id: org.orgId, warn_houses: 1, max_houses: 1 })),
    assignSuperintendent: await rest(kit, org.viewer, (supabase) => supabase.from("projects").update({ superintendent_id: org.viewer.userId }).eq("id", home.projectId).select("id")),
  }
  observed.viewer = Object.fromEntries(Object.entries(viewerRest).map(([key, value]) => [key, value === "allowed" ? "allowed" : "refused"]))
  observed.projectLeadSetsTarget = await outcome(() => kit.as(org.projectLead, () => flow.setThroughputTarget({ weekStart: week, divisionId: null, targetStarts: 5 })))
  observed.projectLeadSetsLimit = await outcome(() => kit.as(org.projectLead, () => capacity.setSuperintendentLimits({ userId: null, warnHouses: 2, maxHouses: 3 })))
  observed.slotUnchanged = Number(one(kit, `select target_starts n from public.community_release_slots where community_id=${kit.q(org.communityId)} and week_start=${kit.q(week)}`).n)
  observed.superintendentUnchanged = one(kit, `select superintendent_id is null n from public.projects where id=${kit.q(home.projectId)}`).n
  check.equal("slot targets, throughput targets, superintendent limits and the superintendent on a house are written only by the services that check permission and audit: a viewer's direct REST writes all refuse, and so does a role without start.slots or start.release", expected.expected, observed)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 8b. EP07-03 / EP07-13: a coordinator limited to one division.

async function divisionScopedCoordinator(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts"), capacity = app("superintendent-capacity"), flow = app("even-flow")
  const treasure = (await kit.as(org.owner, () => app("divisions").createDivision({ name: `Treasure Coast ${Date.now()}`, code: `T${String(Date.now()).slice(-5)}`, region: "Southeast Florida" }))).id
  const limited = kit.addMember(org, "org_starts_coordinator")
  const membershipId = one(kit, `select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(limited.userId)}`).id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId, role: "org_starts_coordinator", divisionScope: "assigned", divisionIds: [treasure] }))
  const gulfHouse = await houseFixture(kit, org, "scoped-gulf", org.divisionId)
  const treasureHouse = await houseFixture(kit, org, "scoped-treasure", treasure)
  const person = org.team.superintendent
  const observed = {}
  observed.outsideService = await outcome(() => kit.as(limited, () => starts.setProjectSuperintendent(gulfHouse.projectId, person.userId)))
  // The transaction refuses on its own, whatever the service read first.
  const direct = sqlAttempt(kit, `select public.assign_project_superintendent(${kit.q(org.orgId)},${kit.q(gulfHouse.projectId)},${kit.q(person.userId)},${kit.q(limited.userId)},null)`)
  observed.outsideTransaction = /outside your division access/.test(direct) ? "refused: outside division" : direct
  observed.outsideUnassigned = one(kit, `select superintendent_id is null n from public.projects where id=${kit.q(gulfHouse.projectId)}`).n
  observed.insideService = (await kit.as(limited, () => starts.setProjectSuperintendent(treasureHouse.projectId, person.userId))).assigned
  observed.orgDefault = await outcome(() => kit.as(limited, () => capacity.setSuperintendentLimits({ userId: null, warnHouses: 2, maxHouses: 3 })))
  observed.orgTarget = await outcome(() => kit.as(limited, () => flow.setThroughputTarget({ weekStart: math().addWeeks(math().mondayOfIsoWeek(day(0)), 8), divisionId: null, targetStarts: 4 })))
  // The picker counts the person's houses across every division, as the assignment does.
  kit.sql(`update public.projects set superintendent_id=${kit.q(person.userId)} where id=${kit.q(gulfHouse.projectId)}`)
  const listed = (await kit.as(limited, () => starts.listSuperintendentCandidates())).find((row) => row.id === person.userId)
  observed.pickerSeesOtherDivisionsHouses = listed.activeHouses === housesOf(kit, org, person.userId)
  unassign(kit, [gulfHouse.projectId, treasureHouse.projectId])
  check.equal("a coordinator limited to one division cannot assign a superintendent to another division's house (the service and the transaction both refuse), cannot set the org default limits or the org-wide throughput target, and sees the same house count the assignment enforces, across every division", expected.expected, observed)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 9. EP07-02: a start date's effect on a promised closing.

async function releaseImpactPreview(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts"), closings = app("closings")
  const buyer = { name: "Ines Duarte", email: "ines.duarte@acceptance.example.test" }
  const sold = await soldHome(kit, org, 2, buyer)
  const closingId = one(kit, `select id from public.closings where project_id=${kit.q(sold.projectId)} and status<>'cancelled'`).id
  await kit.as(org.owner, () => closings.scheduleClosing({ closingId, scheduledDate: day(100) }))
  const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(sold.lot.id, { isFinanced: true }))
  const detail = await kit.as(org.team.starts, () => starts.getStartPackage(pkg.id))
  const row = { id: detail.id, lotLabel: detail.lotLabel, closingDate: detail.sale.closingDate, cycleDays: detail.cycleDays }
  const today = day(0)
  const impacts = (startDate) => impact().closeImpacts([row], startDate).map((entry) => ({ closing: rel(entry.closingDate), projected: rel(entry.projectedClose), daysLate: entry.daysLate, slackDays: entry.slackDays }))[0]
  const observed = {
    sold: detail.sale.isSold, closing: rel(detail.sale.closingDate), cycleDays: detail.cycleDays, mustStartBy: rel(detail.mustStartBy),
    startToday: impacts(today),
    startNextMonth: impacts(day(30)),
    startInTheLastMonth: impacts(day(-30)),
    weekStartNextMonth: impact().startDateForWeek(math().addWeeks(math().mondayOfIsoWeek(today), 4), today) > today,
    lateHomes: impact().lateCloses(impact().closeImpacts([row], day(30))).length,
  }
  check.equal("a sold home's promised closing against its community's cycle: starting today projects the close the cycle after, and each start date later pushes it day for day, with the homes it pushes past their closing named", expected.expected, observed)
  return { orgId: org.orgId, packageId: pkg.id }
}

module.exports = {
  id: "FLOW-01",
  subcases: {
    "starts-financing-gate-holds-financed-sale-until-loan-approval-evidenced": financingGate,
    "starts-attested-evidence-archived-before-publication-blocks-release": attestedEvidenceArchived,
    "starts-release-without-superintendent-is-refused": releaseNeedsSuperintendent,
    "starts-assigning-past-capacity-is-refused-without-override": assigningPastCapacity,
    "race-two-assignments-to-the-last-open-capacity-slot": raceAssignments,
    "starts-division-throughput-cap-spans-communities": divisionCapSpansCommunities,
    "race-two-releases-into-one-throughput-cap": raceReleasesIntoCap,
    "starts-division-scoped-coordinator-cannot-assign-or-set-org-defaults": divisionScopedCoordinator,
    "starts-viewer-cannot-write-slots-or-targets-through-the-data-api": dataApiLockdown,
    "starts-release-impact-preview-matches-closing-schedule": releaseImpactPreview,
  },
}
