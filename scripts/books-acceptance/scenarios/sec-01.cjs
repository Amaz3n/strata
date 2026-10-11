// SEC-01 — divisions, roles and security (EP02). One production builder with two
// divisions: Gulf Coast (Cypress Landing) and Treasure Coast (Seagrape Hammock),
// each with lots, a home on a lot and a task on the home, all made through Arc's
// own services. Members are limited to a division through the team service, the
// way an administrator does it. Every subcase acts through `kit.as`, so row-level
// security and permission checks are the real ones:
//
//   division-wall-holds                       EP02-04  a division-limited member and another org see none of B
//   division-move-keeps-history               EP02-01  a community move carries its homes and keeps history
//   limited-member-cannot-move-a-community-out EP02-01/04
//   invites-cannot-escalate                   EP02-03  refusal paths only; no invite email is sent
//   departure-cancels-queued-authority        EP02-03
//   enterer-cannot-approve-own-bill           EP02-05
//   lost-audit-is-never-a-clean-success       EP02-06
//
// Support access (EP02-08) is a browser journey: journeys/support-access.spec.ts.
//
// SQL is used only for what the subcase is not about and says so where it happens:
// queued work owned by a departing member (subcase 5) and an injected audit fault
// (subcase 7). Reads that check the outcome are SQL as the stack superuser.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const context = () => require("../../../lib/services/context")
// What a person is told when they are refused, or "allowed".
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const names = (rows, key = "name") => rows.map((row) => row[key]).sort()

// ---------------------------------------------------------------------------
// The builder, built once per run and shared by the subcases.

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function home(kit, org, { name, divisionId, lotId }) {
  const created = await kit.as(org.owner, () => app("projects").createProject({ input: { name, property_type: "production", status: "active", phase: "delivery", division_id: divisionId } }))
  await kit.as(org.owner, () => app("lots").attachProjectToLot(lotId, created.id))
  return created.id
}

// DEFECT (not under test): tasks.createTask cannot save a task — its read-back embeds
// task_assignments → app_users without naming the foreign key, and task_assignments has
// two (user_id, assigned_by), so PostgREST refuses the statement (lib/services/tasks.ts:92).
// The task is written directly, as the service would have written it.
function task(kit, org, projectId, title) {
  const id = randomUUID()
  kit.sql(`insert into public.tasks(id,org_id,project_id,title,status,priority,created_by) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(title)},'todo','normal',${kit.q(org.owner.userId)})`)
  return id
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "SEC-01 divisions and security", lots: 2 })
  await seed.seedCommunity(kit, org)
  const divisions = app("divisions"), communities = app("communities"), lots = app("lots")
  // The seeded lots wait on their takedown; homes go on two developed lots outside it.
  const gulf = { divisionId: org.divisionId, communityId: org.communityId }
  await kit.as(org.team.land, () => lots.createLots(gulf.communityId, { lots: [
    { lotNumber: "21", status: "developed", address: "4200 Cypress Landing Way" },
    { lotNumber: "22", status: "developed", address: "4202 Cypress Landing Way" },
  ] }))
  gulf.lotIds = kit.rows(`select id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(gulf.communityId)} and lot_number in ('21','22') order by lot_number`).map((row) => row.id)
  gulf.homeId = await home(kit, org, { name: "Cypress Landing lot 1", divisionId: gulf.divisionId, lotId: gulf.lotIds[0] })
  gulf.taskId = task(kit, org, gulf.homeId, "Cypress framing walk")

  const treasure = {}
  treasure.divisionId = (await kit.as(org.owner, () => divisions.createDivision({ name: "Treasure Coast", code: "TC", region: "Southeast Florida" }))).id
  treasure.communityId = (await kit.as(org.owner, () => communities.createCommunity({ name: "Seagrape Hammock", code: "SGH", divisionId: treasure.divisionId, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 2, targetAbsorptionPerMonth: 1 }))).id
  await kit.as(org.owner, () => lots.createLots(treasure.communityId, { lots: [
    { lotNumber: "1", status: "developed", address: "10 Seagrape Hammock Way" },
    { lotNumber: "2", status: "developed", address: "12 Seagrape Hammock Way" },
  ] }))
  treasure.lotIds = kit.rows(`select id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(treasure.communityId)} order by lot_number`).map((row) => row.id)
  treasure.homeId = await home(kit, org, { name: "Seagrape Hammock lot 1", divisionId: treasure.divisionId, lotId: treasure.lotIds[0] })
  treasure.taskId = task(kit, org, treasure.homeId, "Seagrape framing walk")

  // Global search reads search_documents. The audit side effect queues the
  // reindex; the outbox writes it. Any record still missing is indexed through
  // the same function the job calls, so the wall is tested against a real row.
  await kit.drainOutbox(org.orgId)
  const index = app("search-index")
  const documents = (side) => [["project", side.homeId], ["community", side.communityId], ["task", side.taskId], ...side.lotIds.map((id) => ["lot", id])]
  for (const [entityType, entityId] of [...documents(gulf), ...documents(treasure)])
    if (!kit.rows(`select 1 from public.search_documents where org_id=${kit.q(org.orgId)} and entity_type=${kit.q(entityType)} and entity_id=${kit.q(entityId)}`).length)
      await kit.service(() => index.reindexEntity({ orgId: org.orgId, entityType, entityId }))
  const foreign = kit.organization({ name: "SEC-01 another builder", chart: [], productTier: "production" })
  return { org, gulf, treasure, foreign }
}

