"use strict"

/**
 * `sellable_lot_inventory`: the asking price of a home for sale is the same
 * for everyone allowed to see the sales desk. project_selections is limited to
 * project members, so the view must price a home's confirmed structural
 * options without handing out the selections themselves.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember, asRole } = require("./support/pglite")

async function specHome(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const consultant = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const stranger = await seedMember(db)
  const { orgId } = owner

  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge" })
  const plan = await insert(db, "house_plans", { org_id: orgId, code: "A100", name: "Aspen" })
  const sheet = (patch) => insert(db, "community_plan_availability", { org_id: orgId, community_id: community.id, house_plan_id: plan.id, base_price_cents: 389_000_00, ...patch })
  await sheet({})
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 5 spec" })
  const lot = await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "5", status: "started", house_plan_id: plan.id, project_id: project.id, premium_cents: 6_000_00 })
  const option = async (categoryName, scope) => {
    const category = await insert(db, "selection_categories", { org_id: orgId, name: categoryName })
    const row = await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: `${categoryName} option`, option_scope: scope })
    return (status, cents) =>
      insert(db, "project_selections", { org_id: orgId, project_id: project.id, category_id: category.id, selected_option_id: row.id, status, price_cents_snapshot: cents })
  }
  return { db, owner, consultant, stranger, lot, project, sheet, plan, structural: await option("Structure", "structural"), finish: await option("Counters", "design_studio") }
}

const askingPrice = (db, actor, lotId) =>
  asRole(db, { role: "authenticated", userId: actor.userId }, async (tx) =>
    (await tx.query("select asking_price_cents from sellable_lot_inventory where lot_id = $1", [lotId])).rows[0]?.asking_price_cents,
  )

test("a sales consultant who is not on the project sees the same price as the owner, structural options included", async (t) => {
  const { db, owner, consultant, lot, structural, finish } = await specHome(t)
  await structural("confirmed", 18_500_00)
  await finish("confirmed", 9_000_00)

  const readable = await asRole(db, { role: "authenticated", userId: consultant.userId }, async (tx) => (await tx.query("select count(*)::int n from project_selections")).rows[0].n)
  assert.equal(readable, 0, "the consultant cannot read the home's selections")
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 413_500_00)
  assert.equal(Number(await askingPrice(db, consultant, lot.id)), 413_500_00)
})

test("a pending structural option does not price the home, and another organisation reads nothing", async (t) => {
  const { db, consultant, stranger, lot, project, structural } = await specHome(t)
  await structural("pending", 18_500_00)

  assert.equal(Number(await askingPrice(db, consultant, lot.id)), 395_000_00)

  await db.query("update project_selections set status = 'confirmed' where project_id = $1", [project.id])
  const seen = await asRole(db, { role: "authenticated", userId: stranger.userId }, async (tx) => ({
    view: (await tx.query("select count(*)::int n from sellable_lot_inventory where lot_id = $1", [lot.id])).rows[0].n,
    options: (await tx.query("select public.project_structural_option_cents($1) cents", [project.id])).rows[0].cents,
  }))
  assert.deepEqual(seen, { view: 0, options: null })
})

test("the price comes from the community sheet: an elevation's own row outranks the plan-wide one, and only rows on sale today count", async (t) => {
  const { db, owner, lot, sheet, plan } = await specHome(t)
  const elevation = await insert(db, "house_plan_elevations", { org_id: owner.orgId, house_plan_id: plan.id, code: "B", name: "Craftsman" })
  await db.query("update lots set house_plan_elevation_id = $1 where id = $2", [elevation.id, lot.id])

  const own = await sheet({ elevation_id: elevation.id, base_price_cents: 399_000_00 })
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 405_000_00)

  await db.query("update community_plan_availability set effective_end = current_date - 1 where id = $1", [own.id])
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 395_000_00, "the ended elevation row falls back to the plan-wide row")

  await db.query("update community_plan_availability set is_available = false where elevation_id is null")
  assert.equal(await askingPrice(db, owner, lot.id), null, "nothing on sale today leaves the home unpriced")
})

test("a price the manager set outranks the sheet", async (t) => {
  const { db, owner, lot } = await specHome(t)
  await db.query("update lots set asking_price_override_cents = $1 where id = $2", [412_340_00, lot.id])
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 412_340_00)
})

test("the sheet is the sales manager's: a member without sales.manage reads it but moves no home's price through it", async (t) => {
  const { db, owner, consultant, lot, plan } = await specHome(t)
  const { userId: field } = await seedMember(db, { orgId: owner.orgId, role: "field" })
  const as = (userId, sql, args = [plan.id]) => asRole(db, { role: "authenticated", userId }, async (tx) => (await tx.query(sql, args)).rowCount)

  assert.equal(await as(field, "select 1 from community_plan_availability where house_plan_id = $1"), 1)
  assert.equal(await as(field, "update community_plan_availability set base_price_cents = 30000000 where house_plan_id = $1"), 0)
  assert.equal(await as(field, "update community_plan_availability set is_available = false where house_plan_id = $1"), 0)
  assert.equal(await as(field, "delete from community_plan_availability where house_plan_id = $1"), 0)
  await assert.rejects(
    as(field, "insert into community_plan_availability (org_id, community_id, house_plan_id, base_price_cents, is_available) select org_id, community_id, house_plan_id, 1, true from community_plan_availability where house_plan_id = $1"),
    /row-level security/,
  )
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 395_000_00)

  assert.equal(await as(consultant.userId, "update community_plan_availability set base_price_cents = 39900000 where house_plan_id = $1"), 1)
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 405_000_00)
})

test("an option's scope and the catalog's prices are the catalog manager's: a member's direct write moves no home's price", async (t) => {
  const { db, owner, lot, structural } = await specHome(t)
  const { selected_option_id: optionId } = await structural("confirmed", 18_500_00)
  const { userId: field } = await seedMember(db, { orgId: owner.orgId, role: "field" })
  const { userId: coordinator } = await seedMember(db, { orgId: owner.orgId, role: "org_design_studio_coordinator" })
  const pkg = await insert(db, "selection_packages", { org_id: owner.orgId, name: "Outdoor living", price_cents: 12_000_00 })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, async (tx) => (await tx.query(sql, args)).rowCount)
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 413_500_00)

  assert.equal(await as(field, "select 1 from selection_options where id = $1", [optionId]), 1)
  assert.equal(await as(field, "update selection_options set option_scope = 'design_studio' where id = $1", [optionId]), 0)
  assert.equal(await as(field, "update selection_packages set price_cents = 1 where id = $1", [pkg.id]), 0)
  assert.equal(await as(field, "delete from selection_options where id = $1", [optionId]), 0)
  await assert.rejects(
    as(field, "insert into selection_options (org_id, category_id, name, option_scope) select org_id, category_id, 'Loft', 'structural' from selection_options where id = $1", [optionId]),
    /row-level security/,
  )
  assert.equal(Number(await askingPrice(db, owner, lot.id)), 413_500_00)

  assert.equal(await as(coordinator, "update selection_packages set price_cents = 13000000 where id = $1", [pkg.id]), 1)
})

test("a community's incentives are the sales manager's: a member neither raises nor approves one", async (t) => {
  const { db, owner, consultant } = await specHome(t)
  const { userId: field } = await seedMember(db, { orgId: owner.orgId, role: "field" })
  const { rows: [{ id: communityId }] } = await db.query("select community_id as id from lots limit 1")
  const incentive = await insert(db, "incentives", { org_id: owner.orgId, community_id: communityId, name: "Closing costs", incentive_type: "fixed_amount", amount_cents: 5_000_00, applies_to: "price", status: "active", requires_approval: true })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, async (tx) => (await tx.query(sql, args)).rowCount)

  assert.equal(await as(field, "select 1 from incentives where id = $1", [incentive.id]), 1)
  assert.equal(await as(field, "update incentives set amount_cents = 50000000, metadata = jsonb_build_object('approved_at', now()::text) where id = $1", [incentive.id]), 0)
  assert.equal(await as(field, "delete from incentives where id = $1", [incentive.id]), 0)
  await assert.rejects(
    as(field, "insert into incentives (org_id, community_id, name, incentive_type, amount_cents, applies_to, status, requires_approval) values ($1, $2, 'Rate buydown', 'fixed_amount', 9000000, 'price', 'active', false)", [owner.orgId, communityId]),
    /row-level security/,
  )

  assert.equal(await as(consultant.userId, "update incentives set metadata = jsonb_build_object('approved_at', now()::text) where id = $1", [incentive.id]), 1)
  const { rows } = await db.query("select amount_cents::int as amount, metadata ? 'approved_at' as approved from incentives")
  assert.deepEqual(rows, [{ amount: 5_000_00, approved: true }])
})

test("a home ages from its Books completion, else from the completion sales recorded, and never from a future date", async (t) => {
  const { db, owner, lot, project } = await specHome(t)
  const agingDays = () =>
    asRole(db, { role: "authenticated", userId: owner.userId }, async (tx) =>
      (await tx.query("select aging_days from sellable_lot_inventory where lot_id = $1", [lot.id])).rows[0].aging_days,
    )
  assert.equal(await agingDays(), 0, "no recorded completion, no age")

  await db.query("update projects set completed_on = current_date - 30 where id = $1", [project.id])
  assert.equal(await agingDays(), 30)

  await insert(db, "project_financial_settings", { org_id: owner.orgId, project_id: project.id, books_inventory_completed_on: new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10) })
  assert.equal(await agingDays(), 45, "Books' date wins")

  await db.query("update project_financial_settings set books_inventory_completed_on = null where project_id = $1", [project.id])
  await db.query("update projects set completed_on = current_date + 3 where id = $1", [project.id])
  assert.equal(await agingDays(), 0, "a completion that has not arrived does not start the clock")
})
