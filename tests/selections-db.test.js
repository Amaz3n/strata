"use strict"

/**
 * The database contract behind `lib/services/selections.ts`:
 * `apply_project_selection_writes` lands a package, a group confirmation or a
 * change order on a home whole, or not at all — and only against the catalog
 * revision and home state (`read_project_selection_fence`) it was validated on.
 *
 * Two sessions writing the same home serialize on a transaction lock; PGlite
 * has one connection, so that interleaving is proven in the acceptance
 * scenario. Here the second writer is the one that read a stale fence.
 *
 * The same write enforces the deadline (in the community's day), the option's
 * lead time and released procurement (EP06-03/04); a selection change order's
 * approval lands the selections, variance orders, budget and schedule impact
 * in its own transaction or not at all (EP06-05).
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

const refusalCode = async (work) => {
  try {
    await work
    return "allowed"
  } catch (error) {
    return error.detail ?? error.message
  }
}

async function home(t) {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const selection = async (name) => {
    const category = await insert(db, "selection_categories", { org_id: orgId, name })
    return insert(db, "project_selections", { org_id: orgId, project_id: project.id, category_id: category.id, status: "pending", metadata: JSON.stringify({ approved_envelope_id: "env-1" }) })
  }
  return { db, orgId, project, kitchen: await selection("Kitchen"), bath: await selection("Bath") }
}

const fence = (db, orgId, project) => rpc(db, "read_project_selection_fence", { p_org_id: orgId, p_project_id: project.id })

async function apply(db, orgId, project, writes, validatedOn) {
  const { catalogRevision, homeState } = validatedOn ?? await fence(db, orgId, project)
  return rpc(db, "apply_project_selection_writes", {
    p_org_id: orgId, p_project_id: project.id, p_writes: JSON.stringify(writes),
    p_expected_catalog_revision: catalogRevision, p_expected_home_state: homeState,
  })
}

const statuses = async (db) => (await db.query("select status from project_selections order by id")).rows.map((row) => row.status)

const write = (selection, overrides = {}) => ({
  id: selection.id, selected_option_id: null, package_id: null, status: "selected", selected_at: "2026-10-10T12:00:00Z",
  selected_by_contact_id: null, price_cents_snapshot: 1200_00, cost_cents_snapshot: 600_00, ...overrides,
})

test("every selection in the set is written, and signing evidence on the row survives", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const applied = await apply(db, orgId, project, [write(kitchen, { metadata: { package_allocated: true } }), write(bath, { price_cents_snapshot: 800_00 })])
  assert.equal(applied, 2)
  const { rows } = await db.query("select id, status, price_cents_snapshot, metadata from project_selections order by price_cents_snapshot")
  assert.deepEqual(rows.map((row) => [row.status, row.price_cents_snapshot]), [["selected", 800_00], ["selected", 1200_00]])
  assert.deepEqual(rows.find((row) => row.id === kitchen.id).metadata, { approved_envelope_id: "env-1", package_allocated: true })
})

test("one write that is not on this home rolls back the whole set", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  await assert.rejects(apply(db, orgId, project, [write(kitchen), write({ id: uuid() })]), /not on this home/)
  const { rows } = await db.query("select status from project_selections where id = $1", [kitchen.id])
  assert.equal(rows[0].status, "pending")
})

test("a confirmation keeps the choice it confirms; only the columns a write carries change", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  await apply(db, orgId, project, [write(kitchen, { package_id: null, metadata: { package_allocated: true } })])
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z", price_cents_snapshot: 1200_00, cost_cents_snapshot: 600_00 }])
  const { rows } = await db.query("select status, selected_at, confirmed_at, metadata from project_selections where id = $1", [kitchen.id])
  assert.equal(rows[0].status, "confirmed")
  assert.ok(rows[0].selected_at && rows[0].confirmed_at)
  assert.deepEqual(rows[0].metadata, { approved_envelope_id: "env-1", package_allocated: true })
})

test("a catalog edit published after the fence was read refuses the write and writes nothing", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const validatedOn = await fence(db, orgId, project)
  await insert(db, "selection_categories", { org_id: orgId, name: "Exterior" })
  await assert.rejects(
    apply(db, orgId, project, [write(kitchen), write(bath)], validatedOn),
    (error) => /catalog changed while you were choosing/.test(error.message) && error.detail === "SELECTION_CATALOG_CHANGED",
  )
  assert.deepEqual(await statuses(db), ["pending", "pending"])
})

test("a write that landed on the same home after the fence was read refuses the second write", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const first = await fence(db, orgId, project)
  const second = await fence(db, orgId, project)
  await apply(db, orgId, project, [write(kitchen)], first)
  await assert.rejects(
    apply(db, orgId, project, [write(bath)], second),
    (error) => /selections changed while you were choosing/.test(error.message) && error.detail === "SELECTION_HOME_CHANGED",
  )
  const { rows } = await db.query("select status from project_selections where id = $1", [bath.id])
  assert.equal(rows[0].status, "pending")
})

test("a selection records the revision of the option it chose, and keeps it when the option is edited", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const category = (await db.query("select category_id from project_selections where id = $1", [kitchen.id])).rows[0].category_id
  const option = await insert(db, "selection_options", { org_id: orgId, category_id: category, name: "Quartz", price_cents: 3_000_00 })
  await db.query("update selection_options set price_cents = 3500000, description = 'Calacatta' where id = $1", [option.id])

  await apply(db, orgId, project, [write(kitchen, { selected_option_id: option.id })])
  await db.query("update selection_options set price_cents = 3600000 where id = $1", [option.id])
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z" }])

  const revision = async () => (await db.query("select selected_option_revision from project_selections where id = $1", [kitchen.id])).rows[0].selected_option_revision
  assert.equal(await revision(), 2)
  await db.query("update project_selections set selected_option_revision = 7 where id = $1", [kitchen.id])
  assert.equal(await revision(), 2)
  await apply(db, orgId, project, [{ id: kitchen.id, selected_option_id: null }])
  assert.equal(await revision(), null)
})

test("a selection records the revision of the package it chose, and keeps it when the package is revised", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const pkg = await insert(db, "selection_packages", { org_id: orgId, name: "Chef's kitchen", price_cents: 12_000_00 })
  await db.query("update selection_packages set price_cents = 1300000 where id = $1", [pkg.id])

  await apply(db, orgId, project, [write(kitchen, { package_id: pkg.id })])
  await db.query("update selection_packages set price_cents = 1400000 where id = $1", [pkg.id])
  assert.equal((await db.query("select revision from selection_packages where id = $1", [pkg.id])).rows[0].revision, 3)
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z" }])

  const revision = async () => (await db.query("select selected_package_revision from project_selections where id = $1", [kitchen.id])).rows[0].selected_package_revision
  assert.equal(await revision(), 2)
  await db.query("update project_selections set selected_package_revision = 7 where id = $1", [kitchen.id])
  assert.equal(await revision(), 2)
  await apply(db, orgId, project, [{ id: kitchen.id, package_id: null }])
  assert.equal(await revision(), null)
})

test("a write without the fence it was validated on is refused", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const { catalogRevision } = await fence(db, orgId, project)
  for (const validatedOn of [{ catalogRevision: null, homeState: "0".repeat(32) }, { catalogRevision, homeState: "stale" }]) {
    await assert.rejects(apply(db, orgId, project, [write(kitchen)], validatedOn), /validated on/)
  }
  assert.deepEqual(await statuses(db), ["pending", "pending"])
})

test("signed-in users cannot read the fence or call the set write directly", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const member = await seedMember(db, { orgId })
  const caller = { role: "authenticated", userId: member.userId }
  await assert.rejects(rpc(db, "read_project_selection_fence", { p_org_id: orgId, p_project_id: project.id }, caller), /permission denied/)
  await assert.rejects(
    rpc(db, "apply_project_selection_writes", {
      p_org_id: orgId, p_project_id: project.id, p_writes: JSON.stringify([write(kitchen)]),
      p_expected_catalog_revision: "1", p_expected_home_state: "0".repeat(32),
    }, caller),
    /permission denied/,
  )
})

test("a signed-in member never chooses, confirms or prices a selection by a direct write", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const { userId } = await seedMember(db, { orgId })
  const option = await insert(db, "selection_options", { org_id: orgId, category_id: kitchen.category_id, name: "Island" })
  const as = (sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))

  for (const set of ["price_cents_snapshot = 1", "cost_cents_snapshot = 1", "status = 'confirmed'", "selected_option_id = $2"]) {
    await assert.rejects(as(`update project_selections set ${set} where id = $1 and $2::uuid is not null`, [kitchen.id, option.id]), /through the selection service/)
  }
  const category = await insert(db, "selection_categories", { org_id: orgId, name: "Flooring" })
  await assert.rejects(
    as("insert into project_selections (org_id, project_id, category_id, status, price_cents_snapshot) values ($1, $2, $3, 'confirmed', 1)", [orgId, project.id, category.id]),
    /through the selection service/,
  )
  // Opening a pending choice and its notes stay the member's; its lock, its
  // signing evidence and the change order that set it do not.
  await as("insert into project_selections (org_id, project_id, category_id, status) values ($1, $2, $3, 'pending')", [orgId, project.id, category.id])
  await as("update project_selections set notes = 'Buyer prefers oak' where id = $1", [kitchen.id])
  for (const set of ["locked_at = now()", "metadata = '{}'::jsonb", "confirmed_at = now()"]) {
    await assert.rejects(as(`update project_selections set ${set} where id = $1`, [kitchen.id]), /kept by the selection service/)
  }
  assert.deepEqual(await statuses(db), ["pending", "pending", "pending"])
})

test("a member never moves a selection to another home and never deletes one past pending", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const { userId } = await seedMember(db, { orgId })
  const other = await insert(db, "projects", { org_id: orgId, name: "Lot 13" })
  const as = (sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  await apply(db, orgId, project, [write(kitchen, { status: "confirmed" })])

  await assert.rejects(as("update project_selections set project_id = $2 where id = $1", [kitchen.id, other.id]), /stays with its home/)
  await assert.rejects(as("update project_selections set project_id = $2 where id = $1", [bath.id, other.id]), /stays with its home/)
  await assert.rejects(as("delete from project_selections where id = $1", [kitchen.id]), /confirmed selection is kept/)
  // A pending choice is still the member's to withdraw.
  await as("delete from project_selections where id = $1", [bath.id])
  const { rows } = await db.query("select project_id, status from project_selections")
  assert.deepEqual(rows, [{ project_id: project.id, status: "confirmed" }])
})

// ---------------------------------------------------------------------------
// EP06-03/04: the deadline and supply, enforced inside the write.
// ---------------------------------------------------------------------------

/** A sold home in a community whose Kitchen group is anchored to the cabinets task 30 days out. */
async function supplyHome(t, { timeZone = "America/New_York" } = {}) {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const { orgId } = owner
  const community = await insert(db, "communities", { org_id: orgId, name: "Cypress Landing", time_zone: timeZone })
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 7" })
  await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "7", status: "assigned", project_id: project.id })
  const day = async (offset, zone = timeZone) => (await db.query("select ((now() at time zone $1)::date + $2::int)::text as d", [zone, offset])).rows[0].d
  const cabinets = await insert(db, "schedule_items", { org_id: orgId, project_id: project.id, name: "Cabinets", start_date: await day(30), end_date: await day(35) })
  const group = await insert(db, "selection_groups", { org_id: orgId, name: "Kitchen", schedule_task_key: "cabinets" })
  const instance = await insert(db, "project_selection_groups", { org_id: orgId, project_id: project.id, group_id: group.id, cutoff_date: await day(10), matched_schedule_item_id: cabinets.id })
  const category = await insert(db, "selection_categories", { org_id: orgId, name: "Countertop" })
  const option = (name, lead) => insert(db, "selection_options", { org_id: orgId, category_id: category.id, name, price_cents: 1000_00, lead_time_days: lead })
  const laminate = await option("Laminate", 5)
  // Needed 30 days out with a 45-day lead time: it had to be ordered 15 days ago.
  const quartz = await option("Quartz", 45)
  const selection = await insert(db, "project_selections", { org_id: orgId, project_id: project.id, category_id: category.id, group_id: group.id, status: "pending" })
  const choose = (optionId, extra = {}) => apply(db, orgId, project, [{ id: selection.id, selected_option_id: optionId, status: "selected", price_cents_snapshot: 1000_00, cost_cents_snapshot: 400_00, ...extra }])
  const setCutoff = async (date, status = "open") => db.query("update project_selection_groups set cutoff_date = $2, status = $3 where id = $1", [instance.id, date, status])
  const row = async () => (await db.query("select selected_option_id, status, price_cents_snapshot, cost_cents_snapshot, source_change_order_id, locked_at from project_selections where id = $1", [selection.id])).rows[0]
  return { db, owner, orgId, community, project, cabinets, group, instance, category, laminate, quartz, selection, day, choose, setCutoff, row }
}