/** A new member of `org` under `role`, limited to `divisionIds` by the owner through the team service. */
async function limitedMember(kit, org, role, divisionIds) {
  const actor = kit.addMember(org, role)
  const membershipId = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)}`)[0].id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId, role, divisionScope: "assigned", divisionIds }))
  return Object.assign(actor, { membershipId })
}

/** The rows of `side` this actor's own database session returns, by table. */
async function rawReach(kit, actor, side) {
  return kit.as(actor, async () => {
    const { supabase } = await context().requireOrgContext()
    const ids = [side.homeId, side.communityId, side.taskId, ...side.lotIds]
    const count = async (table, column, values) => {
      const { data, error } = await supabase.from(table).select("id").in(column, values)
      if (error) throw new Error(`${table}: ${error.message}`)
      return data.length
    }
    return {
      projects: await count("projects", "id", [side.homeId]),
      communities: await count("communities", "id", [side.communityId]),
      lots: await count("lots", "community_id", [side.communityId]),
      tasks: await count("tasks", "id", [side.taskId]),
      search_documents: await count("search_documents", "entity_id", ids),
    }
  })
}

/** What an actor reaches through the services a desk and a workbench call. */
async function serviceReach(kit, actor, { gulf, treasure }) {
  const projects = app("projects"), communities = app("communities"), inventory = app("community-inventory"), tasks = app("tasks"), search = app("search")
  const ours = new Set([gulf.homeId, treasure.homeId])
  const ourTasks = new Set([gulf.taskId, treasure.taskId])
  const treasureIds = new Set([treasure.homeId, treasure.communityId, treasure.taskId, ...treasure.lotIds])
  const homes = (await kit.as(actor, () => projects.listProjects(undefined, undefined, { includePrecon: true }))).filter((p) => ours.has(p.id))
  const statusCounts = await kit.as(actor, () => inventory.countCommunityLotsByStatus(treasure.communityId))
  // The header search (GET /api/search?q=) and a typed search (?q=&types=...), as the route calls them.
  const header = (query) => kit.as(actor, () => search.searchAll(query, {}, { limit: 20, sortBy: "relevance", preferFast: true }))
  const typed = (query) => kit.as(actor, () => search.searchEntities(query, ["project", "community", "lot", "task"], {}, { limit: 20, sortBy: "relevance", preferFast: true }))
  const treasureTypes = (hits) => [...new Set(hits.filter((hit) => treasureIds.has(hit.id)).map((hit) => hit.type))].sort()
  return {
    homes: names(homes),
    communities: names((await kit.as(actor, () => communities.listCommunities())).filter((c) => [gulf.communityId, treasure.communityId].includes(c.id))),
    treasureCommunity: await attempt(() => kit.as(actor, () => communities.getCommunity(treasure.communityId))),
    treasureInventory: await attempt(() => kit.as(actor, () => inventory.listCommunityInventory(treasure.communityId))),
    treasureLotsCounted: Object.values(statusCounts).reduce((sum, n) => sum + n, 0),
    tasks: names((await kit.as(actor, () => tasks.listTasks())).filter((task) => ourTasks.has(task.id)), "title"),
    headerSearchReturnsTreasure: treasureTypes(await header("Seagrape")),
    typedSearchReturnsTreasure: treasureTypes(await typed("Seagrape")),
    typedSearchFindsGulfHome: (await typed("Cypress")).some((hit) => hit.id === gulf.homeId),
  }
}

// ---------------------------------------------------------------------------
// 1. EP02-04: the division wall.

async function divisionWallHolds(kit, expected, check) {
  const w = await world(kit)
  const { org, gulf, treasure, foreign } = w
  const superintendent = await limitedMember(kit, org, "org_superintendent", [gulf.divisionId])
  // Fixture (not under test): the superintendent is on the team of BOTH homes, so
  // the division is the only thing between them and Treasure Coast's home. Adding a
  // project team member is a page action, not a service, so the row is written directly.
  for (const projectId of [gulf.homeId, treasure.homeId])
    kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(superintendent.userId)},id,'active' from public.roles where scope='project' and key='pm'`)
  const indexed = kit.rows(`select entity_type, count(*)::int n from public.search_documents where org_id=${kit.q(org.orgId)}
    and entity_id in (${[treasure.homeId, treasure.communityId, treasure.taskId, ...treasure.lotIds].map(kit.q).join(",")}) group by 1 order by 1`)
  check.equal("Treasure Coast's home, community, lots and task are in the search index (so search is tested against real rows)", expected.expected.treasureIndexed, Object.fromEntries(indexed.map((row) => [row.entity_type, row.n])))
  check.equal("the owner reaches both divisions, and search finds Treasure Coast's records for them (the records exist and are searchable)", expected.expected.owner,
    { rows: { gulf: await rawReach(kit, org.owner, gulf), treasure: await rawReach(kit, org.owner, treasure) }, services: await serviceReach(kit, org.owner, w) })
  // A home's search document is tagged with the home; the tag is what the division wall reads.
  check.equal("after the owner has searched, both homes' search documents are still tagged with their home", expected.expected.homeDocumentsTagged,
    kit.rows(`select entity_id=${kit.q(gulf.homeId)} gulf, project_id=entity_id tagged from public.search_documents where org_id=${kit.q(org.orgId)} and entity_type='project' and entity_id in (${kit.q(gulf.homeId)},${kit.q(treasure.homeId)}) order by 1 desc`)
      .map((row) => ({ home: row.gulf ? "Cypress Landing lot 1" : "Seagrape Hammock lot 1", tagged: row.tagged === true })))
  check.equal("a superintendent limited to Gulf Coast reaches Gulf Coast's home, community and task through the services, and nothing of Treasure Coast — not its home, community, lots, task, nor its records in global search",
    expected.expected.limitedServices, await serviceReach(kit, superintendent, w))
  check.equal("the database itself returns none of Treasure Coast's rows to that member's session, and all of Gulf Coast's",
    expected.expected.limitedRows, { gulf: await rawReach(kit, superintendent, gulf), treasure: await rawReach(kit, superintendent, treasure) })
  check.equal("another organization's owner reaches none of this builder's homes, communities, lots, tasks or search documents",
    expected.expected.foreign, { services: await serviceReach(kit, foreign.owner, w), rows: { gulf: await rawReach(kit, foreign.owner, gulf), treasure: await rawReach(kit, foreign.owner, treasure) } })
  return { orgId: org.orgId, foreignOrgId: foreign.orgId, superintendent: superintendent.userId, ...gulf, treasure }
}

