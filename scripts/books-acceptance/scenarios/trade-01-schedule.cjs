// TRADE-01 subcases for EP07-08 (trade responses) and EP07-09 (bulk reschedule). Composed into
// trade-01.cjs by the lead; each subcase is `async (kit, expected, check)` and acts through
// `kit.as`, so permissions and row security are the real ones:
//
//   trade-response-flow                 EP07-08  portal accept / decline / ask for dates; stale scope, wrong company and wrong home refused; coordinator closes; audit and event once
//   forged-confirmation-refused         EP07-08  a member's data-API write of confirmed_at is refused; the portal answer confirms; moving the dates lapses it
//   contested-resolve                   EP07-08  two coordinators close the same answer at once: one winner, one audit row
//   bulk-reschedule-close-impact        EP07-09  the server plan follows the later of two predecessors; a promised-close breach needs acceptance, a reason and start.release; audit per task
//
// Fixture: one production builder (`scheduleOrg`, built once per run) with one home whose schedule is
// Foundation and Framing both feeding Roofing, which feeds Handoff, closing on day 25, and a framing
// trade assigned to Framing. SQL is used only for the fixture rows (schedule, assignment, closing, no
// service writes them in this scope), the member's direct data-API attempts the database must refuse,
// and reads that check outcomes.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race, asMember } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
const named = (message, table) => {
  if (message === "allowed") return "allowed"
  for (const [label, pattern] of Object.entries(table)) if (pattern.test(message)) return label
  return message
}

const SCHEDULE_ORGS = new WeakMap()
async function scheduleOrg(kit) {
  if (!SCHEDULE_ORGS.has(kit)) SCHEDULE_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "TRADE-01 schedule" })
    org.homes = []
    return org
  })())
  return SCHEDULE_ORGS.get(kit)
}

/** A home with the dependency graph above, the framing trade assigned, and a close promised on day 25. */
async function scheduleHome(kit, label) {
  const org = await scheduleOrg(kit)
  const { q } = kit
  const projectId = randomUUID()
  const ids = { foundation: randomUUID(), framing: randomUUID(), roofing: randomUUID(), handoff: randomUUID() }
  const day = (offset) => seed.isoDay(offset)
  const item = (key, name, type, start, end) =>
    `insert into public.schedule_items(id,org_id,project_id,name,item_type,status,start_date,end_date) values(${q(ids[key])},${q(org.orgId)},${q(projectId)},${q(name)},${q(type)},'planned',${q(day(start))},${q(day(end))});`
  const dependency = (from, to) =>
    `insert into public.schedule_dependencies(org_id,project_id,item_id,depends_on_item_id,dependency_type,lag_days) values(${q(org.orgId)},${q(projectId)},${q(ids[to])},${q(ids[from])},'FS',0);`
  const company = org.vendorIds["Palmetto Framing"]
  kit.sql([
    "begin;",
    `insert into public.projects(id,org_id,name,property_type,status) values(${q(projectId)},${q(org.orgId)},${q(label)},'production','active');`,
    item("foundation", "Foundation", "task", 10, 12), item("framing", "Framing", "task", 10, 17),
    item("roofing", "Roofing", "task", 17, 19), item("handoff", "Handoff", "handoff", 20, 20),
    dependency("foundation", "roofing"), dependency("framing", "roofing"), dependency("roofing", "handoff"),
    `insert into public.schedule_assignments(org_id,project_id,schedule_item_id,company_id) values(${q(org.orgId)},${q(projectId)},${q(ids.framing)},${q(company)});`,
    `insert into public.closings(org_id,project_id,status,scheduled_date) values(${q(org.orgId)},${q(projectId)},'scheduled',${q(day(25))});`,
    "commit;",
  ].join("\n"))
  const token = await kit.as(org.owner, () => app("portal-access").createPortalAccessToken({ projectId, portalType: "sub", companyId: company, orgId: org.orgId }))
  return { org, projectId, ids, company, portalTokenId: token.id }
}

