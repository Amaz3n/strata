// ROLE-01 — the production role matrix (EP14-06). One production builder with two
// divisions, Gulf Coast (Cypress Landing) and Treasure Coast (Seagrape Hammock), each
// with developed lots and a home, all made through Arc's own services. Every production
// role, a manager limited to Gulf Coast, a member whose role is taken away while they
// are signed in, and another builder's owner try one representative mutation on every
// production desk — land, sales, starts, purchasing, design studio, field and warranty —
// through the services the desk's server actions call, and then straight against the
// data API with their own database session (row-level security and write guards).
//
//   desk-mutations-follow-the-role-catalog     each desk's mutation succeeds for the roles that
//                                              hold its key and is refused, cleanly, for the rest
//   division-and-org-walls-hold-for-mutations  a Gulf Coast manager mutates Gulf Coast and nothing
//                                              of Treasure Coast; another org reaches neither
//   stale-role-is-refused-mid-session          a role change or a revoked key takes effect on the
//                                              member's very next request, same session
//   data-api-writes-are-fenced                 the same writes straight through PostgREST
//   creator-cannot-approve-own-purchase-order  maker/checker on the purchasing desk
//
// Both homes are staffed as production staffs them: the superintendent holds a field seat
// (assigned through the starts service), the purchasing manager and the project lead a
// project-manager seat; every other role works from its organization role alone.
// Concurrent money writers are RACE-02 / RACE-03 (see the expected file for the list).
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const context = () => require("../../../lib/services/context")

// A refusal is clean when it tells the person what they lack or that the record is not
// theirs. Raw database or runtime text reaching a person is an error, not a refusal. The
// reason is part of the cell: a missing permission names its key, and any other refusal
// carries its message, so a "not found" never passes for a permission refusal.
const RAW = /violates|row-level security|PGRST|syntax error|TypeError|ReferenceError|undefined|null value|duplicate key|invalid input syntax|relation "|column "|Failed to [a-z]+ [a-z ]+: /i
async function outcome(work) {
  try { await work(); return { result: "allowed" } }
  catch (error) {
    const message = String(error?.message ?? error)
    if (RAW.test(message)) return { result: `error: ${message.slice(0, 200)}`, message }
    const missing = /Missing permission: ([a-z_]+\.[a-z_]+)/.exec(message)
    return { result: missing ? `refused: missing ${missing[1]}` : `refused: ${message.slice(0, 160)}`, message }
  }
}

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function side(kit, org, { divisionId, communityId, prefix, street }) {
  const lots = app("lots")
  const numbers = Array.from({ length: 16 }, (_, i) => `${prefix}${i + 1}`)
  await kit.as(org.owner, () => lots.createLots(communityId, { lots: numbers.map((lotNumber, i) => ({ lotNumber, status: "developed", address: `${200 + i * 2} ${street}` })) }))
  const lotIds = kit.rows(`select id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(communityId)} and lot_number like ${kit.q(`${prefix}%`)} order by created_at, lot_number`).map((row) => row.id)
  const home = await kit.as(org.owner, () => app("projects").createProject({ input: { name: `${street} lot ${prefix}1`, property_type: "production", status: "active", phase: "delivery", division_id: divisionId } }))
  await kit.as(org.owner, () => lots.attachProjectToLot(lotIds[0], home.id))
  return { divisionId, communityId, homeId: home.id, homeLotId: lotIds[0], freeLots: lotIds.slice(1) }
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "ROLE-01 production role matrix", lots: 2 })
  await seed.seedCommunity(kit, org)
  const gulf = await side(kit, org, { divisionId: org.divisionId, communityId: org.communityId, prefix: "G", street: "Cypress Landing Way" })
  const treasureDivision = await kit.as(org.owner, () => app("divisions").createDivision({ name: "Treasure Coast", code: "TC", region: "Southeast Florida" }))
  const treasureCommunity = await kit.as(org.owner, () => app("communities").createCommunity({ name: "Seagrape Hammock", code: "SGH", divisionId: treasureDivision.id, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 16, targetAbsorptionPerMonth: 1 }))
  const treasure = await side(kit, org, { divisionId: treasureDivision.id, communityId: treasureCommunity.id, prefix: "T", street: "Seagrape Hammock Way" })

  // A project lead (lots, starts, purchase orders, daily logs, punch) limited by the
  // owner to Gulf Coast through the team service, the way an administrator does it.
  const manager = kit.addMember(org, "org_project_lead")
  manager.membershipId = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(manager.userId)}`)[0].id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId: manager.membershipId, role: "org_project_lead", divisionScope: "assigned", divisionIds: [gulf.divisionId] }))

  const foreign = kit.organization({ name: "ROLE-01 another builder", chart: [], productTier: "production" })
  const actors = { owner: org.owner, ...org.team, divisionManager: manager }
  // Staffing both homes the way production staffs them: the starts coordinator assigns
  // the superintendent (a field seat, through the starts service); the purchasing manager
  // and the project lead take a project-manager seat (fixture, written directly as SEC-01
  // does: adding a team member is a page action, not a service). Everyone else works
  // from their organization role alone, which is what the matrix is about.
  for (const projectId of [gulf.homeId, treasure.homeId]) {
    await kit.as(org.team.starts, () => app("starts").setProjectSuperintendent(projectId, org.team.superintendent.userId))
    for (const actor of [org.team.purchasing, manager])
      kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(actor.userId)},id,'active' from public.roles where scope='project' and key='pm' on conflict do nothing`)
  }
  return { org, gulf, treasure, manager, foreign, actors }
}