// ---------------------------------------------------------------------------
// 2. EP02-01: a community moves with its lots and homes, and history is kept.

async function divisionMoveKeepsHistory(kit, expected, check) {
  const { org, gulf, treasure } = await world(kit)
  const communities = app("communities"), lots = app("lots"), projects = app("projects")
  const divisionName = { [gulf.divisionId]: "Gulf Coast", [treasure.divisionId]: "Treasure Coast" }
  const harbor = await kit.as(org.owner, () => communities.createCommunity({ name: "Harbor Point", code: "HBP", divisionId: treasure.divisionId, status: "active", city: "Jensen Beach", state: "FL", postalCode: "34957", plannedLotCount: 2, targetAbsorptionPerMonth: 1 }))
  await kit.as(org.owner, () => lots.createLots(harbor.id, { lots: [{ lotNumber: "1", status: "developed", address: "1 Harbor Point Lane" }, { lotNumber: "2", status: "developed", address: "3 Harbor Point Lane" }] }))
  const lotIds = kit.rows(`select id from public.lots where community_id=${kit.q(harbor.id)} order by lot_number`).map((row) => row.id)
  const homeId = await home(kit, org, { name: "Harbor Point lot 1", divisionId: treasure.divisionId, lotId: lotIds[0] })
  const superintendent = await limitedMember(kit, org, "org_superintendent", [gulf.divisionId])

  const reach = async () => ({
    seesHome: (await kit.as(superintendent, () => projects.listProjects(undefined, undefined, { includePrecon: true }))).some((p) => p.id === homeId),
    community: await attempt(() => kit.as(superintendent, () => communities.getCommunity(harbor.id))),
  })
  const filed = () => ({
    community: divisionName[kit.rows(`select division_id from public.communities where id=${kit.q(harbor.id)}`)[0].division_id],
    lots: [...new Set(kit.rows(`select division_id from public.lots where community_id=${kit.q(harbor.id)}`).map((row) => divisionName[row.division_id]))],
    home: divisionName[kit.rows(`select division_id from public.projects where id=${kit.q(homeId)}`)[0].division_id],
  })
  const history = () => kit.rows(`select division_id, valid_to is null open from public.project_division_history where project_id=${kit.q(homeId)} order by valid_from, valid_to nulls last`)
    .map((row) => ({ division: divisionName[row.division_id] ?? null, open: row.open }))
  const moveEvents = () => kit.rows(`select payload from public.events where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(harbor.id)} and event_type='community.updated' order by created_at`)
    .map(({ payload }) => ({ from: divisionName[payload.from_division_id], to: divisionName[payload.to_division_id], homesMoved: payload.homes_moved }))

  const before = { filed: filed(), history: history(), limited: await reach() }
  const beforeMove = kit.rows("select now() at")[0].at
  const moved = await kit.as(org.owner, () => communities.updateCommunity(harbor.id, { divisionId: gulf.divisionId }))
  const afterMove = {
    returnedDivision: divisionName[moved.divisionId], filed: filed(), history: history(),
    divisionBeforeTheMove: divisionName[kit.rows(`select public.project_division_at(${kit.q(homeId)}, ${kit.q(beforeMove)}::timestamptz) d`)[0].d],
    divisionNow: divisionName[kit.rows(`select public.project_division_at(${kit.q(homeId)}, now()) d`)[0].d],
    limited: await reach(),
  }
  await kit.as(org.owner, () => communities.updateCommunity(harbor.id, { divisionId: treasure.divisionId }))
  const afterReturn = { filed: filed(), history: history(), limited: await reach(), limitedRows: (await rawReach(kit, superintendent, { homeId, communityId: harbor.id, taskId: randomUUID(), lotIds })).projects }
  check.equal("moving Harbor Point to Gulf Coast carries its lots and its home in the same step, closes the home's Treasure Coast history and opens Gulf Coast; the Gulf Coast member gains it, and loses it again when it moves back",
    expected.expected, { before, afterMove, afterReturn, events: moveEvents() })
  return { orgId: org.orgId, communityId: harbor.id, homeId, superintendent: superintendent.userId }
}

