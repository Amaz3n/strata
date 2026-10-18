// A production builder at a named size (EP13-01). The small default builder in
// production-seed.cjs stays exactly as LOT-01, SALE-01, PO-01 and the role sweep use
// it; a profile here starts from that same builder and scales it out.
//
// How a profile is built:
//   1. Templates, through Arc's own services acting as the role that owns each step
//      (production-seed.cjs): one community, and one home at every stage of the
//      lifecycle (hold, reserved, sold, start package ready, building presold and
//      spec, completed, closed with and without warranty history).
//   2. Scale-out in bulk SQL: more divisions, the template community copied to the
//      profile's community count, lots added, and each template home copied onto
//      lots in every community at the profile's stage mix. A copy is the template's
//      whole row graph (every row of the home, and every row that references one),
//      with each id renumbered and every reference to a copied row pointed at its
//      copy, so a copied home has the exact shape the services wrote.
//   3. Installed homes have their closing and warranty dates spread across the
//      profile's history years, so coverage is a mix of active and expired.
//
// What a copy does not carry: the Books ledger (journal entries, job-cost postings,
// audit and authorization logs, queued jobs). Copied homes carry their operational
// money (agreements, deposits, invoices, purchase orders, bills); the general ledger
// holds only the templates' postings. Ids inside JSON documents are not renumbered.
//
// Reproducible: the profile's parameters and a fixed PRNG seed decide every count,
// mix, date and placement; ids are fresh per run. The result records the parameters,
// row counts and money totals. Writes only to its own new organisation on an isolated
// acceptance stack (createKit refuses anything else, and this checks the marker too).
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const seed = require("./production-seed.cjs")

const CLONER = fs.readFileSync(path.join(__dirname, "graph-clone.sql"), "utf8")
// Never copied: the lot (a copy is placed on its own lot), the Books ledger, logs and queued jobs.
const LEDGER = ["journal_entries", "journal_lines", "job_cost_entries"]
const HOME_EXCLUDE = ["lots", ...LEDGER, "authorization_audit_log", "audit_log", "events", "outbox", "notifications"]
// What a community is, without its homes and buyers.
const COMMUNITY_TABLES = ["communities", "community_phases", "lot_takedowns", "lots", "community_plan_availability", "community_release_slots", "community_assignments", "community_traffic", "land_contracts", "land_contract_deposits"]
const DIVISIONS = [{ name: "Gulf Coast", code: "GC" }, { name: "Suncoast", code: "SC" }, { name: "First Coast", code: "FC" }, { name: "Panhandle", code: "PH" }, { name: "Space Coast", code: "SP" }]
const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Quinn", "Reese", "Emerson", "Rowan", "Hayden", "Parker", "Sawyer", "Logan", "Blake", "Cameron"]
const LAST = ["Alvarez", "Bennett", "Chen", "Dawson", "Ellis", "Fischer", "Garcia", "Hughes", "Iyer", "Jensen", "Kim", "Lopez", "Murphy", "Novak", "Okafor", "Patel", "Reyes", "Silva"]

const PROFILES = {
  // The builder LOT-01 and the role sweep use (production-seed.cjs, unchanged).
  default: { divisions: 1, communities: 1, lotsPerCommunity: 20, activeHomes: 0, installedHomes: 0 },
  // The first-builder target (EP13-01): 3 divisions, 30 communities of 50 pipeline lots
  // (1,500), 500 active homes and 2,500 installed homes under warranty with ten years of
  // closings, for 50 concurrent users.
  "first-builder": {
    divisions: 3, communities: 30, lotsPerCommunity: 50, activeHomes: 500, installedHomes: 2500,
    historyYears: 10, prospects: 300, holds: 60, concurrentUsers: 50, prngSeed: 20261020,
    // Active homes by stage, as shares of activeHomes.
    activeMix: { reserved: 0.1, sold: 0.14, ready: 0.1, building: 0.44, spec: 0.14, completed: 0.08 },
    // Installed homes by warranty history: none, one resolved request, one open request.
    installedMix: { quiet: 0.7, resolved: 0.26, open: 0.04 },
  },
}

