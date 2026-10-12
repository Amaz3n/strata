"use strict"

/**
 * Entitlements and their conditions are community facts: they stay inside
 * their community, a condition narrows its approval to a phase but never widens
 * it, and a division-restricted member reaches neither another division's
 * approvals nor their search entries.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

async function entitledOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const hawthorne = await insert(db, "communities", { org_id: orgId, name: "Hawthorne", division_id: north.id })
  const cedar = await insert(db, "communities", { org_id: orgId, name: "Cedar", division_id: south.id })
  const phaseOne = await insert(db, "community_phases", { org_id: orgId, community_id: hawthorne.id, name: "Phase 1", phase_number: 1 })
  const phaseTwo = await insert(db, "community_phases", { org_id: orgId, community_id: hawthorne.id, name: "Phase 2", phase_number: 2 })
  const cedarPhase = await insert(db, "community_phases", { org_id: orgId, community_id: cedar.id, name: "Phase 1", phase_number: 1 })
  const { userId: southManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const { rows } = await db.query(
    "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id",
    [orgId, southManager],
  )
  await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: south.id })
  const plat = await insert(db, "land_entitlements", {
    org_id: orgId, community_id: hawthorne.id, kind: "final_plat", name: "Final plat", required_before: "lot_delivery",
  })
  return { db, orgId, ownerId, north, south, hawthorne, cedar, phaseOne, phaseTwo, cedarPhase, southManager, plat }
}

test("an entitlement's phase belongs to its community", async (t) => {
  const { db, orgId, hawthorne, cedarPhase } = await entitledOrg(t)

  await assert.rejects(
    insert(db, "land_entitlements", {
      org_id: orgId, community_id: hawthorne.id, community_phase_id: cedarPhase.id, kind: "site_plan", name: "Site plan",
    }),
    /phase does not belong to this community/,
  )
})

test("a condition sits in its entitlement's community and narrows to a phase, never widens", async (t) => {
  const { db, orgId, hawthorne, cedar, phaseOne, phaseTwo, plat } = await entitledOrg(t)
  const phased = await insert(db, "land_entitlements", {
    org_id: orgId, community_id: hawthorne.id, community_phase_id: phaseOne.id, kind: "site_plan", name: "Phase 1 site plan",
  })

  await insert(db, "land_entitlement_conditions", {
    org_id: orgId, entitlement_id: plat.id, community_id: hawthorne.id, community_phase_id: phaseTwo.id, title: "Signal at FM 1431",
  })
  await assert.rejects(
    insert(db, "land_entitlement_conditions", { org_id: orgId, entitlement_id: plat.id, community_id: cedar.id, title: "Wrong community" }),
    /entitlement's community/,
  )
  await assert.rejects(
    insert(db, "land_entitlement_conditions", { org_id: orgId, entitlement_id: phased.id, community_id: hawthorne.id, title: "Whole community" }),
    /never widen/,
  )
  await assert.rejects(
    insert(db, "land_entitlement_conditions", {
      org_id: orgId, entitlement_id: phased.id, community_id: hawthorne.id, community_phase_id: phaseTwo.id, title: "Other phase",
    }),
    /never widen/,
  )
})

test("narrowing an entitlement to a phase narrows its conditions with it", async (t) => {
  const { db, orgId, hawthorne, phaseOne, plat } = await entitledOrg(t)
  const condition = await insert(db, "land_entitlement_conditions", {
    org_id: orgId, entitlement_id: plat.id, community_id: hawthorne.id, title: "Dedicate right-of-way",
  })

  await db.query("update land_entitlements set community_phase_id = $2 where id = $1", [plat.id, phaseOne.id])

  const { rows } = await db.query("select community_phase_id from land_entitlement_conditions where id = $1", [condition.id])
  assert.equal(rows[0].community_phase_id, phaseOne.id)
})

test("an approval needs its date, a met condition its date, and a waiver its reason", async (t) => {
  const { db, orgId, hawthorne, plat } = await entitledOrg(t)
  const condition = await insert(db, "land_entitlement_conditions", {
    org_id: orgId, entitlement_id: plat.id, community_id: hawthorne.id, title: "Detention pond as-builts",
  })

  await assert.rejects(db.query("update land_entitlements set status = 'approved' where id = $1", [plat.id]), /approved_check/)
  await assert.rejects(db.query("update land_entitlement_conditions set status = 'met' where id = $1", [condition.id]), /met_check/)
  await assert.rejects(
    db.query("update land_entitlement_conditions set status = 'waived', waived_reason = 'later' where id = $1", [condition.id]),
    /waiver_check/,
  )
  await assert.rejects(db.query("update land_entitlements set community_id = gen_random_uuid() where id = $1", [plat.id]), /cannot move/)
})

test("a division-restricted member reaches neither another division's entitlements nor their search entries", async (t) => {
  const { db, orgId, hawthorne, cedar, southManager, plat } = await entitledOrg(t)
  await insert(db, "land_entitlement_conditions", { org_id: orgId, entitlement_id: plat.id, community_id: hawthorne.id, title: "Signal" })
  const cedarZoning = await insert(db, "land_entitlements", { org_id: orgId, community_id: cedar.id, kind: "zoning", name: "Cedar zoning" })
  await insert(db, "search_documents", { org_id: orgId, entity_type: "land_entitlement", entity_id: plat.id, title: "Final plat" })
  await insert(db, "search_documents", { org_id: orgId, entity_type: "land_entitlement", entity_id: cedarZoning.id, title: "Cedar zoning" })

  const seen = await asRole(db, { role: "authenticated", userId: southManager }, async (tx) => ({
    entitlements: (await tx.query("select name from land_entitlements order by name")).rows.map((row) => row.name),
    conditions: (await tx.query("select title from land_entitlement_conditions")).rows.length,
    search: (await tx.query("select title from search_documents where entity_type = 'land_entitlement'")).rows.map((row) => row.title),
  }))
  assert.deepEqual(seen, { entitlements: ["Cedar zoning"], conditions: 0, search: ["Cedar zoning"] })

  await assert.rejects(
    asRole(db, { role: "authenticated", userId: southManager }, (tx) =>
      tx.query("insert into land_entitlements (org_id, community_id, kind, name) values ($1, $2, 'zoning', 'Planted')", [orgId, hawthorne.id]),
    ),
    /row-level security/,
  )
})