// ---------------------------------------------------------------------------
// 3. EP02-01/04: a division-limited land manager cannot take a community out of their division.

async function limitedMemberCannotMoveACommunityOut(kit, expected, check) {
  const { org, gulf, treasure } = await world(kit)
  const communities = app("communities")
  const land = await limitedMember(kit, org, "org_land_manager", [gulf.divisionId])
  const snapshot = () => ({
    // The communities this subcase touches or tries to create, and where each is filed.
    communities: kit.rows(`select c.name, d.name division from public.communities c left join public.divisions d on d.id=c.division_id
      where c.org_id=${kit.q(org.orgId)} and c.name in ('Cypress Landing','Seagrape Hammock','Driftwood Cay') order by c.name`),
    cypressLotsDivision: [...new Set(kit.rows(`select division_id from public.lots where community_id=${kit.q(gulf.communityId)}`).map((row) => row.division_id === gulf.divisionId ? "Gulf Coast" : row.division_id))],
    cypressHomeDivision: kit.rows(`select division_id from public.projects where id=${kit.q(gulf.homeId)}`)[0].division_id === gulf.divisionId ? "Gulf Coast" : "moved",
  })
  const before = snapshot()
  const attempts = {
    moveCypressToTreasure: await attempt(() => kit.as(land, () => communities.updateCommunity(gulf.communityId, { divisionId: treasure.divisionId }))),
    createInTreasure: await attempt(() => kit.as(land, () => communities.createCommunity({ name: "Driftwood Cay", divisionId: treasure.divisionId, status: "active", plannedLotCount: 10, targetAbsorptionPerMonth: 1 }))),
    moveSeagrapeToGulf: await attempt(() => kit.as(land, () => communities.updateCommunity(treasure.communityId, { divisionId: gulf.divisionId }))),
    // Straight to the database with the member's own session, past the service.
    directMoveOfCypress: await kit.as(land, async () => {
      const { supabase } = await context().requireOrgContext()
      const { data, error } = await supabase.from("communities").update({ division_id: treasure.divisionId }).eq("id", gulf.communityId).select("id")
      return error ? `refused (${error.code})` : `${data.length} rows changed`
    }),
    // The member does hold community.write inside Gulf Coast.
    editCypressInPlace: await attempt(() => kit.as(land, () => communities.updateCommunity(gulf.communityId, { description: "Model home open weekends" }))),
  }
  check.equal("a land manager limited to Gulf Coast can edit Gulf Coast's community but cannot move it to Treasure Coast, create one there, or pull Treasure Coast's community in; nothing moves", expected.expected, { before, attempts, after: snapshot() })
  return { orgId: org.orgId, landManager: land.userId }
}