test("a choice past the cutoff is refused inside the write, even when the caller skipped its own check", async (t) => {
  const home = await supplyHome(t)
  await home.setCutoff(await home.day(-1))
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "SELECTION_LOCKED_CUTOFF")
  await home.setCutoff(await home.day(10), "locked")
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "SELECTION_LOCKED_CUTOFF")
  // The cutoff day itself is still open.
  await home.setCutoff(await home.day(0))
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "allowed")
  await home.db.query("update project_selections set locked_at = now() where id = $1", [home.selection.id])
  assert.equal(await refusalCode(home.choose(home.quartz.id)), "SELECTION_LOCKED_CUTOFF")
})

test("the cutoff day is the community's day, not the server's", async (t) => {
  const home = await supplyHome(t, { timeZone: "Pacific/Kiritimati" })
  // Today in Pago Pago (UTC-11) is always yesterday or earlier in Kiritimati (UTC+14).
  const pagoToday = await home.day(0, "Pacific/Pago_Pago")
  await home.setCutoff(pagoToday)
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "SELECTION_LOCKED_CUTOFF")
  await home.db.query("update communities set time_zone = 'Pacific/Pago_Pago' where id = $1", [home.community.id])
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "allowed")
})

test("an option that cannot arrive in time is refused while the group is open; only a recorded expedite lets it through", async (t) => {
  const home = await supplyHome(t)
  const orderBy = await home.day(-15)
  await assert.rejects(home.choose(home.quartz.id), (error) => error.detail === "SELECTION_LEAD_TIME" && error.hint === orderBy)
  assert.equal(await refusalCode(home.choose(home.laminate.id)), "allowed")

  // Moving the deadline is not an expedite: the lead time still binds.
  await rpc(home.db, "override_project_selection_group_cutoff", {
    p_org_id: home.orgId, p_project_id: home.project.id, p_group_id: home.group.id, p_cutoff_date: await home.day(60),
    p_reason: "Buyer asked for more time", p_actor_id: home.owner.userId,
  })
  assert.equal(await refusalCode(home.choose(home.quartz.id)), "SELECTION_LEAD_TIME")

  const opened = await rpc(home.db, "open_selection_exception", {
    p_org_id: home.orgId, p_project_id: home.project.id, p_selection_id: home.selection.id, p_option_id: home.quartz.id,
    p_reason: "lead_time_exceeded", p_detail: JSON.stringify({ order_by: orderBy }), p_actor_id: null,
  })
  assert.equal(opened.opened, true)
  const again = await rpc(home.db, "open_selection_exception", {
    p_org_id: home.orgId, p_project_id: home.project.id, p_selection_id: home.selection.id, p_option_id: home.quartz.id,
    p_reason: "lead_time_exceeded", p_detail: "{}", p_actor_id: null,
  })
  assert.deepEqual(again, { id: opened.id, opened: false })
  const waive = (reason) => rpc(home.db, "resolve_selection_exception", { p_org_id: home.orgId, p_exception_id: opened.id, p_status: "waived", p_reason: reason, p_actor_id: home.owner.userId })
  await assert.rejects(waive("ok"), /selection_exceptions_waiver_check/)
  await waive("Vendor confirmed a 10-day expedite")
  assert.equal(await refusalCode(home.choose(home.quartz.id)), "allowed")
  assert.equal((await home.row()).selected_option_id, home.quartz.id)
})