/** Deterministic PRNG (mulberry32) so a profile always places the same mix the same way. */
function prng(seedValue) {
  let a = seedValue >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Whole numbers per key that add up to `total` exactly (largest remainder). */
function apportion(total, shares) {
  const keys = Object.keys(shares), raw = keys.map((key) => total * shares[key])
  const out = Object.fromEntries(keys.map((key, i) => [key, Math.floor(raw[i])]))
  let left = total - Object.values(out).reduce((a, b) => a + b, 0)
  for (const i of keys.map((_, i) => i).sort((a, b) => (raw[b] % 1) - (raw[a] % 1))) { if (!left) break; out[keys[i]] += 1; left -= 1 }
  return out
}

/** Refuses anything that is not an isolated acceptance database. */
function assertAcceptanceStack(kit) {
  const marker = kit.rows(`select instance_id, isolated from books_acceptance.environment`)
  if (marker.length !== 1 || marker[0].isolated !== true) throw Error("Refusing to seed: the target has no isolated acceptance marker")
}

/** The templates: one home at every stage, each built through the services by its owning role. */
async function buildTemplates(kit, org, log = () => {}) {
  const sales = () => require("../../lib/services/community-sales")
  const warranty = () => require("../../lib/services/warranty-operations")
  const lot = (n) => org.lots[n - 1]
  // Even-numbered lots take a left garage (production-seed.cjs lays them out that way).
  const swing = (n) => (n % 2 ? "right" : "left")
  const buyer = (key) => ({ name: `Template ${key}`, email: `template-${key}-${org.orgId.slice(0, 8)}@acceptance.example.test` })
  const skus = ["ST-GAR", ...Object.values(seed.DESIGN_PICKS)]
  const t = {}
  // Six templates start this week; the community's even-flow slot is two, so the owner raises it as the starts desk would.
  const monday = (offset) => { const day = new Date(`${seed.isoDay(offset)}T12:00:00Z`); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10) }
  for (const week of new Set([monday(0), monday(7)]))
    await kit.as(org.owner, () => require("../../lib/services/even-flow").setReleaseSlot(org.communityId, week, { targetStarts: 10, notes: "Scale templates" }))
  const step = async (name, work) => { const at = Date.now(); t[name] = await work(); log(`template ${name} ${Math.round((Date.now() - at) / 1000)}s`) }

  await step("quiet", () => seed.presoldThroughClosing(kit, org, { lot: lot(1), plan: org.plans[0], buyer: buyer("quiet"), skus }))
  await step("resolved", async () => {
    const home = await seed.presoldThroughClosing(kit, org, { lot: lot(2), plan: org.plans[1], buyer: buyer("resolved"), swing: swing(2), skus })
    const request = await kit.as(org.team.warranty, () => warranty().createWarrantyRequest({ input: { project_id: home.projectId, title: "Drywall crack at stairwell", description: "Hairline crack above the stair landing.", severity: "routine_30" } }))
    const visit = await kit.as(org.team.warranty, () => warranty().scheduleWarrantyVisit({ request_id: request.id, assignee_kind: "tech", assigned_user_id: org.team.warranty.userId, window_start: "2026-11-09T14:00:00Z", window_end: "2026-11-09T16:00:00Z" }))
    await kit.as(org.team.warranty, () => warranty().completeWarrantyVisit({ visit_id: visit.id, outcome: "resolved", outcome_note: "Taped, mudded and painted the seam" }))
    await kit.as(org.owner, () => warranty().verifyWarrantyVisit(visit.id))
    return { ...home, requestId: request.id }
  })
  await step("open", async () => {
    const home = await seed.presoldThroughClosing(kit, org, { lot: lot(3), plan: org.plans[0], buyer: buyer("open"), skus })
    const request = await kit.as(org.team.warranty, () => warranty().createWarrantyRequest({ input: { project_id: home.projectId, title: "Garage door sticks", description: "The garage door binds halfway up.", severity: "routine_30" } }))
    return { ...home, requestId: request.id }
  })
  const sold = async (n, key, plan) => {
    const prospect = await seed.registerBuyer(kit, org, buyer(key))
    const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot(n).id, depositCents: 2000000, receivedOn: "2026-06-20" })
    const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: lot(n).id, plan, swing: swing(n), skus: ["ST-GAR"] }) })
    await seed.chooseDesign(kit, org, { projectId: sale.projectId })
    return { prospect, reservation, ...sale }
  }
  const building = async (n, key, plan, { complete = false } = {}) => {
    const home = await sold(n, key, plan)
    const gates = await seed.clearStartGates(kit, org, { lotId: lot(n).id, projectId: home.projectId })
    await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: home.projectId })
    await seed.buildHome(kit, org, { projectId: home.projectId })
    if (complete) await seed.completeHome(kit, org, { projectId: home.projectId, reserveCents: 650000 })
    return { ...home, packageId: gates.packageId }
  }
  await step("building", () => building(4, "building", org.plans[1]))
  await step("completed", () => building(5, "completed", org.plans[0], { complete: true }))
  await step("spec", async () => {
    seed.pinSpecPlan(kit, { lot: lot(6), plan: org.plans[1] })
    const gates = await seed.clearStartGates(kit, org, { lotId: lot(6).id, spec: true })
    await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: gates.projectId })
    return { projectId: gates.projectId, packageId: gates.packageId }
  })
  await step("ready", async () => {
    const home = await sold(7, "ready", org.plans[0])
    const gates = await seed.clearStartGates(kit, org, { lotId: lot(7).id, projectId: home.projectId })
    return { ...home, packageId: gates.packageId }
  })
  await step("sold", () => sold(8, "sold", org.plans[1]))
  await step("reserved", async () => {
    const prospect = await seed.registerBuyer(kit, org, buyer("reserved"))
    const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot(9).id, depositCents: 1000000, receivedOn: "2026-06-22" })
    return { prospect, reservationId: reservation.id, projectId: reservation.projectId }
  })
  await step("hold", async () => {
    const prospect = await seed.registerBuyer(kit, org, buyer("hold"))
    const hold = await kit.as(org.team.sales, () => sales().createLotHoldFromProspect({ prospectId: prospect.id, lotId: lot(10).id, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }))
    return { prospect, reservationId: hold.id }
  })
  await step("prospect", async () => ({ prospect: await seed.registerBuyer(kit, org, buyer("walkin")) }))
  await kit.drainOutbox(org.orgId)
  return t
}