// ---------------------------------------------------------------------------
// 4. EP02-03: invites cannot hand out more than the inviter holds.

async function invitesCannotEscalate(kit, expected, check) {
  const { org, gulf, treasure } = await world(kit)
  const team = app("team")
  // A land manager limited to Gulf Coast who also manages the team. Every role that
  // carries members.manage is an organization administrator (exempt by design), and
  // the team screen cannot grant members.manage on its own (it is not a customizable
  // key), so the grant is written directly (fixture): the only way to hold the
  // invite right without holding everything.
  const inviter = await limitedMember(kit, org, "org_land_manager", [gulf.divisionId])
  kit.sql(`insert into public.membership_permission_overrides(membership_id,permission_key,effect) values(${kit.q(inviter.membershipId)},'members.manage','grant')`)
  const roleId = (key) => kit.rows(`select id from public.roles where key=${kit.q(key)}`)[0].id
  const email = (label) => `${label}-${randomUUID()}@acceptance.example.test`
  const denials = (resourceId) => kit.rows(`select decision from public.authorization_audit_log where org_id=${kit.q(org.orgId)} and actor_user_id=${kit.q(inviter.userId)} and resource_type='membership' and resource_id=${kit.q(resourceId)}`).map((row) => row.decision)
  // The refusal names up to three keys the inviter lacks; which three depends on row order, so they are left out.
  const invite = async (input) => (await attempt(() => kit.as(inviter, () => team.inviteTeamMember({ input })))).replace(/ \([^)]*\)\./, ".")
  const emails = { owner: email("owner"), admin: email("admin"), all: email("all"), treasure: email("treasure") }
  const superintendent = org.team.superintendent
  const roleOf = () => kit.rows(`select r.key, m.status, m.division_scope from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${kit.q(org.orgId)} and m.user_id=${kit.q(superintendent.userId)}`)[0]
  const superintendentBefore = roleOf()
  const observed = {
    inviteOwner: await invite({ email: emails.owner, role: "org_owner", divisionScope: "assigned", divisionIds: [gulf.divisionId] }),
    inviteOwnerAudited: denials(roleId("org_owner")),
    inviteAdmin: await invite({ email: emails.admin, role: "org_admin", divisionScope: "assigned", divisionIds: [gulf.divisionId] }),
    inviteAdminAudited: denials(roleId("org_admin")),
    inviteAllDivisions: await invite({ email: emails.all, role: "org_land_manager", divisionScope: "all" }),
    inviteIntoTreasure: await invite({ email: emails.treasure, role: "org_land_manager", divisionScope: "assigned", divisionIds: [treasure.divisionId] }),
    reinviteActiveMember: await invite({ email: superintendent.email, role: "org_land_manager", divisionScope: "assigned", divisionIds: [gulf.divisionId] }),
    superintendentUnchanged: JSON.stringify(roleOf()) === JSON.stringify(superintendentBefore),
    // A refused invite creates no person and no membership.
    peopleCreated: kit.rows(`select id from public.app_users where email in (${Object.values(emails).map(kit.q).join(",")})`).length,
    invitedMemberships: kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and status='invited'`).length,
  }
  check.equal("a Gulf Coast land manager with team rights cannot invite an owner or an administrator (each refusal is in the authorization log), cannot invite anyone into all divisions or into Treasure Coast, and cannot re-invite an active member over their role", expected.expected, observed)
  return { orgId: org.orgId, inviter: inviter.userId }
}

// ---------------------------------------------------------------------------
// 5. EP02-03: departure cancels what the member queued up to run as them.

async function departureCancelsQueuedAuthority(kit, expected, check) {
  const { org, gulf } = await world(kit)
  const { q } = kit
  const team = app("team"), bills = app("vendor-bills")
  const leaver = kit.addMember(org, "org_bookkeeper")
  const membershipId = kit.rows(`select id from public.memberships where org_id=${q(org.orgId)} and user_id=${q(leaver.userId)}`)[0].id
  // SQL fixtures (not under test): what the bookkeeper left queued — a recurring
  // invoice, a delayed job carrying their identity, a seat on the payment approver
  // roster and a signed-in session. A job the owner queued sits beside them.
  const ids = { schedule: randomUUID(), session: randomUUID() }
  kit.sql(`begin;
insert into public.invoice_schedules(id,org_id,project_id,template,frequency,next_run_on,created_by,active) values(${q(ids.schedule)},${q(org.orgId)},${q(gulf.homeId)},'{"title":"Monthly draw"}','monthly',current_date + 20,${q(leaver.userId)},true);
insert into public.payment_run_approvers(org_id,user_id,created_by) values(${q(org.orgId)},${q(leaver.userId)},${q(org.owner.userId)});
insert into auth.sessions(id,user_id,created_at,updated_at,aal) values(${q(ids.session)},${q(leaver.userId)},now(),now(),'aal1');
commit;`)
  const queueJob = (actorId) => kit.sql(`insert into public.outbox(org_id,job_type,status,run_at,payload) values(${q(org.orgId)},'issue_invoice_scheduled','pending',now() + interval '2 days',jsonb_build_object('actor_id',${q(actorId)})) returning id`)
  ids.job = queueJob(leaver.userId)
  ids.ownersJob = queueJob(org.owner.userId)
  const state = () => ({
    sessions: kit.rows(`select id from auth.sessions where user_id=${q(leaver.userId)}`).length,
    scheduleActive: kit.rows(`select active from public.invoice_schedules where id=${q(ids.schedule)}`)[0].active,
    job: kit.rows(`select status, last_error from public.outbox where id=${q(ids.job)}`)[0],
    ownersJob: kit.rows(`select status from public.outbox where id=${q(ids.ownersJob)}`)[0].status,
    approverSeats: kit.rows(`select id from public.payment_run_approvers where org_id=${q(org.orgId)} and user_id=${q(leaver.userId)}`).length,
    membership: kit.rows(`select status from public.memberships where id=${q(membershipId)}`)[0].status,
  })
  const before = { ...state(), readsBills: await attempt(() => kit.as(leaver, () => bills.listVendorBillsForProject(gulf.homeId))) }
  const suspended = await attempt(() => kit.as(org.owner, () => team.suspendMember(membershipId)))
  const event = kit.rows(`select payload from public.events where org_id=${q(org.orgId)} and entity_id=${q(membershipId)} and event_type='member_suspended'`).map(({ payload }) => ({ sessions: payload.sessions, queued: payload.queued }))
  const after = { ...state(), readsBills: await attempt(() => kit.as(leaver, () => bills.listVendorBillsForProject(gulf.homeId))) }

  // The last administrator cannot be suspended: nobody would be left to run the org.
  const admins = kit.rows(`select m.id from public.memberships m where m.org_id=${q(org.orgId)} and m.status='active' and public.membership_is_org_admin(m.id, m.role_id)`)
  const ownerMembership = kit.rows(`select id from public.memberships where org_id=${q(org.orgId)} and user_id=${q(org.owner.userId)}`)[0].id
  const lastAdmin = admins.length === 1 && admins[0].id === ownerMembership
    ? { attempt: await attempt(() => kit.as(org.owner, () => team.suspendMember(ownerMembership))), ownerStatus: kit.rows(`select status from public.memberships where id=${q(ownerMembership)}`)[0].status }
    : { attempt: `not attempted: ${admins.length} active administrators`, ownerStatus: null }
  check.equal("suspending the bookkeeper signs them out, deactivates their recurring invoice, cancels their queued job (not the owner's), takes their approver seat, says so in the event, and refuses them afterwards; the last administrator cannot be suspended",
    expected.expected, { before, suspended, event, after, lastAdmin })
  return { orgId: org.orgId, leaver: leaver.userId, membershipId }
}

// ---------------------------------------------------------------------------
// 6. EP02-05: whoever enters a payable does not approve it.

async function entererCannotApproveOwnBill(kit, expected, check) {
  const { org, gulf } = await world(kit)
  const { q } = kit
  const bills = app("vendor-bills")
  const clerk = kit.addMember(org, "org_office_admin")
  const bill = await kit.as(clerk, () => bills.createProjectVendorBill({ projectId: gulf.homeId, input: {
    company_id: org.vendorIds["Palmetto Framing"], bill_number: `SEC-${Date.now()}`, bill_date: seed.isoDay(0), due_date: seed.isoDay(30), total_cents: 125000,
    actual_lines: [{ cost_code_id: org.costCodeIds["06-100"], description: "Framing labor, lot 1", amount_cents: 125000, project_id: gulf.homeId }],
  } }))
  const status = () => kit.rows(`select status from public.vendor_bills where id=${q(bill.id)}`)[0].status
  const entered = status()
  const selfApproval = await attempt(() => kit.as(clerk, () => bills.approveVendorBillsAtomic([{ id: bill.id }])))
  const refusals = kit.rows(`select decision, reason_code, context->>'rule' rule, request_id is not null correlated from public.authorization_audit_log
    where org_id=${q(org.orgId)} and actor_user_id=${q(clerk.userId)} and resource_id=${q(bill.id)} and reason_code='deny_separation_of_duties'`)
  const afterRefusal = status()
  const approvedAt = kit.rows("select now() at")[0].at
  const ownerApproval = await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: bill.id }]))
  const approvalAudit = kit.rows(`select action, actor_user_id=${q(org.owner.userId)} by_owner, after_data->>'status' status, correlation_id is not null correlated from public.audit_log
    where org_id=${q(org.orgId)} and entity_type='vendor_bill' and entity_id=${q(bill.id)} and created_at >= ${q(approvedAt)}::timestamptz and after_data->>'status'='approved'`)
  check.equal("the clerk who entered the payable is refused approving it, and the refusal is in the authorization log under the separation rule; the owner approves it, and the approval's audit row carries a correlation id",
    expected.expected, { entered, selfApproval, refusals, afterRefusal, ownerApproval: { approvedCount: ownerApproval.approvedCount }, approved: status(), approvalAudit })
  return { orgId: org.orgId, billId: bill.id, clerk: clerk.userId }
}

// ---------------------------------------------------------------------------
// 7. EP02-06: a critical mutation whose audit row is lost is not a clean success.

async function lostAuditIsNeverACleanSuccess(kit, expected, check) {
  const { org, gulf } = await world(kit)
  const { q } = kit
  const commitments = app("commitments")
  const order = await kit.as(org.owner, () => commitments.createCommitment({ input: { project_id: gulf.homeId, company_id: org.vendorIds["Gulf Concrete"], commitment_type: "purchase_order", title: "SEC-01 foundation order", total_cents: 5800000 } }))
  const startedAt = kit.rows("select now() at")[0].at
  // Harness fault (not under test): the audit table refuses this org's
  // commitment rows, as an outage of the audit write would.
  const fault = `sec01_audit_fault_${randomUUID().replace(/-/g, "")}`
  kit.sql(`create function public.${fault}() returns trigger language plpgsql as $$ begin
  if new.org_id = ${q(org.orgId)}::uuid and new.entity_type = 'commitment' then raise exception 'SEC-01 injected audit outage'; end if;
  return new; end $$;
create trigger ${fault} before insert on public.audit_log for each row execute function public.${fault}();`)
  let approval, queued, persisted, rowsWhileDown
  try {
    approval = await attempt(() => kit.as(org.owner, () => commitments.updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } })))
    persisted = kit.rows(`select status from public.commitments where id=${q(order.id)}`)[0].status
    rowsWhileDown = kit.rows(`select id from public.audit_log where org_id=${q(org.orgId)} and entity_type='commitment' and entity_id=${q(order.id)} and created_at >= ${q(startedAt)}::timestamptz`).length
    queued = kit.rows(`select id, status, payload->'row' row_ from public.outbox where org_id=${q(org.orgId)} and job_type='audit_retry' and payload->'row'->>'entity_id'=${q(order.id)}`)
  } finally {
    kit.sql(`drop trigger if exists ${fault} on public.audit_log; drop function if exists public.${fault}();`)
  }
  await kit.drainOutbox(org.orgId)
  const job = queued[0]
  const written = kit.rows(`select action, actor_user_id=${q(org.owner.userId)} by_owner, after_data->>'status' status, correlation_id from public.audit_log
    where org_id=${q(org.orgId)} and entity_type='commitment' and entity_id=${q(order.id)} and created_at >= ${q(startedAt)}::timestamptz`)
  check.equal("approving a purchase order while its audit row cannot be written saves the approval but reports 'saved, audit pending', queues the complete row, and the retry writes it under the original correlation id",
    expected.expected, {
      approval, persisted, auditRowsWhileDown: rowsWhileDown,
      queued: queued.map((row) => ({ status: row.status, entity_type: row.row_.entity_type, action: row.row_.action, after_status: row.row_.after_data?.status, by_owner: row.row_.actor_user_id === org.owner.userId, correlated: Boolean(row.row_.correlation_id) })),
      retryStatus: job ? kit.rows(`select status from public.outbox where id=${q(job.id)}`)[0].status : null,
      written: written.map((row) => ({ action: row.action, by_owner: row.by_owner, status: row.status, sameCorrelation: Boolean(job) && row.correlation_id === job.row_.correlation_id })),
    })
  return { orgId: org.orgId, commitmentId: order.id }
}

module.exports = {
  id: "SEC-01",
  subcases: {
    "division-wall-holds": divisionWallHolds,
    "division-move-keeps-history": divisionMoveKeepsHistory,
    "limited-member-cannot-move-a-community-out": limitedMemberCannotMoveACommunityOut,
    "invites-cannot-escalate": invitesCannotEscalate,
    "departure-cancels-queued-authority": departureCancelsQueuedAuthority,
    "enterer-cannot-approve-own-bill": entererCannotApproveOwnBill,
    "lost-audit-is-never-a-clean-success": lostAuditIsNeverACleanSuccess,
  },
}