test("a selection already bought on a released purchase order is changed only by a change order; confirming it is not a change", async (t) => {
  const home = await supplyHome(t)
  await home.choose(home.laminate.id)
  const draft = await insert(home.db, "commitments", { org_id: home.orgId, project_id: home.project.id, title: "Countertops", commitment_type: "purchase_order", status: "draft" })
  await insert(home.db, "commitment_lines", { org_id: home.orgId, commitment_id: draft.id, description: "Laminate", metadata: JSON.stringify({ source: "option", source_ref: home.selection.id }) })
  // A draft from a preview has not bought anything yet.
  assert.equal(await refusalCode(home.choose(home.quartz.id, { cost_cents_snapshot: 401_00 })), "SELECTION_LEAD_TIME")
  assert.equal(await refusalCode(home.choose(home.laminate.id, { price_cents_snapshot: 1001_00 })), "allowed")
  await home.db.query("update commitments set status = 'approved' where id = $1", [draft.id])
  await assert.rejects(home.choose(home.quartz.id), (error) => error.detail === "SELECTION_PROCUREMENT_RELEASED" && error.hint === draft.id)
  assert.equal(await refusalCode(apply(home.db, home.orgId, home.project, [{ id: home.selection.id, status: "confirmed", confirmed_at: "2026-10-12T12:00:00Z" }])), "allowed")
})