/**
 * The staff a builder this size has, each a signed-in member: per division a starts
 * coordinator, purchasing manager, warranty manager, land manager and design
 * coordinator; a sales consultant for every two communities; a superintendent for
 * every twelve or so active homes. Each is scoped to their division.
 */
function scaleTeam(kit, org, profile, divisionIds, password) {
  const perDivision = { starts: "org_starts_coordinator", purchasing: "org_purchasing_manager", warranty: "org_warranty_manager", land: "org_land_manager", design: "org_design_studio_coordinator" }
  const team = { divisions: divisionIds.map(() => ({})), sales: [], superintendents: divisionIds.map(() => []) }
  const scope = []
  divisionIds.forEach((divisionId, d) => {
    for (const [key, role] of Object.entries(perDivision)) { team.divisions[d][key] = kit.addMember(org, role, { password }); scope.push([team.divisions[d][key], divisionId]) }
  })
  for (let i = 0; i < Math.ceil(profile.communities / 2); i++) {
    const d = i % divisionIds.length
    team.sales.push(kit.addMember(org, "org_sales_agent", { password })); scope.push([team.sales.at(-1), divisionIds[d]])
  }
  for (let i = 0; i < Math.ceil(profile.activeHomes / 12.5); i++) {
    const d = i % divisionIds.length
    team.superintendents[d].push(kit.addMember(org, "org_superintendent", { password })); scope.push([team.superintendents[d].at(-1), divisionIds[d]])
  }
  kit.sql(`insert into public.membership_divisions(membership_id, division_id) select m.id, v.division_id::uuid from (values ${scope.map(([actor, divisionId]) => `(${kit.q(actor.userId)}, ${kit.q(divisionId)})`).join(",")}) v(user_id, division_id)
    join public.memberships m on m.org_id=${kit.q(org.orgId)} and m.user_id=v.user_id::uuid on conflict do nothing`)
  return team
}