// One week-start (Monday) a few weeks out, so a slot never collides with a release.
function mondayIn(weeks) {
  const day = new Date(`${seed.isoDay(weeks * 7)}T12:00:00Z`)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

/**
 * The representative mutation of every production desk, aimed at one side (division).
 * Each call makes fresh inputs, so a success never blocks the next actor; a start
 * package takes a lot of its own from the side's pool.
 */
function deskMutations(kit, w) {
  const tag = () => randomUUID().slice(0, 8)
  return {
    "land: create a community": (s) => app("communities").createCommunity({ name: `Role community ${tag()}`, divisionId: s.divisionId, status: "planning", plannedLotCount: 10, targetAbsorptionPerMonth: 1 }),
    "land: add lots to a community": (s) => app("lots").createLots(s.communityId, { lots: [{ lotNumber: `R${tag()}`, status: "controlled" }] }),
    "land: open a land deal": (s) => app("land-opportunities").createLandOpportunity({ name: `Role parcel ${tag()}`, divisionId: s.divisionId, city: "Naples", state: "FL", plannedLotCount: 20 }),
    "sales: register a walk-in buyer": (s) => app("sales-inquiries").registerProductionInquiry({ buyerName: `Role Buyer ${tag()}`, email: `role-${tag()}@acceptance.example.test`, communityId: s.communityId, channel: "walk_in", loggedDate: seed.isoDay(0) }),
    "starts: open a start package": (s) => app("starts").openStartPackage(s.freeLots.shift(), { isFinanced: false }),
    "starts: set a release slot": (s) => app("even-flow").setReleaseSlot(s.communityId, mondayIn(6), { targetStarts: 3, notes: "ROLE-01" }),
    "purchasing: write a purchase order": (s) => app("commitments").createCommitment({ input: { project_id: s.homeId, company_id: w.org.vendorIds["Gulf Concrete"], commitment_type: "purchase_order", title: `Role order ${tag()}`, total_cents: 120000 } }),
    "design studio: add a catalog category": () => app("option-catalog").upsertCategory({ name: `Role category ${tag()}`, sortOrder: 50 }),
    "field: write a daily log": (s) => app("daily-logs").createDailyLog({ input: { project_id: s.homeId, date: seed.isoDay(0), summary: `Role walk ${tag()}`, weather: { conditions: "Sunny", temperature: "84F" } } }),
    "field: open a punch item": (s) => app("punch-lists").createProjectPunchItem(s.homeId, { title: `Role punch ${tag()}` }),
    "warranty: open a warranty request": (s) => app("warranty-operations").createWarrantyRequest({ input: { project_id: s.homeId, title: `Role claim ${tag()}`, description: "Caulk separating at the tub.", severity: "routine_30" } }),
  }
}
// Mutations that name no record of a division (the catalog is organization-wide).
const ORG_WIDE = new Set(["design studio: add a catalog category"])

// ---------------------------------------------------------------------------
// 1. Each desk's mutation follows the role catalog.

async function deskMutationsFollowTheRoleCatalog(kit, expected, check) {
  const w = await world(kit)
  const mutations = deskMutations(kit, w)
  const matrix = {}, messages = {}
  // Refusals first, the role that holds the key last: a refusal is never explained by
  // an earlier success having used the record up.
  const order = ["land", "sales", "starts", "purchasing", "design", "superintendent", "warranty", "owner"]
  for (const [name, mutate] of Object.entries(mutations)) {
    matrix[name] = {}
    for (const role of order) {
      const seen = await outcome(() => kit.as(w.actors[role], () => mutate(w.gulf)))
      matrix[name][role] = seen.result
      if (seen.message) messages[`${name} / ${role}`] = seen.message
    }
  }
  check.equal("every desk's representative mutation succeeds for the owner and the roles whose catalog grants its key, and every other production role is refused with a clean message (no database or runtime text)", expected.expected, matrix)
  return { orgId: w.org.orgId, messages }
}

// ---------------------------------------------------------------------------
// 2. The division wall and the org wall hold for mutations.

async function divisionAndOrgWallsHoldForMutations(kit, expected, check) {
  const w = await world(kit)
  const mutations = deskMutations(kit, w)
  const observed = { divisionManager: { gulf: {}, treasure: {} }, foreignOwner: {} }
  const messages = {}
  const record = (bucket, name, seen) => { bucket[name] = seen.result; if (seen.message) messages[name] = seen.message }
  for (const [name, mutate] of Object.entries(mutations)) {
    if (ORG_WIDE.has(name)) continue
    record(observed.divisionManager.treasure, name, await outcome(() => kit.as(w.manager, () => mutate(w.treasure))))
    record(observed.divisionManager.gulf, name, await outcome(() => kit.as(w.manager, () => mutate(w.gulf))))
    record(observed.foreignOwner, name, await outcome(() => kit.as(w.foreign.owner, () => mutate(w.gulf))))
  }
  // Nothing the foreign owner tried landed in this org, nor in theirs pointing at ours.
  const strays = kit.rows(`select 'commitments' t, count(*)::int n from public.commitments where org_id=${kit.q(w.foreign.orgId)}
    union all select 'daily_logs', count(*)::int from public.daily_logs where org_id=${kit.q(w.foreign.orgId)}
    union all select 'punch_items', count(*)::int from public.punch_items where org_id=${kit.q(w.foreign.orgId)}
    union all select 'warranty_requests', count(*)::int from public.warranty_requests where org_id=${kit.q(w.foreign.orgId)}
    union all select 'start_packages', count(*)::int from public.start_packages where org_id=${kit.q(w.foreign.orgId)}`)
  observed.foreignRowsWritten = Object.fromEntries(strays.map((row) => [row.t, row.n]))
  check.equal("a project lead limited to Gulf Coast makes each mutation their role allows in Gulf Coast and is refused every one in Treasure Coast; another builder's owner is refused every mutation aimed at this builder and writes nothing anywhere", expected.expected, observed)
  return { orgId: w.org.orgId, foreignOrgId: w.foreign.orgId, messages }
}

// ---------------------------------------------------------------------------
// 3. A stale role is refused on the next request of the same session.

async function staleRoleIsRefusedMidSession(kit, expected, check) {
  const w = await world(kit)
  const { org, gulf } = w
  const team = app("team")
  const mutations = deskMutations(kit, w)
  // A second starts coordinator and a second warranty manager, so the stock team stays intact.
  const starts = kit.addMember(org, "org_starts_coordinator"), warranty = kit.addMember(org, "org_warranty_manager")
  for (const actor of [starts, warranty]) actor.membershipId = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)}`)[0].id
  const open = mutations["starts: open a start package"], claim = mutations["warranty: open a warranty request"]
  // Data-API writes each actor's role makes directly today (lot.write on a lot; warranty.manage
  // on a routing rule), so the same write before and after the change is the proof.
  const lotId = gulf.freeLots.at(-2)
  const directLot = () => direct(kit, starts, (db) => db.from("lots").update({ address: `ROLE-01 stale ${randomUUID().slice(0, 6)}` }).eq("id", lotId).select("id"))
  const directRule = () => direct(kit, warranty, (db) => db.from("warranty_routing_rules").insert({ org_id: org.orgId, name: `ROLE-01 stale ${randomUUID().slice(0, 6)}`, assignee_kind: "trade", assigned_company_id: org.vendorIds["Gulf Concrete"] }).select("id"))
  const observed = {
    startsBefore: (await outcome(() => kit.as(starts, () => open(gulf)))).result,
    warrantyBefore: (await outcome(() => kit.as(warranty, () => claim(gulf)))).result,
    startsDirectBefore: await directLot(),
    warrantyDirectBefore: await directRule(),
  }
  // The owner moves the coordinator to sales, and revokes warranty.write and warranty.manage
  // from the warranty manager with per-member overrides, both through the team service. The
  // two keep their sessions (same tokens) and try again.
  await kit.as(org.owner, () => team.updateMemberRole({ membershipId: starts.membershipId, role: "org_sales_agent" }))
  await kit.as(org.owner, () => team.updateMemberRole({ membershipId: warranty.membershipId, role: "org_warranty_manager", permissionOverrides: [{ permission_key: "warranty.write", effect: "deny" }, { permission_key: "warranty.manage", effect: "deny" }] }))
  observed.overrideStored = kit.rows(`select permission_key, effect from public.membership_permission_overrides where membership_id=${kit.q(warranty.membershipId)} order by permission_key`)
  observed.startsAfterRoleChange = (await outcome(() => kit.as(starts, () => open(gulf)))).result
  observed.warrantyAfterRevoke = (await outcome(() => kit.as(warranty, () => claim(gulf)))).result
  // Straight through the data API with the stale sessions.
  observed.startsDirectAfter = await directLot()
  observed.warrantyDirectAfter = await directRule()
  check.equal("a starts coordinator moved to sales, and a warranty manager whose warranty keys are revoked, are each refused on their very next request with the same session, through the service and straight through the data API", expected.expected, observed)
  return { orgId: org.orgId, starts: starts.userId, warranty: warranty.userId }
}

// ---------------------------------------------------------------------------
// 4. The data API fences the same writes.

/**
 * A write through the actor's own PostgREST session. Row-level security refuses in one of
 * two ways: a write policy or guard raises 42501 ("refused"), or a USING clause leaves the
 * actor no row to touch ("refused (no rows)"). Any other database error is not a refusal
 * and is reported with its code, so a broken write never passes as a fenced one.
 */
async function direct(kit, actor, write) {
  return kit.as(actor, async () => {
    const { supabase } = await context().requireOrgContext()
    const { data, error } = await write(supabase, actor)
    if (error) return error.code === "42501" ? "refused" : `error: ${error.code} ${String(error.message).slice(0, 120)}`
    return data?.length ? "allowed" : "refused (no rows)"
  })
}

async function dataApiWritesAreFenced(kit, expected, check) {
  const w = await world(kit)
  const { org, gulf } = w
  // An approved order and a draft one the writes aim at (owner-made, through the service).
  const commitments = app("commitments")
  const draft = await kit.as(org.team.purchasing, () => commitments.createCommitment({ input: { project_id: gulf.homeId, company_id: org.vendorIds["Gulf Concrete"], commitment_type: "purchase_order", title: "ROLE-01 direct target", total_cents: 250000 } }))
  // One line on the draft: approval re-totals an order from its lines, so a line write is a price write.
  const lineId = randomUUID()
  kit.sql(`insert into public.commitment_lines(id,org_id,commitment_id,description,quantity,unit,unit_cost_cents) values(${kit.q(lineId)},${kit.q(org.orgId)},${kit.q(draft.id)},'ROLE-01 line',10,'ea',25000)`)
  const writes = {
    "communities: rename one": (db) => db.from("communities").update({ description: "Renamed through the data API" }).eq("id", gulf.communityId).select("id"),
    "lots: add one": (db) => db.from("lots").insert({ org_id: org.orgId, community_id: gulf.communityId, lot_number: `D${randomUUID().slice(0, 6)}`, status: "controlled" }).select("id"),
    "lots: change a lot's status": (db) => db.from("lots").update({ status: "controlled" }).eq("id", gulf.freeLots.at(-1)).select("id"),
    "commitments: write an order": (db) => db.from("commitments").insert({ org_id: org.orgId, project_id: gulf.homeId, company_id: org.vendorIds["Gulf Concrete"], commitment_type: "purchase_order", title: "Direct order", total_cents: 99000, status: "draft" }).select("id"),
    "commitments: approve an order": (db) => db.from("commitments").update({ status: "approved" }).eq("id", draft.id).select("id"),
    "commitments: change an order's total": (db) => db.from("commitments").update({ total_cents: 1 }).eq("id", draft.id).select("id"),
    "commitment_lines: change a draft line": (db) => db.from("commitment_lines").update({ quantity: 11 }).eq("id", lineId).select("id"),
    "commitment_lines: add a line": (db) => db.from("commitment_lines").insert({ org_id: org.orgId, commitment_id: draft.id, description: "Direct line", quantity: 1, unit: "ea", unit_cost_cents: 1 }).select("id"),
    "daily_logs: write one": (db, actor) => db.from("daily_logs").insert({ org_id: org.orgId, project_id: gulf.homeId, log_date: seed.isoDay(2), summary: "Direct log", created_by: actor.userId }).select("id"),
    "warranty_requests: open one": (db) => db.from("warranty_requests").insert({ org_id: org.orgId, project_id: gulf.homeId, title: "Direct claim", status: "open" }).select("id"),
    "land_opportunities: open one": (db, actor) => db.from("land_opportunities").insert({ org_id: org.orgId, name: `Direct parcel ${randomUUID().slice(0, 6)}`, division_id: gulf.divisionId, created_by: actor.userId }).select("id"),
  }
  const roles = ["land", "sales", "starts", "purchasing", "design", "superintendent", "warranty"]
  const observed = {}
  for (const [name, write] of Object.entries(writes)) {
    observed[name] = {}
    for (const role of roles) observed[name][role] = await direct(kit, w.actors[role], write)
    observed[name].foreignOwner = await direct(kit, w.foreign.owner, write)
    // Put the order back after each write, so the next actor's update meets the same draft.
    kit.sql(`update public.commitments set status='draft', total_cents=250000 where id=${kit.q(draft.id)};
      update public.commitment_lines set quantity=10 where id=${kit.q(lineId)};
      delete from public.commitment_lines where commitment_id=${kit.q(draft.id)} and id<>${kit.q(lineId)}`)
  }
  check.equal("straight through the data API, each production role writes only the tables its role writes in the app, never approves or reprices a purchase order, and another builder's owner writes nothing", expected.expected, observed)
  return { orgId: org.orgId, draftOrderId: draft.id }
}

// ---------------------------------------------------------------------------
// 5. Maker and checker on the purchasing desk.

async function creatorCannotApproveOwnPurchaseOrder(kit, expected, check) {
  const w = await world(kit)
  const { org, gulf } = w
  const commitments = app("commitments")
  const order = await kit.as(org.team.purchasing, () => commitments.createCommitment({ input: { project_id: gulf.homeId, company_id: org.vendorIds["Gulf Concrete"], commitment_type: "purchase_order", title: "ROLE-01 maker-checker order", total_cents: 480000 } }))
  const approve = (actor) => outcome(() => kit.as(actor, () => commitments.updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } })))
  const status = () => kit.rows(`select status, total_cents from public.commitments where id=${kit.q(order.id)}`)[0]
  const self = await approve(org.team.purchasing)
  const afterSelf = status()
  const superintendent = await approve(org.team.superintendent)
  const owner = await approve(org.owner)
  check.equal("the purchasing manager who wrote an order cannot approve it, a superintendent cannot approve it, the owner can; the total is unchanged throughout", expected.expected,
    { self: self.result, afterSelf, superintendent: superintendent.result, owner: owner.result, after: status() })
  return { orgId: org.orgId, commitmentId: order.id, messages: { self: self.message, superintendent: superintendent.message } }
}

module.exports = {
  id: "ROLE-01",
  subcases: {
    "desk-mutations-follow-the-role-catalog": deskMutationsFollowTheRoleCatalog,
    "division-and-org-walls-hold-for-mutations": divisionAndOrgWallsHoldForMutations,
    "stale-role-is-refused-mid-session": staleRoleIsRefusedMidSession,
    "data-api-writes-are-fenced": dataApiWritesAreFenced,
    "creator-cannot-approve-own-purchase-order": creatorCannotApproveOwnPurchaseOrder,
  },
}