test("an override moves the group and the choices the sweep closed in one step, with its before and after", async (t) => {
  const home = await supplyHome(t)
  await home.choose(home.laminate.id)
  await home.setCutoff(await home.day(-1))
  const swept = await rpc(home.db, "lock_due_selection_groups", { p_org_id: home.orgId, p_limit: 10 })
  assert.deepEqual(swept.map((row) => [row.id, row.unconfirmed]), [[home.instance.id, 1]])
  assert.ok((await home.row()).locked_at, "the sweep locks the choices with the group")
  assert.deepEqual(await rpc(home.db, "lock_due_selection_groups", { p_org_id: home.orgId, p_limit: 10 }), [])

  const override = (date, reason = "Buyer has five more days") => rpc(home.db, "override_project_selection_group_cutoff", {
    p_org_id: home.orgId, p_project_id: home.project.id, p_group_id: home.group.id, p_cutoff_date: date, p_reason: reason, p_actor_id: home.owner.userId,
  })
  await assert.rejects(override(await home.day(5), "ok"), /needs a date, a reason/)
  const extended = await override(await home.day(5))
  assert.equal(extended.before.status, "locked")
  assert.equal(extended.before.cutoff_source, "schedule")
  assert.deepEqual([extended.after.status, extended.after.cutoff_source, extended.reopened], ["open", "manual_override", 1])
  assert.equal((await home.row()).locked_at, null)

  const restore = () => rpc(home.db, "restore_project_selection_group_cutoff", {
    p_org_id: home.orgId, p_project_id: home.project.id, p_group_id: home.group.id, p_cutoff_date: null, p_matched_schedule_item_id: home.cabinets.id, p_actor_id: home.owner.userId,
  })
  const restored = await restore()
  assert.deepEqual([restored.before.cutoff_source, restored.after.cutoff_source], ["manual_override", "schedule"])
  assert.equal(await refusalCode(restore()), "SELECTION_CUTOFF_NOT_OVERRIDDEN")
})