/**
 * Where everything goes: communities by division, each community's sales consultant,
 * and every copied home with its stage, lot, people and dates. Decided by the profile
 * and its PRNG seed alone.
 */
function placementPlan(profile, templateCount) {
  const random = prng(profile.prngSeed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const shuffle = (list) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }
  const communities = Array.from({ length: profile.communities }, (_, idx) => ({ idx, code: idx === 0 ? "CYP" : `C${String(idx + 1).padStart(2, "0")}`, division: idx % profile.divisions, sales: Math.floor(idx / (2 * profile.divisions)) * profile.divisions + (idx % profile.divisions), pipeline: [], installed: [], prospects: [] }))
  // Templates already stand on lots 1-10 of the first community.
  communities[0].pipelineUsed = 10
  for (const c of communities) c.pipelineUsed ??= 0
  const spread = (count, place) => { const order = shuffle(communities); for (let i = 0; i < count; i++) place(order[i % order.length]) }
  const active = apportion(profile.activeHomes, profile.activeMix)
  // How far back each copy lives, in days: homes started over the last five months, finished
  // inventory completed in the last quarter, sales within the last six weeks. Holds stay current.
  const AGE = { reserved: [0, 30], sold: [0, 45], ready: [0, 30], building: [0, 150], spec: [0, 150], completed: [15, 105], hold: [0, 0] }
  // Whole weeks, so start weeks stay Mondays and every weekday stays a weekday.
  const age = (stage) => { const [low, high] = AGE[stage]; return 7 * Math.round((low + Math.floor(random() * (high - low + 1))) / 7) }
  for (const [stage, count] of Object.entries(active)) spread(count - (templateCount[stage] ?? 0), (c) => c.pipeline.push({ stage, lot: String(++c.pipelineUsed), shiftDays: age(stage) }))
  spread(profile.holds - (templateCount.hold ?? 0), (c) => c.pipeline.push({ stage: "hold", lot: String(++c.pipelineUsed), shiftDays: 0 }))
  const today = Date.parse(`${seed.isoDay(0)}T12:00:00Z`)
  const installed = apportion(profile.installedHomes, profile.installedMix)
  for (const [stage, count] of Object.entries(installed)) spread(count - (templateCount[stage] ?? 0), (c) => {
    // Closed between `historyYears` ago and two months ago; homes with an open request closed within two years.
    const span = (stage === "open" ? 2 : profile.historyYears) * 365 - 60
    const closedOn = new Date(today - (60 + Math.floor(random() * span)) * 86400000).toISOString().slice(0, 10)
    c.installed.push({ stage, lot: String(101 + c.installed.length), closedOn })
  })
  spread(profile.prospects - (templateCount.prospect ?? 0), (c) => { c.prospects.push({ shiftDays: 7 * Math.floor(random() * 18) }) })
  for (const c of communities) if (c.pipelineUsed > profile.lotsPerCommunity) throw Error(`Community ${c.code} needs ${c.pipelineUsed} pipeline lots; the profile has ${profile.lotsPerCommunity}`)
  return { communities, active, installed, name: () => `${pick(FIRST)} ${pick(LAST)}` }
}

