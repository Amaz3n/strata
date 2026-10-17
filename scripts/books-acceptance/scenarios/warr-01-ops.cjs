// WARR-01 warranty operations (EP11-03, EP11-04, EP11-05, EP11-06): routing and honest SLA clocks, visit
// scheduling with conflict authority, hand-off, buyer confirmation and rescheduling, a verifier who is
// not the person who recorded the work, a corrective queue for sent-back work, and partial settlement
// of a disputed backcharge. Every subcase acts as the owning role through the real services.
// Expected values are in expected/WARR-01.json, each derived by hand from the inputs named there.
const { randomUUID } = require("node:crypto")
const { asMember } = require("./sessions.cjs")
const { app } = require("./shared.cjs")

const completion = () => require("./lot-01-completion.cjs").helpers
const ops = () => app("warranty-operations")
const domain = () => app("warranty/domain")
const refuse = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const msg = (text, pattern) => (pattern.test(text) ? "refused" : text)
const equal = (check, label, expected, observed) => check.equal(label, expected, observed)
const hours = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 3600000)

const BUYER = { name: "Rosa Quintero", email: "rosa.quintero@acceptance.example.test" }
/** A sold home with the warranty team's roles ready; the team is NOT added to the home, so the read policy is what lets it work. */
async function home(kit, key, lotIndex, buyer = { name: `${BUYER.name} ${key}`, email: `${key}.${BUYER.email}` }) {
  const found = await completion().freshHome(kit, key, lotIndex, buyer)
  team(kit, found.org)
  return found
}

const members = new WeakMap()
/** Two technicians and a dispatcher who may write warranty work but not manage it, once per org. */
function team(kit, org) {
  if (members.has(org)) return members.get(org)
  kit.sql(`insert into public.roles(key,label,scope,description) select 'ep11_dispatcher','Warranty dispatcher','org','Writes warranty work; does not manage it' where not exists (select 1 from public.roles where key='ep11_dispatcher');
    insert into public.role_permissions(role_id,permission_key) select r.id,k from public.roles r, unnest(array['warranty.read','warranty.write','project.read']) k where r.key='ep11_dispatcher' and not exists (select 1 from public.role_permissions p where p.role_id=r.id and p.permission_key=k);
    update public.communities set time_zone='America/Chicago' where id=${kit.q(org.communityId)};`)
  const result = {
    manager: org.team.warranty, techA: kit.addMember(org, "org_warranty_manager"), techB: kit.addMember(org, "org_warranty_manager"),
    dispatcher: kit.addMember(org, "ep11_dispatcher"),
  }
  members.set(org, result)
  return result
}