test("a signed-in member never moves a cutoff, its status or its override", async (t) => {
  const home = await supplyHome(t)
  const { userId } = await seedMember(home.db, { orgId: home.orgId })
  const as = (sql, args) => asRole(home.db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  for (const set of ["cutoff_date = '2099-01-01'", "status = 'locked'", "cutoff_source = 'manual_override'", "override_reason = 'because'", "locked_at = now()", "matched_schedule_item_id = null"]) {
    await assert.rejects(as(`update project_selection_groups set ${set} where id = $1`, [home.instance.id]), /override with a reason/)
  }
  await as("delete from project_selection_groups where id = $1", [home.instance.id])
  await assert.rejects(
    as("insert into project_selection_groups (org_id, project_id, group_id) values ($1, $2, $3)", [home.orgId, home.project.id, home.group.id]),
    /set up by the selection service/,
  )
  await as("update project_selection_groups set metadata = '{\"note\": \"call buyer\"}' where id = $1", [home.instance.id])
  // A member has no delete on a home's groups at all.
  const { rows: [instance] } = await home.db.query("select cutoff_date::text, status, metadata from project_selection_groups where id = $1", [home.instance.id])
  assert.deepEqual([instance.cutoff_date, instance.status, instance.metadata], [await home.day(10), "open", { note: "call buyer" }])
})

test("a schedule pull-in or an option going off sale opens one exception per selection", async (t) => {
  const home = await supplyHome(t)
  await home.choose(home.laminate.id)
  const refresh = () => rpc(home.db, "refresh_project_selection_exceptions", { p_org_id: home.orgId, p_project_id: home.project.id })
  assert.deepEqual(await refresh(), [])
  await home.db.query("update schedule_items set start_date = $2 where id = $1", [home.cabinets.id, await home.day(3)])
  assert.deepEqual((await refresh()).map((row) => [row.reason, row.detail.order_by]), [["lead_time_exceeded", await home.day(-2)]])
  await home.db.query("update selection_options set is_available = false where id = $1", [home.laminate.id])
  assert.deepEqual((await refresh()).map((row) => row.reason), ["option_unavailable"])
  assert.deepEqual(await refresh(), [])
  assert.equal(Number((await home.db.query("select count(*) n from selection_exceptions where selection_id = $1 and status = 'open'", [home.selection.id])).rows[0].n), 2)
})

// ---------------------------------------------------------------------------
// EP06-05: a selection change order lands whole on approval, or not at all.
// ---------------------------------------------------------------------------

/** The supply home, sold, with Laminate chosen at $1,000 / $400 and its cutoff passed. */
async function soldSupplyHome(t) {
  const home = await supplyHome(t)
  await home.choose(home.laminate.id)
  await home.setCutoff(await home.day(-1), "locked")
  const contract = await insert(home.db, "contracts", {
    org_id: home.orgId, project_id: home.project.id, title: "Purchase Agreement — Lot 7", status: "draft", contract_type: "purchase_agreement",
    total_cents: 400_000_00, snapshot: JSON.stringify({ purchase_agreement: { pricing: { totalCents: 400_000_00 } } }),
  })
  await home.db.query("update contracts set status = 'active', signed_at = now(), signature_data = $2 where id = $1", [contract.id, JSON.stringify({ envelope_id: "env" })])
  const countertops = await insert(home.db, "cost_codes", { org_id: home.orgId, code: "06-400", name: "Countertops" })
  // Two purchase orders carry the cost code; only the newer one bought this selection.
  const older = await insert(home.db, "commitments", { org_id: home.orgId, project_id: home.project.id, title: "Backsplash tile", commitment_type: "purchase_order", status: "draft" })
  await insert(home.db, "commitment_lines", { org_id: home.orgId, commitment_id: older.id, cost_code_id: countertops.id, description: "Tile" })
  const owning = await insert(home.db, "commitments", { org_id: home.orgId, project_id: home.project.id, title: "Countertops", commitment_type: "purchase_order", status: "draft" })
  await insert(home.db, "commitment_lines", { org_id: home.orgId, commitment_id: owning.id, cost_code_id: countertops.id, description: "Laminate", metadata: JSON.stringify({ source: "option", source_ref: home.selection.id }) })
  const change = (overrides = {}) => ({
    selection_id: home.selection.id, old_option_id: home.laminate.id, old_price_cents: 1000_00, old_cost_cents: 400_00,
    new_option_id: home.quartz.id, new_package_id: null, group_id: home.group.id, category_name: "Countertop", option_name: "Quartz",
    price_cents: 2300_00, cost_cents: 1100_00, price_delta_cents: 1300_00, cost_delta_cents: 700_00, cost_code_id: countertops.id, ...overrides,
  })
  const changeOrder = (row = {}) => insert(home.db, "change_orders", {
    org_id: home.orgId, project_id: home.project.id, title: "Post-cutoff selection change", status: "pending", lifecycle: "proposed",
    total_cents: 1500_00, requires_signature: true, days_impact: 4, ...row,
  })
  const attach = (id, changes = [change()]) => home.db.query("update change_orders set metadata = metadata || jsonb_build_object('selection_change', $2::jsonb) where id = $1", [id, JSON.stringify({ changes, fee_cents: 200_00 })])
  const approve = (id) => home.db.query("update change_orders set status = 'approved', lifecycle = 'approved', approved_at = now(), metadata = metadata || '{\"approved_via_envelope\": true, \"approved_envelope_id\": \"env-9\"}' where id = $1", [id])
  const count = async (sql, args) => Number((await home.db.query(sql, args)).rows[0].n)
  return { ...home, contract, countertops, older, owning, change, changeOrder, attach, approve, count }
}

test("one selection carries at most one open change order, priced on the home as it stands", async (t) => {
  const home = await soldSupplyHome(t)
  const first = await home.changeOrder()
  await home.attach(first.id)
  assert.equal(await home.count("select count(*) n from selection_change_claims where selection_id = $1 and released_at is null", [home.selection.id]), 1)

  const second = await home.changeOrder({ title: "Another change" })
  assert.equal(await refusalCode(home.attach(second.id)), "SELECTION_CHANGE_ALREADY_OPEN")
  const stale = await home.changeOrder({ title: "Stale" })
  await home.db.query("update change_orders set status = 'rejected', lifecycle = 'rejected' where id = $1", [first.id])
  assert.equal(await home.count("select count(*) n from selection_change_claims where selection_id = $1 and released_at is null", [home.selection.id]), 0)
  assert.equal(await refusalCode(home.attach(stale.id, [home.change({ old_price_cents: 900_00 })])), "SELECTION_CHANGED_SINCE_PRICING")
  assert.equal(await refusalCode(home.attach(second.id)), "allowed")
})

test("a selection change is fixed once raised, and a member never writes one, its lines or its price", async (t) => {
  const home = await soldSupplyHome(t)
  const raised = await home.changeOrder()
  await insert(home.db, "change_order_lines", { org_id: home.orgId, change_order_id: raised.id, description: "Selection change: Countertop — Quartz", quantity: 1, unit_cost_cents: 1300_00 })
  await home.attach(raised.id)
  await assert.rejects(home.attach(raised.id, [home.change({ price_cents: 1 })]), /fixed once raised/)
  await assert.rejects(home.db.query("update change_orders set metadata = metadata - 'selection_change' where id = $1", [raised.id]), /fixed once raised/)
  await assert.rejects(home.db.query("insert into change_orders (org_id, project_id, title, metadata) values ($1, $2, 'Smuggled', $3)", [home.orgId, home.project.id, JSON.stringify({ selection_change: { changes: [] } })]), /never written with it/)

  const { userId } = await seedMember(home.db, { orgId: home.orgId })
  const as = (sql, args) => asRole(home.db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  const fresh = await home.changeOrder({ title: "Member draft" })
  await assert.rejects(as("update change_orders set metadata = jsonb_build_object('selection_change', $2::jsonb) where id = $1", [fresh.id, JSON.stringify({ changes: [home.change()] })]), /attached through the design studio/)
  await assert.rejects(as("update change_order_lines set unit_cost_cents = 1 where change_order_id = $1", [raised.id]), /lines are its selections' prices/)
  await assert.rejects(as("update change_orders set total_cents = 1 where id = $1", [raised.id]), /price is its selections' prices/)
})

test("approving a selection change lands the agreement, selections, owning purchase order, budget and schedule together, once", async (t) => {
  const home = await soldSupplyHome(t)
  const raised = await home.changeOrder()
  await home.attach(raised.id)
  await home.approve(raised.id)

  const row = await home.row()
  assert.deepEqual([row.selected_option_id, row.status, row.price_cents_snapshot, row.cost_cents_snapshot, row.source_change_order_id], [home.quartz.id, "confirmed", 2300_00, 1100_00, raised.id])
  const versions = (await home.db.query("select version_number, price_delta_cents::int delta from purchase_agreement_versions where contract_id = $1 order by version_number", [home.contract.id])).rows
  assert.deepEqual(versions, [{ version_number: 1, delta: 400_000_00 }, { version_number: 2, delta: 1500_00 }])
  const vpos = (await home.db.query("select commitment_id, total_cents, status, origin from commitment_change_orders where prime_change_order_id = $1", [raised.id])).rows
  assert.deepEqual(vpos, [{ commitment_id: home.owning.id, total_cents: 700_00, status: "draft", origin: "design_studio_co" }])
  const budget = (await home.db.query("select r.total_cents, l.cost_code_id, l.amount_cents from budget_revisions r join budget_revision_lines l on l.budget_revision_id = r.id where r.change_order_id = $1", [raised.id])).rows
  assert.deepEqual(budget, [{ total_cents: 700_00, cost_code_id: home.countertops.id, amount_cents: 700_00 }])
  const schedule = (await home.db.query("select schedule_item_id, days_adjusted, applied_at from schedule_item_change_orders where change_order_id = $1", [raised.id])).rows
  assert.deepEqual(schedule, [{ schedule_item_id: home.cabinets.id, days_adjusted: 4, applied_at: null }])
  assert.equal(await home.count("select count(*) n from selection_change_claims where change_order_id = $1 and released_at is null", [raised.id]), 0)
  assert.equal(await home.count("select count(*) n from outbox where job_type = 'selection_change_applied' and payload->>'change_order_id' = $1", [raised.id]), 1)

  // A re-delivered signature finds it approved and moves nothing again.
  await home.approve(raised.id)
  assert.equal(await home.count("select count(*) n from commitment_change_orders where prime_change_order_id = $1", [raised.id]), 1)
  assert.equal(await home.count("select count(*) n from purchase_agreement_versions where contract_id = $1", [home.contract.id]), 2)

  // The superintendent applies the impact once, in whole days.
  const [impact] = (await home.db.query("select id from schedule_item_change_orders where change_order_id = $1", [raised.id])).rows
  const applied = await rpc(home.db, "apply_schedule_item_change_order", { p_org_id: home.orgId, p_impact_id: impact.id })
  assert.deepEqual([applied.before.start_date, applied.after.start_date], [await home.day(30), await home.day(34)])
  assert.equal(await refusalCode(rpc(home.db, "apply_schedule_item_change_order", { p_org_id: home.orgId, p_impact_id: impact.id })), "SCHEDULE_IMPACT_APPLIED")
})

test("an approved selection change voids the buyer's earlier approval of those selections, and only those", async (t) => {
  const home = await soldSupplyHome(t)
  const approval = async (selectionId) => {
    const row = await insert(home.db, "selection_approvals", {
      org_id: home.orgId, project_id: home.project.id, group_id: home.group.id, channel: "esign", status: "approved",
      terms_hash: "b".repeat(64), total_cents: 1000_00, approved_at: "2026-10-01T12:00:00Z",
    })
    const category = (await home.db.query("select category_id from project_selections where id = $1", [selectionId])).rows[0].category_id
    await insert(home.db, "selection_approval_lines", { approval_id: row.id, org_id: home.orgId, project_id: home.project.id, selection_id: selectionId, category_id: category, category_name: "Countertop", price_cents: 1000_00 })
    return row
  }
  const covering = await approval(home.selection.id)
  const otherCategory = await insert(home.db, "selection_categories", { org_id: home.orgId, name: "Paint" })
  const other = await insert(home.db, "project_selections", { org_id: home.orgId, project_id: home.project.id, category_id: otherCategory.id, status: "confirmed" })
  const untouched = await approval(other.id)

  const raised = await home.changeOrder({ co_number: 7 })
  await home.attach(raised.id)
  await home.approve(raised.id)

  const { rows } = await home.db.query("select id, status, void_reason from selection_approvals order by status")
  assert.deepEqual(rows.find((row) => row.id === covering.id), { id: covering.id, status: "voided", void_reason: "CO #7 changed these selections after they were approved" })
  assert.equal(rows.find((row) => row.id === untouched.id).status, "approved")
})

test("a selection that moved after its change order was priced fails the approval and leaves nothing behind", async (t) => {
  const home = await soldSupplyHome(t)
  const raised = await home.changeOrder()
  await home.attach(raised.id)
  await home.db.query("update project_selections set price_cents_snapshot = 1100_00 where id = $1", [home.selection.id])
  assert.equal(await refusalCode(home.approve(raised.id)), "SELECTION_CHANGED_SINCE_CHANGE_ORDER")

  const { rows: [changeOrder] } = await home.db.query("select status from change_orders where id = $1", [raised.id])
  assert.equal(changeOrder.status, "pending")
  assert.equal(await home.count("select count(*) n from purchase_agreement_versions where contract_id = $1", [home.contract.id]), 1)
  assert.equal(await home.count("select count(*) n from commitment_change_orders where prime_change_order_id = $1", [raised.id]), 0)
  assert.equal(await home.count("select count(*) n from budget_revisions where change_order_id = $1", [raised.id]), 0)
  assert.equal(await home.count("select count(*) n from schedule_item_change_orders where change_order_id = $1", [raised.id]), 0)
  assert.equal((await home.row()).selected_option_id, home.laminate.id)
  // An unapproved change order's impact never moves the schedule.
  const pending = await insert(home.db, "schedule_item_change_orders", { org_id: home.orgId, schedule_item_id: home.cabinets.id, change_order_id: raised.id, days_adjusted: 3 })
  assert.equal(await refusalCode(rpc(home.db, "apply_schedule_item_change_order", { p_org_id: home.orgId, p_impact_id: pending.id })), "SCHEDULE_IMPACT_NOT_APPROVED")
})

test("a cost change with no purchase order is a selection exception, and a member never re-prices or deletes a raised variance order", async (t) => {
  const home = await soldSupplyHome(t)
  const tile = await insert(home.db, "cost_codes", { org_id: home.orgId, code: "09-300", name: "Tile" })
  const raised = await home.changeOrder()
  await home.attach(raised.id, [home.change({ cost_code_id: tile.id })])
  await home.db.query("delete from commitment_lines where metadata->>'source_ref' = $1", [home.selection.id])
  await home.approve(raised.id)
  const exceptions = (await home.db.query("select reason, status, detail->>'reason' why from selection_exceptions where change_order_id = $1", [raised.id])).rows
  assert.deepEqual(exceptions, [{ reason: "variance_unrouted", status: "open", why: "no_commitment" }])

  const other = await soldSupplyHome(t)
  const routed = await other.changeOrder()
  await other.attach(routed.id)
  await other.approve(routed.id)
  const [vpo] = (await other.db.query("select id from commitment_change_orders where prime_change_order_id = $1", [routed.id])).rows
  const as = (sql, args) => asRole(other.db, { role: "authenticated", userId: other.owner.userId }, (tx) => tx.query(sql, args))
  await assert.rejects(as("update commitment_change_orders set total_cents = 1 where id = $1", [vpo.id]), /re-priced through purchasing/)
  await assert.rejects(as("update commitment_change_order_lines set amount_cents = 1 where commitment_change_order_id = $1", [vpo.id]), /re-priced through purchasing/)
  await assert.rejects(as("delete from commitment_change_orders where id = $1", [vpo.id]), /void it instead/)
  await assert.rejects(
    as("insert into commitment_change_orders (org_id, project_id, commitment_id, title, origin) values ($1, $2, $3, 'Fake', 'design_studio_co')", [other.orgId, other.project.id, other.owning.id]),
    /raised by the change order/,
  )
  await as("update commitment_change_orders set status = 'sent' where id = $1", [vpo.id])
})

// ---------------------------------------------------------------------------
// EP06 review fixes: no writer walks around the cutoff, the approval or the schedule.
// ---------------------------------------------------------------------------

/** A member of the home with the org role `role`, the way PostgREST would see them. */
async function homeMember(home, role) {
  const member = await seedMember(home.db, { orgId: home.orgId, role })
  await home.db.query(
    "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'pm'",
    [home.orgId, home.project.id, member.userId],
  )
  return member
}

/** A write is refused when it errors or when row security leaves it no row to touch. */
const refused = async (work) => {
  try {
    return (await work).rowCount === 0
  } catch {
    return true
  }
}

test("a member approves a selection change order only with change_order.approve, in their own name, and cannot rewrite its signature or days", async (t) => {
  const home = await supplyHome(t)
  await home.choose(home.laminate.id)
  await home.setCutoff(await home.day(-1), "locked")
  const countertops = await insert(home.db, "cost_codes", { org_id: home.orgId, code: "06-400", name: "Countertops" })
  const raised = await insert(home.db, "change_orders", {
    org_id: home.orgId, project_id: home.project.id, title: "Post-cutoff selection change", status: "pending", lifecycle: "proposed",
    total_cents: 1500_00, requires_signature: true, days_impact: 4,
  })
  const change = {
    selection_id: home.selection.id, old_option_id: home.laminate.id, old_price_cents: 1000_00, old_cost_cents: 400_00,
    new_option_id: home.quartz.id, new_package_id: null, group_id: home.group.id, category_name: "Countertop", option_name: "Quartz",
    price_cents: 2300_00, cost_cents: 1100_00, price_delta_cents: 1300_00, cost_delta_cents: 700_00, cost_code_id: countertops.id,
  }
  await home.db.query("update change_orders set metadata = metadata || jsonb_build_object('selection_change', $2::jsonb) where id = $1", [raised.id, JSON.stringify({ changes: [change], fee_cents: 0 })])

  const agent = await homeMember(home, "org_sales_agent")
  const asAgent = (sql, args) => asRole(home.db, { role: "authenticated", userId: agent.userId }, (tx) => tx.query(sql, args))
  await assert.rejects(asAgent("update change_orders set requires_signature = false where id = $1", [raised.id]), /fixed as raised/)
  await assert.rejects(asAgent("update change_orders set days_impact = 0 where id = $1", [raised.id]), /fixed as raised/)
  await assert.rejects(asAgent("update change_orders set approved_by = $2 where id = $1", [raised.id, agent.userId]), /recorded only when it is approved/)
  await assert.rejects(
    asAgent("update change_orders set status = 'approved', lifecycle = 'approved', approved_by = $2, approved_at = now() where id = $1", [raised.id, agent.userId]),
    /needs change_order.approve/,
  )
  const approver = (userId) => asRole(home.db, { role: "authenticated", userId }, (tx) => tx.query(
    "update change_orders set status = 'approved', lifecycle = 'approved', approved_by = $2, approved_at = now() where id = $1", [raised.id, home.owner.userId]))
  await assert.rejects(approver(agent.userId), /needs change_order.approve/)
  const stranger = await seedMember(home.db, { orgId: home.orgId, role: "org_owner" })
  await assert.rejects(approver(stranger.userId), /own name/)
  assert.equal((await home.row()).selected_option_id, home.laminate.id)
  await approver(home.owner.userId)
  assert.equal((await home.row()).selected_option_id, home.quartz.id)
})

test("a cost change with no cost code fails the approval where costs are coded", async (t) => {
  const home = await soldSupplyHome(t)
  const raised = await home.changeOrder()
  await home.attach(raised.id, [home.change({ cost_code_id: null })])
  assert.equal(await refusalCode(home.approve(raised.id)), "SELECTION_COST_CODE_REQUIRED")
  assert.equal((await home.row()).selected_option_id, home.laminate.id)
})

test("a member withdraws a pending selection only with selections.write and only while its group is open, and opens one only in its category's group", async (t) => {
  const home = await supplyHome(t)
  const agent = await homeMember(home, "org_superintendent")
  const asAgent = (sql, args) => asRole(home.db, { role: "authenticated", userId: agent.userId }, (tx) => tx.query(sql, args))
  const asOwner = (sql, args) => asRole(home.db, { role: "authenticated", userId: home.owner.userId }, (tx) => tx.query(sql, args))
  await insert(home.db, "selection_group_categories", { org_id: home.orgId, group_id: home.group.id, category_id: home.category.id })

  assert.ok(await refused(asAgent("delete from project_selections where id = $1", [home.selection.id])))
  assert.ok(await refused(asAgent("insert into project_selections (org_id, project_id, category_id, group_id, status) values ($1, $2, $3, $4, 'pending')", [home.orgId, home.project.id, home.category.id, home.group.id])))

  await home.setCutoff(await home.day(-1))
  await assert.rejects(asOwner("delete from project_selections where id = $1", [home.selection.id]), /group is closed/)
  await home.setCutoff(await home.day(10), "locked")
  await assert.rejects(asOwner("delete from project_selections where id = $1", [home.selection.id]), /group is closed/)

  await home.setCutoff(await home.day(10), "open")
  await asOwner("delete from project_selections where id = $1", [home.selection.id])
  const insertInto = (groupId) => asOwner("insert into project_selections (org_id, project_id, category_id, group_id, status) values ($1, $2, $3, $4, 'pending')", [home.orgId, home.project.id, home.category.id, groupId])
  await assert.rejects(insertInto(null), /belongs to the deadline group/)
  await home.setCutoff(await home.day(-1))
  await assert.rejects(insertInto(home.group.id), /group is closed/)
  await home.setCutoff(await home.day(10))
  await insertInto(home.group.id)
  assert.equal(Number((await home.db.query("select count(*) n from project_selections where group_id = $1", [home.group.id])).rows[0].n), 1)
})

test("a schedule impact is written by the approval and applied by the superintendent, never by a member", async (t) => {
  const home = await soldSupplyHome(t)
  const raised = await home.changeOrder()
  await home.attach(raised.id)
  await home.approve(raised.id)
  const [impact] = (await home.db.query("select id from schedule_item_change_orders where change_order_id = $1", [raised.id])).rows
  const agent = await homeMember(home, "org_sales_agent")
  for (const userId of [agent.userId, home.owner.userId]) {
    const as = (sql, args) => asRole(home.db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
    assert.ok(await refused(as("update schedule_item_change_orders set days_adjusted = -300, applied_at = now() where id = $1", [impact.id])))
    assert.ok(await refused(as("delete from schedule_item_change_orders where id = $1", [impact.id])))
    assert.ok(await refused(as("insert into schedule_item_change_orders (org_id, schedule_item_id, change_order_id, days_adjusted) values ($1, $2, $3, 1)", [home.orgId, home.cabinets.id, raised.id])))
  }
  const { rows: [kept] } = await home.db.query("select days_adjusted, applied_at from schedule_item_change_orders where id = $1", [impact.id])
  assert.deepEqual(kept, { days_adjusted: 4, applied_at: null })
  const applied = await rpc(home.db, "apply_schedule_item_change_order", { p_org_id: home.orgId, p_impact_id: impact.id })
  assert.equal(applied.days_adjusted, 4)
})

test("the cutoff reminder counts days in the community's day, not the server's", async (t) => {
  const home = await supplyHome(t, { timeZone: "Pacific/Auckland" })
  const reminders = () => rpc(home.db, "selection_cutoff_reminder_groups", { p_days: [7, 14], p_limit: 10 })
  await home.setCutoff(await home.day(7))
  assert.deepEqual((await reminders()).map((row) => [row.id, row.days_remaining, row.group_name]), [[home.instance.id, 7, "Kitchen"]])
  await home.setCutoff(await home.day(9))
  assert.deepEqual(await reminders(), [])
  await home.setCutoff(await home.day(14), "locked")
  assert.deepEqual(await reminders(), [])
})

test("the cutoff reminder pages over a stable order instead of stopping at a limit", async (t) => {
  const home = await supplyHome(t, {})
  await home.setCutoff(await home.day(7))
  const page = (offset) => rpc(home.db, "selection_cutoff_reminder_groups", { p_days: [7, 14], p_limit: 1, p_offset: offset })
  assert.equal((await page(0)).length, 1)
  assert.deepEqual(await page(1), [])
})

test("a change order's metadata is merged by patch, keeping what a job stamped since", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const changeOrder = await insert(db, "change_orders", { org_id: orgId, project_id: project.id, title: "Swap", metadata: JSON.stringify({ selection_change_follow_up: { event_recorded: true } }) })
  await rpc(db, "merge_change_order_metadata", { p_org_id: orgId, p_change_order_id: changeOrder.id, p_patch: JSON.stringify({ envelope_effects_completed: true }) })
  const { rows } = await db.query("select metadata from public.change_orders where id = $1", [changeOrder.id])
  assert.deepEqual(rows[0].metadata, { selection_change_follow_up: { event_recorded: true }, envelope_effects_completed: true })
  assert.equal(await refusalCode(rpc(db, "merge_change_order_metadata", { p_org_id: orgId, p_change_order_id: uuid(), p_patch: "{}" })), "Change order not found")
})

test("a member cannot re-point a selection, void an applied selection change order, or probe another org's group", async (t) => {
  const home = await soldSupplyHome(t)
  const owner = { role: "authenticated", userId: home.owner.userId }
  const outsider = await seedMember(home.db)
  const otherCategory = await insert(home.db, "selection_categories", { org_id: home.orgId, name: "Flooring" })
  await assert.rejects(
    asRole(home.db, owner, (tx) => tx.query("update project_selections set category_id = $2 where id = $1", [home.selection.id, otherCategory.id])),
    /stays in its category/,
  )

  const raised = await home.changeOrder()
  await home.attach(raised.id)
  await home.approve(raised.id)
  await assert.rejects(
    home.db.query("update change_orders set lifecycle = 'void', status = 'cancelled' where id = $1", [raised.id]),
    /cannot be voided/,
  )
  assert.equal((await home.db.query("select lifecycle from change_orders where id = $1", [raised.id])).rows[0].lifecycle, "approved")

  const isOpen = (db, who, orgId) => asRole(db, who, (tx) => tx.query("select public.project_selection_group_is_open($1, $2, $3) open", [orgId, home.project.id, home.group.id]))
  await home.setCutoff(await home.day(10), "open")
  assert.equal((await isOpen(home.db, owner, home.orgId)).rows[0].open, true)
  assert.equal((await isOpen(home.db, { role: "authenticated", userId: outsider.userId }, home.orgId)).rows[0].open, false)
})