/** Days from today, so expectations do not depend on the day the stack runs. */
const offset = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${seed.isoDay(0)}T00:00:00Z`)) / 86400000)
const datesOf = (kit, itemId) => kit.rows(`select start_date::text s, end_date::text e from public.schedule_items where id=${kit.q(itemId)}`)[0]
const spanOf = (kit, itemId) => { const row = datesOf(kit, itemId); return { start: offset(row.s), end: offset(row.e) } }
const answer = (home, overrides) => app("trade-responses").respondToTradeWork({
  orgId: home.org.orgId, companyId: home.company, portalTokenId: home.portalTokenId, companyName: "Palmetto Framing",
  response: { scheduleItemId: home.ids.framing, response: "accepted", issuedStart: seed.isoDay(10), issuedEnd: seed.isoDay(17), ...overrides },
})
const openAnswers = (kit, home) => kit.rows(`select id, response, status, resolution from public.trade_work_responses where project_id=${kit.q(home.projectId)} order by responded_at, response`)

async function tradeResponseFlow(kit, expected, check) {
  const home = await scheduleHome(kit, "TRADE-01 response flow")
  const coordinator = home.org.team.starts, trades = app("trade-responses")
  const REFUSALS = { "dates changed": /dates changed/, "not assigned": /not assigned to your company/, "not part of link": /not part of this link/, "needs reason": /Tell the builder why/ }

  await answer(home, {})
  const confirmed = kit.rows(`select confirmed_at is not null c from public.schedule_assignments where schedule_item_id=${kit.q(home.ids.framing)}`)[0].c
  const stale = named(await attempt(() => answer(home, { issuedEnd: seed.isoDay(16) })), REFUSALS)
  const wrongCompany = named(await attempt(() => app("trade-responses").respondToTradeWork({
    orgId: home.org.orgId, companyId: home.org.vendorIds["Gulf Concrete"], portalTokenId: home.portalTokenId, companyName: "Gulf Concrete",
    response: { scheduleItemId: home.ids.framing, response: "accepted", issuedStart: seed.isoDay(10), issuedEnd: seed.isoDay(17) },
  })), REFUSALS)
  const wrongHome = named(await attempt(() => app("trade-responses").respondToTradeWork({
    orgId: home.org.orgId, companyId: home.company, portalTokenId: home.portalTokenId, companyName: "Palmetto Framing", projectId: randomUUID(),
    response: { scheduleItemId: home.ids.framing, response: "accepted", issuedStart: seed.isoDay(10), issuedEnd: seed.isoDay(17) },
  })), REFUSALS)
  const noReason = named(await attempt(() => answer(home, { response: "declined" })), REFUSALS)

  await answer(home, { response: "reschedule_requested", proposedStart: seed.isoDay(12), proposedEnd: seed.isoDay(19), reason: "Crew is on another job until day 12" })
  const lapsed = kit.rows(`select confirmed_at is null l from public.schedule_assignments where schedule_item_id=${kit.q(home.ids.framing)}`)[0].l
  const queue = await kit.as(coordinator, () => trades.listOpenTradeResponses({}))
  const queued = queue.rows.filter((row) => row.projectId === home.projectId).map((row) => ({ response: row.response, stale: row.stale }))
  const salesReads = await attempt(() => kit.as(home.org.team.sales, () => trades.listOpenTradeResponses({})))

  const declineTwice = await attempt(() => kit.as(coordinator, () => trades.resolveTradeResponse({ responseId: openAnswers(kit, home).find((row) => row.status === "open").id, resolution: "acknowledged" })))
  const request = openAnswers(kit, home).find((row) => row.status === "open")
  const preview = await kit.as(home.org.owner, () => trades.previewTradeReschedule(request.id))
  await kit.as(home.org.owner, () => trades.approveTradeReschedule({ responseId: request.id }))
  const after = datesOf(kit, home.ids.framing)
  const audits = Number(kit.rows(`select count(*)::int n from public.audit_log where entity_type='trade_work_response' and entity_id=${kit.q(request.id)}`)[0].n)
  const events = kit.rows(`select event_type, count(*)::int n from public.events where entity_id in (${openAnswers(kit, home).map((row) => kit.q(row.id)).join(",")}) group by 1 order by 1`)
  equal(check, "a trade's answers are bound to the dates it was given; the coordinator's approval moves the task through the bulk move and closes the request once", expected.expected.flow, {
    confirmed, stale, wrongCompany, wrongHome, noReason, confirmationLapsedOnNewRequest: lapsed, queued,
    salesReadsQueue: /start\.write|Missing permission/.test(salesReads) ? "refused" : salesReads,
    resolveMismatch: /resolution_kind_check/.test(declineTwice) ? "refused" : declineTwice,
    previewMoves: preview.changes.filter((change) => change.cause === "requested").map((change) => [change.newStart === seed.isoDay(12), change.newEnd === seed.isoDay(19)]),
    framingAfter: { start: after.s === seed.isoDay(12), end: after.e === seed.isoDay(19) },
    answers: openAnswers(kit, home).map((row) => `${row.response}:${row.status}:${row.resolution ?? "-"}`), audits, events,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function forgedConfirmationRefused(kit, expected, check) {
  const home = await scheduleHome(kit, "TRADE-01 forged confirmation")
  const sales = home.org.team.sales
  const run = (sql) => race(kit, [`${asMember(sales)} ${sql}`])
  const forgedUpdate = (await run(`update public.schedule_assignments set confirmed_at=now() where schedule_item_id='${home.ids.framing}';`))[0]
  const forgedInsert = (await run(`insert into public.schedule_assignments(org_id,project_id,schedule_item_id,company_id,confirmed_at) values('${home.org.orgId}','${home.projectId}','${home.ids.roofing}','${home.company}',now());`))[0]
  const confirmedBefore = kit.rows(`select confirmed_at is not null c from public.schedule_assignments where schedule_item_id=${kit.q(home.ids.framing)}`)[0].c
  await answer(home, {})
  const confirmedByPortal = kit.rows(`select confirmed_at is not null c from public.schedule_assignments where schedule_item_id=${kit.q(home.ids.framing)}`)[0].c
  await kit.as(home.org.team.superintendent, () => app("schedule").bulkUpdateScheduleItems({ items: [{ id: home.ids.framing, start_date: seed.isoDay(11), end_date: seed.isoDay(18) }] }, home.org.orgId))
  const lapsed = kit.rows(`select confirmed_at is null l from public.schedule_assignments where schedule_item_id=${kit.q(home.ids.framing)}`)[0].l
  const refused = (result) => (!result.ok && /confirms its own work/.test(result.stderr) ? "refused" : result.ok ? "allowed" : result.stderr)
  equal(check, "a member cannot write a trade's confirmation over the data API; only the portal answer confirms, and moving the dates lapses it", expected.expected.forged, {
    forgedUpdate: refused(forgedUpdate), forgedInsert: refused(forgedInsert), confirmedBefore, confirmedByPortal, lapsedAfterMove: lapsed,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function contestedResolve(kit, expected, check) {
  const home = await scheduleHome(kit, "TRADE-01 contested resolve")
  await answer(home, { response: "declined", reason: "Crew is on another job" })
  const request = openAnswers(kit, home).find((row) => row.status === "open")
  const owner = home.org.owner, coordinator = home.org.team.starts, trades = app("trade-responses")
  // Two API requests started in one tick are two PostgREST sessions.
  const settled = await Promise.allSettled([
    kit.as(owner, () => trades.resolveTradeResponse({ responseId: request.id, resolution: "acknowledged", note: "Reassigning" })),
    kit.as(coordinator, () => trades.resolveTradeResponse({ responseId: request.id, resolution: "acknowledged", note: "Reassigning" })),
  ])
  const audits = Number(kit.rows(`select count(*)::int n from public.audit_log where entity_type='trade_work_response' and entity_id=${kit.q(request.id)} and source='trades.response_resolved'`)[0].n)
  equal(check, "two coordinators closing one answer: exactly one wins, the other is told it was already closed, one audit row", expected.expected.contested, {
    winners: settled.filter((result) => result.status === "fulfilled").length,
    loser: settled.filter((result) => result.status === "rejected").map((result) => (/already closed/.test(result.reason.message) ? "already closed" : result.reason.message)),
    audits,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function bulkRescheduleCloseImpact(kit, expected, check) {
  const home = await scheduleHome(kit, "TRADE-01 bulk reschedule")
  const schedule = app("schedule"), orgId = home.org.orgId
  const superintendent = home.org.team.superintendent
  // The owner holds both schedule.edit and start.release; the starts coordinator has no schedule.edit.
  const coordinator = home.org.owner
  const slip = { items: [{ id: home.ids.foundation, start_date: seed.isoDay(25), end_date: seed.isoDay(27) }] }
  const REFUSALS = { "accept each close impact": /accept each close impact/, "needs a reason": /why the date moves past a promised close/, "needs start.release": /start\.release/, "changed by someone else": /changed by someone else/ }

  const preview = await kit.as(superintendent, () => schedule.previewScheduleReschedule(slip.items, orgId))
  const unaccepted = named(await attempt(() => kit.as(coordinator, () => schedule.bulkUpdateScheduleItems(slip, orgId))), REFUSALS)
  const noReason = named(await attempt(() => kit.as(coordinator, () => schedule.bulkUpdateScheduleItems({ ...slip, acknowledge_close_impacts: [home.projectId] }, orgId))), REFUSALS)
  const superintendentApplies = named(await attempt(() => kit.as(superintendent, () => schedule.bulkUpdateScheduleItems({ ...slip, acknowledge_close_impacts: [home.projectId], reason: "Foundation crew slipped two weeks" }, orgId))), REFUSALS)
  const untouched = spanOf(kit, home.ids.roofing)

  await kit.as(coordinator, () => schedule.bulkUpdateScheduleItems({ ...slip, acknowledge_close_impacts: [home.projectId], reason: "Foundation crew slipped two weeks" }, orgId))
  const moved = Object.fromEntries(["foundation", "roofing", "handoff"].map((key) => [key, spanOf(kit, home.ids[key])]))
  const audits = Number(kit.rows(`select count(*)::int n from public.audit_log where entity_type='schedule_item' and source='schedule.bulk_update' and entity_id in (${Object.values(home.ids).map((id) => kit.q(id)).join(",")})`)[0].n)
  const acknowledged = kit.rows(`select after_data->'acknowledged_close_impacts' a, after_data->>'reason' r from public.audit_log where source='schedule.bulk_update' and entity_id=${kit.q(home.ids.foundation)} order by id desc limit 1`)[0]
  equal(check, "the server plan makes Roofing wait for the later predecessor; a promised-close breach is refused until accepted, explained and authorised; the move lands whole with an audit row per task", expected.expected.bulk, {
    plan: preview.changes.map((change) => ({ name: change.name, cause: change.cause, start: offset(change.newStart), end: offset(change.newEnd) })),
    closeImpact: preview.closeImpacts.map((impact) => ({ finish: offset(impact.projectedFinish), daysLate: impact.daysLate })),
    unaccepted, noReason, superintendentCanApprove: preview.canApproveCloseImpacts, superintendentApplies, refusedMovesWroteNothing: untouched,
    moved, audits, acknowledgedThisHome: acknowledged.a[0] === home.projectId, reason: acknowledged.r,
  })
  return { orgId, projectId: home.projectId }
}

const subcases = {
  "trade-response-flow": tradeResponseFlow,
  "forged-confirmation-refused": forgedConfirmationRefused,
  "contested-resolve": contestedResolve,
  "bulk-reschedule-close-impact": bulkRescheduleCloseImpact,
}
module.exports = { subcases, helpers: { scheduleOrg, scheduleHome } }