const names = (people) => (id) => Object.entries(people).find(([, person]) => person.userId === id)?.[0] ?? (id === null ? null : "someone else")
const request = (kit, org, id) => kit.rows(`select id, status, severity, assigned_user_id, assigned_company_id, first_response_due_at, resolution_due_at, created_at, scheduled_date::text, closed_at, metadata from public.warranty_requests where org_id=${kit.q(org.orgId)} and id=${kit.q(id)}`)[0]
const visitRow = (kit, org, id) => kit.rows(`select id, status, assignee_kind, assigned_user_id, assigned_company_id, overlap_allowed, buyer_confirmed_at, buyer_reschedule_requested_at, buyer_reschedule_note, confirmed_at, completed_by, window_start, metadata from public.warranty_service_visits where org_id=${kit.q(org.orgId)} and id=${kit.q(id)}`)[0]
const events = (kit, org, entityId, like = "warranty%") => kit.rows(`select event_type, payload from public.events where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(entityId)} and event_type like ${kit.q(like)} order by created_at, id`)
const audits = (kit, org, entityId, source = null) => Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(entityId)} ${source ? `and source=${kit.q(source)}` : ""}`)[0].n)
const notices = (kit, org, visitId, who) => kit.rows(`select user_id, notification_type from public.notifications where org_id=${kit.q(org.orgId)} and payload::text like ${kit.q(`%${visitId}%`)}`).map((row) => `${who(row.user_id)}:${row.notification_type}`).sort()
const windowOf = (start, end) => ({ window_start: start, window_end: end })
const schedule = (kit, actor, requestId, assignee, window, extra = {}) => kit.as(actor, () => ops().scheduleWarrantyVisit({ request_id: requestId, assignee_kind: "tech", assigned_user_id: assignee.userId, ...window, ...extra }))
const newRequest = (kit, actor, projectId, title, extra = {}) => kit.as(actor, () => ops().createWarrantyRequest({ input: { project_id: projectId, title, severity: "routine_30", ...extra } }))

async function requestRoutesByCommunityAndTrade(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-route", 2)
  const t = team(kit, org), who = names({ techA: t.techA, techB: t.techB })
  const plumbing = org.costCodeIds["22-000"], trade = org.vendorIds["Coastal Plumbing"]
  const coordinator = await kit.as(t.manager, () => ops().saveWarrantyRoutingRule({ name: "Cypress coordinator", priority: 100, community_id: org.communityId, assignee_kind: "tech", assigned_user_id: t.techA.userId }))
  const plumbingRule = await kit.as(t.manager, () => ops().saveWarrantyRoutingRule({ name: "Plumbing trade", priority: 10, cost_code_id: plumbing, assignee_kind: "trade", assigned_company_id: trade }))
  const ruleName = (id) => [coordinator, plumbingRule].find((rule) => rule.id === id)?.name ?? null

  const both = await newRequest(kit, t.manager, projectId, "Slow drain at kitchen sink", { cost_code_id: plumbing })
  const bothRow = request(kit, org, both.id)
  const communityOnly = await newRequest(kit, t.manager, projectId, "Front door sticks")
  const communityOnlyRow = request(kit, org, communityOnly.id)

  // Reclassifying the door as plumbing work routes it again, to the trade as well.
  await kit.as(t.manager, () => ops().updateWarrantyRequest({ requestId: communityOnly.id, input: { cost_code_id: plumbing } }))
  const reclassified = request(kit, org, communityOnly.id)
  const routedTriggers = () => events(kit, org, communityOnly.id, "warranty_request_routed").map((event) => event.payload.trigger)
  const triggersAfterReclass = routedTriggers()

  // Taking it away from the rule's owner needs a reason; the override is recorded against the rule.
  const withoutReason = msg(await refuse(() => kit.as(t.manager, () => ops().updateWarrantyRequest({ requestId: communityOnly.id, input: { assigned_user_id: t.techB.userId } }))), /not going to the routed owner/)
  await kit.as(t.manager, () => ops().updateWarrantyRequest({ requestId: communityOnly.id, input: { assigned_user_id: t.techB.userId, routing_override_reason: "Tech A is on leave this week" } }))
  const overridden = request(kit, org, communityOnly.id)
  // A person's decision is not undone by a later reclassification; the clocks still follow the new severity.
  await kit.as(t.manager, () => ops().updateWarrantyRequest({ requestId: communityOnly.id, input: { severity: "emergency" } }))
  const afterManual = request(kit, org, communityOnly.id)

  equal(check, "a request goes to its community's coordinator and the trade its cost code maps to, with the 72 hour and 30 day clocks", expected.expected.communityAndTrade, {
    user: who(bothRow.assigned_user_id), company: bothRow.assigned_company_id === trade,
    rules: bothRow.metadata.routing.rules.map((rule) => `${rule.kind}:${ruleName(rule.rule_id)}`).sort(),
    firstResponseHours: hours(bothRow.created_at, bothRow.first_response_due_at), resolutionHours: hours(bothRow.created_at, bothRow.resolution_due_at),
  })
  equal(check, "a request with no cost code goes to the community coordinator only", expected.expected.communityOnly, {
    user: who(communityOnlyRow.assigned_user_id), company: communityOnlyRow.assigned_company_id, rule: ruleName(communityOnlyRow.metadata.routing.rule_id),
  })
  equal(check, "reclassifying it as plumbing routes it again to the trade and keeps the coordinator, each routing on the record", expected.expected.reclassified, {
    user: who(reclassified.assigned_user_id), company: reclassified.assigned_company_id === trade, triggers: triggersAfterReclass,
  })
  equal(check, "taking a rule-routed request elsewhere needs a reason, and the override names the rule it went against", expected.expected.override, {
    withoutReason, source: overridden.metadata.routing.source, user: who(overridden.assigned_user_id),
    overriddenRule: ruleName(overridden.metadata.routing.overridden_rule_id), reason: overridden.metadata.routing.override_reason,
    overrideEvents: events(kit, org, communityOnly.id, "warranty_request_routing_overridden").length,
  })
  equal(check, "a later severity change re-grades the clocks to 24 hours and 3 days without re-routing a manual assignment", expected.expected.afterManual, {
    user: who(afterManual.assigned_user_id), severity: afterManual.severity, firstResponseHours: hours(afterManual.created_at, afterManual.first_response_due_at),
    resolutionHours: hours(afterManual.created_at, afterManual.resolution_due_at), routedEvents: routedTriggers().length,
  })

  // Rules are an org setting; later subcases run unrouted.
  for (const rule of [coordinator, plumbingRule]) await kit.as(t.manager, () => ops().deleteWarrantyRoutingRule(rule.id))
  return { orgId: org.orgId, projectId, requestId: communityOnly.id }
}

async function breachSurvivesVisitAndSeverityChange(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-breach", 3)
  const t = team(kit, org)
  const states = (row) => ({ firstResponse: domain().warrantyFirstResponseState(row, new Date()), resolution: domain().warrantyResolutionState(row, new Date()) })
  const asRow = (id) => { const row = request(kit, org, id); return { ...row, first_response_due_at: row.first_response_due_at, resolution_due_at: row.resolution_due_at, closed_at: row.closed_at, status: row.status } }
  const finish = async (requestId, label) => {
    const visit = await schedule(kit, t.manager, requestId, t.techA, windowOf("2026-11-09T14:00:00Z", "2026-11-09T16:00:00Z"))
    await kit.as(t.dispatcher, () => ops().completeWarrantyVisit({ visit_id: visit.id, outcome: "resolved", outcome_note: `${label}: replaced the supply line` }))
    await kit.as(t.manager, () => ops().verifyWarrantyVisit(visit.id))
  }

  // A 30-day request opened 40 days ago: first response was due 37 days ago, resolution 10 days ago, nobody has swept it.
  const aged = await newRequest(kit, t.manager, projectId, "Water stain on ceiling")
  kit.sql(`update public.warranty_requests set created_at = now() - interval '40 days', first_response_due_at = now() - interval '37 days', resolution_due_at = now() - interval '10 days' where id=${kit.q(aged.id)}`)
  const pastDue = kit.rows(`select resolution_due_at from public.warranty_requests where id=${kit.q(aged.id)}`)[0].resolution_due_at
  // Re-grading to the 60-day target moves the due date into the future; the breach already incurred must stay.
  await kit.as(t.manager, () => ops().updateWarrantyRequest({ requestId: aged.id, input: { severity: "routine_60" } }))
  const regraded = asRow(aged.id)
  const inBreachedQueue = (await kit.as(t.manager, () => ops().listWarrantyRequestsForOrg({ slaState: "breached", pageSize: 100 }))).rows.some((row) => row.id === aged.id)
  await finish(aged.id, "Aged request")
  const resolved = asRow(aged.id)

  // A request never swept and never re-graded, resolved a day after its due date, still reports the late close.
  const late = await newRequest(kit, t.manager, projectId, "Cabinet hinge loose")
  kit.sql(`update public.warranty_requests set created_at = now() - interval '31 days', first_response_due_at = now() - interval '28 days', resolution_due_at = now() - interval '1 day' where id=${kit.q(late.id)}`)
  await finish(late.id, "Late request")
  const lateRow = asRow(late.id)

  equal(check, "re-grading a request that is already past due keeps the breach at its original due date, moves the due date out, and keeps it in the breached queue", expected.expected.regraded, {
    stampAtOriginalDue: Date.parse(regraded.metadata.sla_breached_at) === Date.parse(pastDue),
    dueMovedOut: Date.parse(regraded.resolution_due_at) > Date.now(), ...states(regraded), inBreachedQueue,
  })
  equal(check, "a visit that resolves the request does not clear the breach", expected.expected.afterVisit, {
    status: resolved.status, stampKept: Date.parse(resolved.metadata.sla_breached_at) === Date.parse(pastDue), ...states(resolved),
  })
  equal(check, "a request resolved after its due date reports breached from the facts even if nothing recorded it", expected.expected.lateClose, {
    status: lateRow.status, stamped: lateRow.metadata.sla_breached_at !== undefined, ...states(lateRow),
  })
  return { orgId: org.orgId, projectId, requestId: aged.id }
}

async function visitConflictNeedsReasonAndHandoffKeepsOwner(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-visit", 4)
  const t = team(kit, org), who = names({ techA: t.techA, techB: t.techB, dispatcher: t.dispatcher, manager: t.manager })
  const r = await newRequest(kit, t.manager, projectId, "Garage door rubs the frame")
  const first = windowOf("2026-11-03T03:30:00Z", "2026-11-03T05:30:00Z"), overlapping = windowOf("2026-11-03T04:30:00Z", "2026-11-03T06:30:00Z")
  const v1 = await schedule(kit, t.manager, r.id, t.techA, first)
  const scheduledDate = request(kit, org, r.id).scheduled_date

  const preflight = await kit.as(t.manager, () => ops().findWarrantyVisitConflicts({ assignee_kind: "tech", assigned_user_id: t.techA.userId, ...overlapping }))
  const noOverride = msg(await refuse(() => schedule(kit, t.manager, r.id, t.techA, overlapping)), /already booked/)
  const noReason = msg(await refuse(() => schedule(kit, t.manager, r.id, t.techA, overlapping, { allow_conflict: true })), /Say why/)
  const noAuthority = msg(await refuse(() => schedule(kit, t.dispatcher, r.id, t.techA, overlapping, { allow_conflict: true, conflict_reason: "Two-person lift" })), /Missing permission: warranty\.manage/)
  const v2 = await schedule(kit, t.manager, r.id, t.techA, overlapping, { allow_conflict: true, conflict_reason: "Two-person lift, same address" })
  const v2Row = visitRow(kit, org, v2.id)

  // Hand the first visit to the other technician: the window stays, the old owner stays in the history.
  const reasonMissing = msg(await refuse(() => kit.as(t.dispatcher, () => ops().reassignWarrantyVisit({ visit_id: v1.id, assignee_kind: "tech", assigned_user_id: t.techB.userId, reason: "" }))), /Say why/)
  await kit.as(t.dispatcher, () => ops().reassignWarrantyVisit({ visit_id: v1.id, assignee_kind: "tech", assigned_user_id: t.techB.userId, reason: "Tech A is out sick" }))
  const handed = visitRow(kit, org, v1.id)
  const history = handed.metadata.assignment_history
  const afterHandoff = notices(kit, org, v1.id, who)
  const handoffConflict = msg(await refuse(() => kit.as(t.dispatcher, () => ops().reassignWarrantyVisit({ visit_id: v2.id, assignee_kind: "tech", assigned_user_id: t.techB.userId, reason: "Balance the week" }))), /already booked/)
  const v2Owner = visitRow(kit, org, v2.id).assigned_user_id

  // A move and a cancel leave events, audits and notices for the assignee.
  await kit.as(t.dispatcher, () => ops().rescheduleWarrantyVisit({ visit_id: v1.id, ...windowOf("2026-11-04T15:00:00Z", "2026-11-04T17:00:00Z"), note: "Parts arrive Tuesday" }))
  await kit.as(t.dispatcher, () => ops().cancelWarrantyVisit(v2.id, "Homeowner fixed it"))
  const visits = await kit.as(t.manager, () => ops().listWarrantyVisitsForProject(projectId))
  const buyerView = await ops().listWarrantyVisitsForBuyerPortal(org.orgId, projectId)

  equal(check, "an overlapping booking is surfaced first, refused, needs a reason and warranty.manage, and then records who allowed it and why", expected.expected.conflict, {
    preflight: preflight.map((visit) => visit.visit_number), noOverride, noReason, noAuthority,
    overlapAllowed: v2Row.overlap_allowed, reason: v2Row.metadata.overlap_reason, overBooked: v2Row.metadata.overlap_with_visit_id === v1.id, allowedBy: who(v2Row.metadata.overlap_allowed_by),
  })
  equal(check, "the request date is the day at the house in the community's zone, not the UTC day", expected.expected.scheduledDate, { scheduledDate, zones: [...new Set(visits.map((visit) => visit.time_zone))], buyerZones: [...new Set(buyerView.map((visit) => visit.time_zone))] })
  equal(check, "a hand-off keeps the window, needs a reason, moves the owner, keeps the previous owner in the history, and tells both technicians", expected.expected.handoff, {
    reasonMissing, owner: who(handed.assigned_user_id), status: handed.status, windowKept: Date.parse(handed.window_start) === Date.parse(first.window_start),
    history: history.map((entry) => ({ from: who(entry.assigned_user_id), to: who(entry.handed_off_to_id), by: who(entry.handed_off_by), reason: entry.reason })),
    requestOwner: who(request(kit, org, r.id).assigned_user_id), notices: afterHandoff,
    events: events(kit, org, v1.id, "warranty_visit_reassigned").length,
  })
  equal(check, "a hand-off onto a booked technician is refused and the visit keeps its owner", expected.expected.handoffRefused, { handoffConflict, owner: who(v2Owner) })
  equal(check, "a reschedule and a cancel each leave an event, an audit row and a notice for the assignee", expected.expected.moveAndCancel, {
    rescheduleEvents: events(kit, org, v1.id, "warranty_visit_rescheduled").length, cancelEvents: events(kit, org, v2.id, "warranty_visit_canceled").length,
    v1Audits: audits(kit, org, v1.id), notices: notices(kit, org, v1.id, who), cancelNotices: notices(kit, org, v2.id, who),
  })
  return { orgId: org.orgId, projectId, requestId: r.id, visitId: v1.id }
}

async function homeownerConfirmsAndRescheduleIsTraced(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-buyer", 5)
  const { projectId: otherHome } = await home(kit, "warr-buyer-other", 6)
  const t = team(kit, org), who = names({ techA: t.techA, manager: t.manager, dispatcher: t.dispatcher })
  const contactId = randomUUID()
  kit.sql(`insert into public.contacts(id,org_id,full_name,metadata) values(${kit.q(contactId)},${kit.q(org.orgId)},'Rosa Quintero','{}')`)
  const r = await ops().createWarrantyRequestFromPortal({ orgId: org.orgId, projectId, contactId, input: { project_id: projectId, title: "Pantry shelf sagging", severity: "routine_30" } })
  const visit = await schedule(kit, t.manager, r.id, t.techA, windowOf("2026-11-05T14:00:00Z", "2026-11-05T16:00:00Z"))
  const buyer = { orgId: org.orgId, projectId, contactId, visitId: visit.id }

  const otherHomeRefused = msg(await refuse(() => ops().confirmWarrantyVisitByBuyer({ ...buyer, projectId: otherHome })), /not found/)
  await ops().confirmWarrantyVisitByBuyer(buyer)
  const confirmed = visitRow(kit, org, visit.id)
  const confirmAudits = audits(kit, org, visit.id, "buyer_portal")
  const noteMissing = msg(await refuse(() => ops().requestWarrantyVisitRescheduleByBuyer({ ...buyer, note: " " })), /what time works/)
  await ops().requestWarrantyVisitRescheduleByBuyer({ ...buyer, note: "Thursdays after 1 pm work better" })
  const asked = visitRow(kit, org, visit.id)
  await kit.as(t.dispatcher, () => ops().rescheduleWarrantyVisit({ visit_id: visit.id, ...windowOf("2026-11-05T19:00:00Z", "2026-11-05T21:00:00Z"), note: "Moved to the afternoon" }))
  const moved = visitRow(kit, org, visit.id)
  const trace = events(kit, org, visit.id, "warranty_visit%")
  const confirmEvent = trace.find((event) => event.event_type === "warranty_visit_buyer_confirmed"), askEvent = trace.find((event) => event.event_type === "warranty_visit_buyer_reschedule_requested")
  const heard = (type) => kit.rows(`select distinct user_id from public.notifications where org_id=${kit.q(org.orgId)} and notification_type=${kit.q(type)} and payload::text like ${kit.q(`%${visit.id}%`)}`).map((row) => who(row.user_id)).sort()

  equal(check, "the homeowner's confirmation is recorded with when and by which contact, and the owner and the managers are told", expected.expected.confirmed, {
    otherHomeRefused, confirmed: confirmed.buyer_confirmed_at !== null, contact: confirmMatches(confirmEvent, contactId), audits: confirmAudits, told: heard("warranty_visit_buyer_confirmed").includes("techA") && heard("warranty_visit_buyer_confirmed").includes("manager"),
  })
  equal(check, "asking for another time needs a note, withdraws the confirmation, and is traced with the note and the contact", expected.expected.asked, {
    noteMissing, confirmedCleared: asked.buyer_confirmed_at === null, requestedAt: asked.buyer_reschedule_requested_at !== null, note: asked.buyer_reschedule_note,
    contact: confirmMatches(askEvent, contactId), told: heard("warranty_buyer_reschedule_requested").includes("techA"),
  })
  equal(check, "the office move resets the buyer's answer and the whole story is in order on the visit", expected.expected.moved, {
    status: moved.status, buyerAnswerCleared: [moved.buyer_confirmed_at, moved.buyer_reschedule_requested_at, moved.buyer_reschedule_note], trace: trace.map((event) => event.event_type),
    totalAudits: audits(kit, org, visit.id),
  })
  return { orgId: org.orgId, projectId, requestId: r.id, visitId: visit.id }
}
const confirmMatches = (event, contactId) => event?.payload?.contact_id === contactId

async function verifierMustDifferAndRejectsToQueue(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-verify", 7)
  const t = team(kit, org), who = names({ dispatcher: t.dispatcher, manager: t.manager, techA: t.techA })
  const slot = (day) => windowOf(`2026-11-${day}T14:00:00Z`, `2026-11-${day}T16:00:00Z`)
  const complete = async (requestId, day) => {
    const visit = await schedule(kit, t.manager, requestId, t.techA, slot(day))
    await kit.as(t.dispatcher, () => ops().completeWarrantyVisit({ visit_id: visit.id, outcome: "resolved", outcome_note: "Re-sealed the trap" }))
    return visit
  }

  const r1 = await newRequest(kit, t.manager, projectId, "Trap leaks at vanity")
  const v1 = await complete(r1.id, "10")
  const completed = visitRow(kit, org, v1.id)
  const waiting = request(kit, org, r1.id).metadata.pending_verification === true
  const selfVerify = msg(await refuse(() => kit.as(t.dispatcher, () => ops().verifyWarrantyVisit(v1.id))), /second person/)
  const refusedEvents = events(kit, org, v1.id, "warranty_visit_verification_refused").map((event) => event.payload.reason)
  const stillWaiting = request(kit, org, r1.id).metadata.pending_verification === true && request(kit, org, r1.id).status === "in_progress"
  await kit.as(t.manager, () => ops().verifyWarrantyVisit(v1.id))
  const verified = request(kit, org, r1.id)
  const evidence = kit.rows(`select (select count(*)::int from public.warranty_visit_photos where visit_id=${kit.q(v1.id)}) photos, buyer_signoff_name from public.warranty_service_visits where id=${kit.q(v1.id)}`)[0]

  // A second request is completed, then sent back by the office.
  const r2 = await newRequest(kit, t.manager, projectId, "Ceiling patch cracked again")
  const v2 = await complete(r2.id, "11")
  const queue = async (slaState) => (await kit.as(t.manager, () => ops().listWarrantyRequestsForOrg({ slaState, pageSize: 100 }))).rows.some((row) => row.id === r2.id)
  const verifyList = async () => (await kit.as(t.manager, () => ops().listWarrantyVisitsPendingVerification({ pageSize: 100 }))).rows.some((row) => row.request?.id === r2.id)
  const beforeSendBack = { sentBack: await queue("sent_back"), awaitingVerification: await verifyList() }
  const noReason = msg(await refuse(() => kit.as(t.manager, () => ops().rejectWarrantyVisitCompletion(v2.id, " "))), /Say why/)
  await kit.as(t.manager, () => ops().rejectWarrantyVisitCompletion(v2.id, "Crack is back along the seam"))
  const sent = request(kit, org, r2.id)
  const afterSendBack = { sentBack: await queue("sent_back"), awaitingVerification: await verifyList(), status: sent.status, reason: sent.metadata.rejection_reason }
  // The corrective visit is completed: it leaves the corrective queue and waits for verification again.
  await complete(r2.id, "12")
  const afterCorrective = { sentBack: await queue("sent_back"), awaitingVerification: await verifyList() }

  equal(check, "work recorded as done waits for verification, and the person who recorded it cannot verify it", expected.expected.selfVerify, {
    completedBy: who(completed.completed_by), waiting, selfVerify, refusedEvents, refusedAudits: audits(kit, org, v1.id, "warranty_verification_refused"), stillWaiting,
  })
  equal(check, "a second person verifies it, and evidence, buyer sign-off and verification are separate records", expected.expected.verified, {
    status: verified.status, verifiedBy: who(verified.metadata.verified_by), pending: verified.metadata.pending_verification, photos: evidence.photos, buyerSignoff: evidence.buyer_signoff_name,
  })
  equal(check, "work sent back needs a reason, lands in the corrective queue, and leaves it when the corrective visit is completed", expected.expected.sentBack, { beforeSendBack, noReason, afterSendBack, afterCorrective })
  return { orgId: org.orgId, projectId, requestId: r2.id }
}

async function backchargePartialSettlement(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-backcharge", 8)
  const t = team(kit, org), who = names({ dispatcher: t.dispatcher, manager: t.manager })
  const trade = org.vendorIds["Coastal Plumbing"]
  const r = await newRequest(kit, t.manager, projectId, "Supply line failed behind the vanity")
  const draft = (reason) => kit.as(t.manager, () => ops().createWarrantyBackcharge({
    project_id: projectId, warranty_request_id: r.id, company_id: trade, amount_cents: 45000, reason, confirm_no_ap_history: true,
    cost_basis: [{ label: "Plumber callback", amount_cents: 30000 }, { label: "Drywall patch", amount_cents: 15000 }],
  }))
  const bills = (number) => kit.rows(`select bill_number, total_cents::bigint total from public.vendor_bills where org_id=${kit.q(org.orgId)} and company_id=${kit.q(trade)} and bill_number=${kit.q(number)}`).map((row) => Number(row.total))
  const backcharge = async (id) => kit.rows(`select status, amount_cents::bigint amount, recovered_cents::bigint recovered, vendor_credit_bill_id, metadata from public.warranty_backcharges where id=${kit.q(id)}`)[0]

  const first = await draft("Failed supply line")
  const issued = await kit.as(t.manager, () => ops().issueWarrantyBackcharge({ backchargeId: first.id }))
  const number = issued.backcharge_number
  await kit.as(t.manager, () => ops().disputeWarrantyBackcharge({ backchargeId: first.id, note: "Trade says the line was installed correctly" }))
  const refusals = {
    dispatcherSettles: msg(await refuse(() => kit.as(t.dispatcher, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "settled", recoveredCents: 30000, note: "Agreed" }))), /Missing permission/),
    aboveIssued: msg(await refuse(() => kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "settled", recoveredCents: 50000, note: "Agreed" }))), /invalid/),
    atIssued: msg(await refuse(() => kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "settled", recoveredCents: 45000, note: "Agreed" }))), /less than the issued amount/),
    noReason: msg(await refuse(() => kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "settled", recoveredCents: 30000 }))), /resolution note is required/),
    fullRecoveryForLess: msg(await refuse(() => kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "recovered", recoveredCents: 30000 }))), /fully recovered/),
  }
  const stillDisputed = (await backcharge(first.id)).status
  const settled = await kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "settled", recoveredCents: 30000, note: "Agreed at the job meeting" }))
  const row = await backcharge(first.id)
  const again = msg(await refuse(() => kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: first.id, resolution: "waived", note: "Too late" }))), /cannot move/)

  // Re-issuing after a dispute reuses the credit the first issue created, then a waiver reverses it in full.
  const second = await draft("Failed shutoff valve")
  const secondIssued = await kit.as(t.manager, () => ops().issueWarrantyBackcharge({ backchargeId: second.id }))
  await kit.as(t.manager, () => ops().disputeWarrantyBackcharge({ backchargeId: second.id, note: "Valve was owner-supplied" }))
  const reissued = await kit.as(t.manager, () => ops().issueWarrantyBackcharge({ backchargeId: second.id }))
  const secondNumber = secondIssued.backcharge_number
  const waived = await kit.as(t.manager, () => ops().resolveWarrantyBackcharge({ backchargeId: second.id, resolution: "waived", note: "Goodwill to the trade" }))

  equal(check, "a settlement above the issued amount, at it, without a reason, without authority, or as full recovery is refused and changes nothing", expected.expected.refusals, { ...refusals, stillDisputed })
  equal(check, "a dispute settled for $300 of $450 records $300 collected and $150 given up with who decided and why, and reverses only the $150 remainder", expected.expected.settled, {
    status: settled.status, recovered: settled.recovered_cents, settlement: { settled: settled.settlement.settled_cents, writtenOff: settled.settlement.written_off_cents, reason: settled.settlement.reason, by: who(settled.settlement.settled_by) },
    creditCents: bills(`WB-${number}`), reversalCents: bills(`WB-${number}-R`), creditKept: row.vendor_credit_bill_id === issued.vendor_credit_bill_id, terminal: again,
  })
  equal(check, "re-issuing after a dispute reuses the one vendor credit, and waiving then reverses the full amount once", expected.expected.reissue, {
    sameCredit: reissued.vendor_credit_bill_id === secondIssued.vendor_credit_bill_id, creditBills: bills(`WB-${secondNumber}`).length, status: waived.status, recovered: waived.recovered_cents, reversalCents: bills(`WB-${secondNumber}-R`),
    events: events(kit, org, second.id, "warranty_backcharge%").map((event) => event.event_type),
  })
  return { orgId: org.orgId, projectId, backchargeId: first.id }
}

/** Rows a member's own data-API statement changed (or saw), in a session that is rolled back. */
function memberCount(kit, actor, statement) {
  const out = kit.sql(`${asMember(actor)}\nbegin;\n${statement}\nrollback;`).split("\n").filter(Boolean)
  return Number(out[out.length - 1])
}

async function memberWritesAreFencedAndManagersSeeTheirHomes(kit, expected, check) {
  const { org, projectId } = await home(kit, "warr-fence", 9)
  const t = team(kit, org), land = org.team.land
  const r = await newRequest(kit, t.manager, projectId, "Window latch broken")
  const visit = await schedule(kit, t.manager, r.id, t.techA, windowOf("2026-11-16T14:00:00Z", "2026-11-16T16:00:00Z"))
  const charge = await kit.as(t.manager, () => ops().createWarrantyBackcharge({
    project_id: projectId, warranty_request_id: r.id, company_id: org.vendorIds["Coastal Plumbing"], amount_cents: 45000, reason: "Latch hardware", confirm_no_ap_history: true,
    cost_basis: [{ label: "Hardware and labor", amount_cents: 45000 }],
  }))
  const q = kit.q
  const seen = (actor) => ["warranty_requests", "warranty_service_visits", "warranty_backcharges"].map((table) => memberCount(kit, actor, `select count(*) from public.${table} where project_id=${q(projectId)};`))
  const changed = (actor, table, id, set) => memberCount(kit, actor, `with u as (update public.${table} set ${set} where id=${q(id)} returning 1) select count(*) from u;`)
  const writes = {
    requestResolved: changed(t.manager, "warranty_requests", r.id, "status='resolved', closed_at=now()"),
    requestVerified: changed(t.manager, "warranty_requests", r.id, `metadata=metadata||'{"verified_by":"${t.manager.userId}","sent_back":false}'::jsonb`),
    requestDueMoved: changed(t.manager, "warranty_requests", r.id, "resolution_due_at=now()+interval '400 days'"),
    visitCompletedBy: changed(t.dispatcher, "warranty_service_visits", visit.id, `status='completed', completed_by='${t.dispatcher.userId}'`),
    visitOverlap: changed(t.dispatcher, "warranty_service_visits", visit.id, "overlap_allowed=true"),
    backchargeStatus: changed(t.manager, "warranty_backcharges", charge.id, "status='recovered', recovered_cents=45000"),
    backchargeAmount: changed(land, "warranty_backcharges", charge.id, "amount_cents=1000"),
  }
  const row = kit.rows(`select (select status from public.warranty_requests where id=${q(r.id)}) request_status, (select status from public.warranty_service_visits where id=${q(visit.id)}) visit_status, (select completed_by from public.warranty_service_visits where id=${q(visit.id)}) completed_by, b.status backcharge_status, b.amount_cents::bigint amount from public.warranty_backcharges b where b.id=${q(charge.id)}`)[0]
  equal(check, "a manager who is not on the home sees its requests, visits and backcharges; a dispatcher sees the requests and visits; an unrelated member sees none", expected.expected.reads, { land: seen(land), manager: seen(t.manager), dispatcher: seen(t.dispatcher) })
  equal(check, "no member's own data-API write moves a request, a visit or a backcharge, whatever warranty permissions they hold, and nothing changed", expected.expected.writes, {
    writes, unchanged: { requestStatus: row.request_status, visitStatus: row.visit_status, completedBy: row.completed_by, backchargeStatus: row.backcharge_status, amount: Number(row.amount) },
  })
  return { orgId: org.orgId, projectId, requestId: r.id }
}

module.exports = {
  subcases: {
    "request-routes-by-community-and-trade": requestRoutesByCommunityAndTrade,
    "breach-survives-visit-and-severity-change": breachSurvivesVisitAndSeverityChange,
    "visit-conflict-needs-reason-and-handoff-keeps-owner": visitConflictNeedsReasonAndHandoffKeepsOwner,
    "homeowner-confirms-and-reschedule-is-traced": homeownerConfirmsAndRescheduleIsTraced,
    "verifier-must-differ-and-rejects-to-queue": verifierMustDifferAndRejectsToQueue,
    "backcharge-partial-settlement": backchargePartialSettlement,
    "member-writes-are-fenced-and-managers-see-their-homes": memberWritesAreFencedAndManagersSeeTheirHomes,
  },
}