const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const daysBetween = (later, earlier) => Math.round((Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / 86400000)

/**
 * Copies the template community and its homes up to the profile, in one transaction
 * on one session as the stack's superuser (the copier turns triggers off).
 */
function scaleOut(kit, org, templates, profile, { divisionIds, team, log = () => {} }) {
  const { q } = kit
  const counts = { quiet: 1, resolved: 1, open: 1, building: 1, completed: 1, spec: 1, ready: 1, sold: 1, reserved: 1, hold: 1, prospect: 1 }
  const plan = placementPlan(profile, counts)
  const tplLots = Object.fromEntries(org.lots.map((lot) => [lot.lot_number, lot.id]))
  const [tplLotRows] = [kit.rows(`select id, lot_number, community_phase_id, takedown_id from public.lots where community_id=${q(org.communityId)} and lot_number in ('1','50')`)]
  const phase1 = org.phaseIds[0], phase2 = org.phaseIds[1]
  const lot50 = tplLotRows.find((row) => row.lot_number === "50").id
  const division = (idx) => divisionIds[plan.communities[idx].division]
  const superCursor = divisionIds.map(() => 0)
  const nextSuper = (d) => { const list = team.superintendents[d]; return list[superCursor[d]++ % list.length].userId }
  // Template staff -> the staff of the target's division and community.
  const people = (c, superId) => {
    const d = team.divisions[c.division]
    return { [org.team.sales.userId]: team.sales[c.sales].userId, [org.team.starts.userId]: d.starts.userId, [org.team.purchasing.userId]: d.purchasing.userId,
      [org.team.warranty.userId]: d.warranty.userId, [org.team.land.userId]: d.land.userId, [org.team.design.userId]: d.design.userId, [org.team.superintendent.userId]: superId }
  }
  const json = (value) => `${q(JSON.stringify(value))}::jsonb`
  const regs = (names) => `array[${names.map(q).join(",")}]::regclass[]`
  const statements = ["begin;", "set local session_replication_role = replica;", "set local statement_timeout = 0;", CLONER]

  // 1. Communities: the template community's own rows (no homes, no buyers), once per new community.
  statements.push(`select pg_temp.sc_collect(${q(org.orgId)}, ${json([{ tbl: "communities", id: org.communityId }])}, '{}'::uuid[], ${regs(HOME_EXCLUDE.filter((t) => t !== "lots"))}, '{}'::regclass[], 3);
delete from sc_g where tbl::text <> all (${q(`{${COMMUNITY_TABLES.join(",")}}`)}::text[]);
update sc_g set row = row || '{"project_id":null,"house_plan_id":null,"house_plan_version_id":null,"house_plan_elevation_id":null,"delivered_at":null,"status":"developed"}'::jsonb
  where tbl = 'lots'::regclass and row->>'status' not in ('controlled','developed');
truncate sc_targets;`)
  const communityTargets = plan.communities.slice(1).map((c) => ({ k: c.idx, suffix: `-${c.code}`,
    overrides: { [org.divisionId]: division(c.idx), ...people(c, team.superintendents[c.division][0].userId) },
    patches: { communities: { name: `Community ${c.code}`, code: c.code, planned_lot_count: profile.lotsPerCommunity + c.installed.length } } }))
  statements.push(`insert into sc_targets select * from jsonb_to_recordset(${json(communityTargets)}) x(k int, suffix text, overrides jsonb, patches jsonb);
select pg_temp.sc_clone(${regs(LEDGER)});
create temp table sc_comm as select 0 idx, ${q(org.communityId)}::uuid id, ${q(phase1)}::uuid phase1, ${q(phase2)}::uuid phase2, ${q(division(0))}::uuid division_id;
insert into sc_comm select t.k, pg_temp.sc_new(t.k, ${q(org.communityId)}), pg_temp.sc_new(t.k, ${q(phase1)}), pg_temp.sc_new(t.k, ${q(phase2)}), (t.overrides->>${q(org.divisionId)})::uuid from sc_targets t;
update public.lots l set address = (4100 + l.lot_number::int)::text || ' ' || c.name || ' Way' from public.communities c where c.id = l.community_id and l.community_id in (select id from sc_comm where idx > 0);`)

  // 2. Closed lots under the installed homes, numbered from 101 in each community.
  const lotTargets = []
  let k = 0
  for (const c of plan.communities) for (const home of c.installed) lotTargets.push({ k: ++k, idx: c.idx, suffix: `-${c.code}X${home.lot}`, lot: home.lot })
  statements.push(`select pg_temp.sc_collect(${q(org.orgId)}, ${json([{ tbl: "lots", id: lot50 }])}, '{}'::uuid[], ${regs(HOME_EXCLUDE.filter((t) => t !== "lots"))}, '{}'::regclass[], 0);
truncate sc_targets;
insert into sc_targets select x.k, x.suffix, jsonb_build_object(${q(org.communityId)}, c.id, ${q(phase2)}, c.phase1, ${q(org.divisionId)}, c.division_id),
  jsonb_build_object('lots', jsonb_build_object('lot_number', x.lot, 'status', 'developed', 'address', (4000 + x.lot::int)::text || ' ' || cc.name || ' Court'))
  from jsonb_to_recordset(${json(lotTargets)}) x(k int, idx int, suffix text, lot text) join sc_comm c on c.idx = x.idx join public.communities cc on cc.id = c.id;
select pg_temp.sc_clone(${regs(LEDGER)});`)

  // 3. Homes, holds and prospects: each template copied onto its lots.
  const closedOnOf = Object.fromEntries(["quiet", "resolved", "open"].map((stage) => [stage, kit.rows(`select actual_date::text d from public.closings where project_id=${q(templates[stage].projectId)} and status='closed'`)[0].d]))
  const byTemplate = {}
  const add = (stage, target) => (byTemplate[stage] ??= []).push(target)
  for (const c of plan.communities) {
    for (const home of c.pipeline) {
      const superId = nextSuper(c.division), buyer = plan.name()
      add(home.stage, { idx: c.idx, lot: home.lot, suffix: `-${c.code}L${home.lot}`, users: people(c, superId), shift_days: home.shiftDays,
        patches: { projects: { name: `${c.code} Lot ${home.lot}` }, prospects: { name: buyer }, contacts: { full_name: buyer, email: `buyer${`-${c.code}L${home.lot}`.toLowerCase()}@acceptance.example.test` } } })
    }
    for (const home of c.installed) {
      // The whole home moves back whole weeks so that it closed on (about) `closedOn`; its request history is laid after that.
      const shift = 7 * Math.round(daysBetween(closedOnOf[home.stage], home.closedOn) / 7)
      const superId = nextSuper(c.division), buyer = plan.name(), d = addDays(closedOnOf[home.stage], -shift)
      const patches = { projects: { name: `${c.code} Lot ${home.lot}` }, prospects: { name: buyer }, contacts: { full_name: buyer, email: `owner-${c.code}l${home.lot}@acceptance.example.test`.toLowerCase() } }
      if (home.stage === "resolved") Object.assign(patches, {
        warranty_requests: { created_at: `${addDays(d, 120)}T15:00:00Z`, first_responded_at: `${addDays(d, 121)}T15:00:00Z`, closed_at: `${addDays(d, 136)}T15:00:00Z`, updated_at: `${addDays(d, 136)}T15:00:00Z` },
        warranty_service_visits: { window_start: `${addDays(d, 125)}T14:00:00Z`, window_end: `${addDays(d, 125)}T16:00:00Z`, completed_at: `${addDays(d, 125)}T16:00:00Z`, created_at: `${addDays(d, 121)}T15:00:00Z`, updated_at: `${addDays(d, 126)}T15:00:00Z` },
      })
      add(home.stage, { idx: c.idx, lot: home.lot, suffix: `-${c.code}L${home.lot}`, users: people(c, superId), shift_days: shift, patches })
    }
    for (const [i, prospect] of c.prospects.entries()) {
      const buyer = plan.name()
      add("prospect", { idx: c.idx, lot: null, suffix: `-${c.code}P${i + 1}`, users: people(c, null), shift_days: prospect.shiftDays, patches: { prospects: { name: buyer }, contacts: { full_name: buyer, email: `prospect-${c.code}p${i}@acceptance.example.test`.toLowerCase() } } })
    }
  }
  const BATCH = 400
  for (const [stage, targets] of Object.entries(byTemplate)) {
    const template = templates[stage]
    const tplLot = { quiet: "1", resolved: "2", open: "3", building: "4", completed: "5", spec: "6", ready: "7", sold: "8", reserved: "9", hold: "10" }[stage]
    const roots = template.projectId ? [{ tbl: "projects", id: template.projectId }] : stage === "hold" ? [{ tbl: "lot_reservations", id: template.reservationId }] : [{ tbl: "prospects", id: template.prospect.id }]
    statements.push(`select pg_temp.sc_collect(${q(org.orgId)}, ${json(roots)}, ${template.projectId ? `array[${q(template.projectId)}]::uuid[]` : "'{}'::uuid[]"}, ${regs(HOME_EXCLUDE)}, array['prospects','contacts']::regclass[]);`)
    for (let start = 0; start < targets.length; start += BATCH) {
      const batch = targets.slice(start, start + BATCH).map((target, i) => ({ ...target, k: start + i + 1, users: Object.fromEntries(Object.entries(target.users).filter(([, id]) => id)) }))
      const lotJoin = tplLot ? `join public.lots l on l.community_id = c.id and l.lot_number = x.lot` : ""
      const lotOverride = tplLot ? `jsonb_build_object(${q(tplLots[tplLot])}, l.id) ||` : ""
      statements.push(`truncate sc_targets;
insert into sc_targets select x.k, x.suffix, ${lotOverride} jsonb_build_object(${q(org.communityId)}, c.id, ${q(phase1)}, c.phase1, ${q(phase2)}, c.phase2, ${q(org.divisionId)}, c.division_id) || x.users, x.patches
  , coalesce(x.shift_days, 0) from jsonb_to_recordset(${json(batch)}) x(k int, idx int, lot text, suffix text, users jsonb, patches jsonb, shift_days int) join sc_comm c on c.idx = x.idx ${lotJoin};
select pg_temp.sc_clone(${regs(LEDGER)});`)
      if (tplLot) statements.push(`update public.lots l set project_id = ${template.projectId ? `pg_temp.sc_new(t.k, ${q(template.projectId)})` : "null"}, status = tl.status, house_plan_id = tl.house_plan_id,
  house_plan_version_id = tl.house_plan_version_id, house_plan_elevation_id = tl.house_plan_elevation_id, swing = tl.swing, delivered_at = tl.delivered_at
  from sc_targets t, public.lots tl where tl.id = ${q(tplLots[tplLot])} and l.id = (t.overrides->>${q(tplLots[tplLot])})::uuid;`)
    }
    log(`planned ${targets.length} copies of ${stage}`)
  }
  statements.push("commit;")
  const at = Date.now()
  // One transaction for every copy: on a stack that already holds other scaled builders it
  // outlasts the kit's two-minute statement timeout, so it runs under the seed's own budget.
  const bulk = spawnSync("docker", ["exec", "-i", kit.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres"], {
    input: statements.join("\n"), encoding: "utf8", timeout: 900000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  })
  if (bulk.error || bulk.status !== 0) throw Error(`Bulk copy failed: ${(bulk.stderr || bulk.error?.message || "").trim().slice(-1500)}`)
  log(`bulk copy ${Math.round((Date.now() - at) / 1000)}s`)
  kit.sql(`analyze public.projects; analyze public.lots; analyze public.lot_reservations; analyze public.contracts; analyze public.commitments; analyze public.commitment_lines; analyze public.invoices; analyze public.payments;
analyze public.start_packages; analyze public.start_package_gates; analyze public.closings; analyze public.project_warranty_coverage; analyze public.warranty_requests; analyze public.warranty_service_visits;
analyze public.prospects; analyze public.contacts; analyze public.search_documents; analyze public.schedule_items; analyze public.vendor_bills; analyze public.files;`, "supabase_admin")
  return plan
}

/** What the organisation holds once seeded: the record of a reproducible dataset. */
function datasetCensus(kit, orgId) {
  const { q } = kit
  const one = (sql) => kit.rows(sql)[0]
  return {
    divisions: Number(one(`select count(*) n from public.divisions where org_id=${q(orgId)}`).n),
    communities: Number(one(`select count(*) n from public.communities where org_id=${q(orgId)}`).n),
    lots: kit.rows(`select status, count(*)::int n from public.lots where org_id=${q(orgId)} group by 1 order by 1`),
    homes: Number(one(`select count(*) n from public.projects where org_id=${q(orgId)} and property_type='production'`).n),
    closedHomes: Number(one(`select count(*) n from public.closings where org_id=${q(orgId)} and status='closed'`).n),
    warrantyCoverage: Number(one(`select count(*) n from public.project_warranty_coverage where org_id=${q(orgId)} and voided_at is null`).n),
    warrantyRequests: kit.rows(`select status, count(*)::int n from public.warranty_requests where org_id=${q(orgId)} group by 1 order by 1`),
    startPackages: kit.rows(`select status, count(*)::int n from public.start_packages where org_id=${q(orgId)} group by 1 order by 1`),
    reservations: kit.rows(`select status, count(*)::int n from public.lot_reservations where org_id=${q(orgId)} group by 1 order by 1`),
    prospects: Number(one(`select count(*) n from public.prospects where org_id=${q(orgId)}`).n),
    agreements: one(`select count(*)::int n, coalesce(sum(total_cents),0)::bigint cents from public.contracts where org_id=${q(orgId)} and contract_type='purchase_agreement' and status='active'`),
    purchaseOrders: kit.rows(`select status, count(*)::int n, sum(total_cents)::bigint cents from public.commitments where org_id=${q(orgId)} and commitment_type='purchase_order' group by 1 order by 1`),
    deposits: one(`select count(*)::int n, coalesce(sum(p.amount_cents),0)::bigint cents from public.payments p where p.org_id=${q(orgId)} and p.status='succeeded'`),
    members: Number(one(`select count(*) n from public.memberships where org_id=${q(orgId)} and status='active'`).n),
  }
}

/**
 * Seeds a production builder at a profile. `default` is the small builder of
 * production-seed.cjs (one community of twenty lots, its tranche taken down); any
 * other profile builds the templates and scales out. Returns the org, the team,
 * the templates, the plan's parameters and the census, with how long it took.
 */
async function seedAtProfile(kit, profileName, { name, password = null, log = () => {} } = {}) {
  const profile = PROFILES[profileName]
  if (!profile) throw Error(`Unknown profile ${profileName}; choose ${Object.keys(PROFILES).join(", ")}`)
  assertAcceptanceStack(kit)
  const startedAt = Date.now()
  const org = await seed.productionBuilder(kit, { name: name ?? `Production builder (${profileName})`, password, lots: profile.lotsPerCommunity })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  // A license-billed company is active without a payment-provider subscription (as browser-seed.cjs sets it).
  kit.sql(`update public.orgs set billing_model='license' where id=${kit.q(org.orgId)}`)
  if (profileName === "default") return { org, profile: { name: profileName, ...profile }, seconds: Math.round((Date.now() - startedAt) / 1000) }
  const templates = await buildTemplates(kit, org, log)
  const templateSeconds = Math.round((Date.now() - startedAt) / 1000)
  const { createDivision } = require("../../lib/services/divisions")
  const divisionIds = [org.divisionId]
  for (const division of DIVISIONS.slice(1, profile.divisions)) divisionIds.push((await kit.as(org.owner, () => createDivision({ ...division, region: "Florida" }))).id)
  const team = scaleTeam(kit, org, profile, divisionIds, password)
  const bulkAt = Date.now()
  const plan = scaleOut(kit, org, templates, profile, { divisionIds, team, log })
  const bulkSeconds = Math.round((Date.now() - bulkAt) / 1000)
  return {
    org, team, templates, divisionIds,
    profile: { name: profileName, ...profile, activeByStage: plan.active, installedByHistory: plan.installed },
    census: datasetCensus(kit, org.orgId),
    seconds: { templates: templateSeconds, bulk: bulkSeconds, total: Math.round((Date.now() - startedAt) / 1000) },
  }
}

module.exports = { PROFILES, prng, apportion, assertAcceptanceStack, buildTemplates, scaleTeam, placementPlan, scaleOut, datasetCensus, seedAtProfile }
