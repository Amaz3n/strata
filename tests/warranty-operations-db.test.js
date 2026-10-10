"use strict"

/**
 * The database contract behind `lib/services/warranty-operations.ts`: who may
 * write warranty terms and coverage, that a home's coverage snapshot is fixed
 * at enrollment, that one assignee cannot be booked into two houses at once,
 * and that a completion nobody verified cannot have its cost approved.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function home(t) {
  const db = await createDatabase(t)
  const manager = await seedMember(db, { role: "org_owner" })
  const member = await seedMember(db, { orgId: manager.orgId, role: "pm" })
  const orgId = manager.orgId
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const program = await insert(db, "warranty_programs", { org_id: orgId, name: "Standard", is_default: true })
  const term = await insert(db, "warranty_coverage_terms", { org_id: orgId, program_id: program.id, key: "workmanship", label: "Workmanship", duration_months: 12 })
  const request = await insert(db, "warranty_requests", { org_id: orgId, project_id: project.id, request_number: 1, title: "Leak under sink" })
  return { db, orgId, manager, member, project, program, term, request }
}

const asUser = (db, userId, sql, params) =>
  asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, params))

test("any member reads warranty terms; only a warranty manager changes them", async (t) => {
  const { db, manager, member, term } = await home(t)

  const { rows } = await asUser(db, member.userId, "select id from warranty_coverage_terms")
  assert.deepEqual(rows.map((row) => row.id), [term.id])

  const edited = await asUser(db, member.userId, "update warranty_coverage_terms set duration_months = 120 returning id")
  assert.deepEqual(edited.rows, [])
  await assert.rejects(asUser(db, member.userId, "insert into warranty_coverage_terms (org_id, program_id, key, label, duration_months) select org_id, program_id, 'roof', 'Roof', 60 from warranty_coverage_terms"))

  const managed = await asUser(db, manager.userId, "update warranty_coverage_terms set duration_months = 24 returning duration_months")
  assert.deepEqual(managed.rows, [{ duration_months: 24 }])
})

test("a home's coverage terms are fixed once enrolled, for every writer", async (t) => {
  const { db, orgId, manager, project, program } = await home(t)
  const snapshot = [{ key: "workmanship", label: "Workmanship", duration_months: 12, is_structural: false, description: null, expires_on: "2027-10-01" }]
  await insert(db, "project_warranty_coverage", { org_id: orgId, project_id: project.id, program_id: program.id, effective_date: "2026-10-01", terms_snapshot: JSON.stringify(snapshot) })

  await assert.rejects(
    db.query("update project_warranty_coverage set terms_snapshot = $1", [JSON.stringify([{ ...snapshot[0], expires_on: "2036-10-01" }])]),
    /fixed at enrollment/,
  )
  await assert.rejects(db.query("update project_warranty_coverage set effective_date = '2026-12-01'"), /fixed at enrollment/)
  // Carrier details are not the snapshot and stay editable.
  const carrier = await asUser(db, manager.userId, "update project_warranty_coverage set structural_carrier = 'StrucSure' returning structural_carrier")
  assert.deepEqual(carrier.rows, [{ structural_carrier: "StrucSure" }])
  await assert.rejects(asUser(db, manager.userId, "delete from project_warranty_coverage"), /permission denied/)
})

test("one technician cannot hold two overlapping visits unless dispatch marked the overlap", async (t) => {
  const { db, orgId, manager, project, request } = await home(t)
  const visit = (overrides) =>
    insert(db, "warranty_service_visits", {
      org_id: orgId, request_id: request.id, project_id: project.id, assignee_kind: "tech", assigned_user_id: manager.userId,
      window_start: "2026-10-12T14:00:00Z", window_end: "2026-10-12T16:00:00Z", ...overrides,
    })
  await visit({ visit_number: 1 })
  await assert.rejects(visit({ visit_number: 2, window_start: "2026-10-12T15:00:00Z", window_end: "2026-10-12T17:00:00Z" }), /no_double_book/)
  // Back to back is not an overlap, and a deliberate double-booking is allowed.
  await visit({ visit_number: 2, window_start: "2026-10-12T16:00:00Z", window_end: "2026-10-12T17:00:00Z" })
  await visit({ visit_number: 3, window_start: "2026-10-12T15:00:00Z", window_end: "2026-10-12T17:00:00Z", overlap_allowed: true })
  // A canceled visit no longer holds its window.
  await db.query("update warranty_service_visits set status = 'canceled' where visit_number = 1")
  await visit({ visit_number: 4 })
})

test("a completion awaiting verification, or sent back, cannot have its cost approved", async (t) => {
  const { db, orgId, manager, project, request } = await home(t)
  const visit = await insert(db, "warranty_service_visits", {
    org_id: orgId, request_id: request.id, project_id: project.id, visit_number: 1, assignee_kind: "tech", assigned_user_id: manager.userId,
    window_start: "2026-10-12T14:00:00Z", window_end: "2026-10-12T16:00:00Z", status: "completed", outcome: "resolved",
  })
  const approve = () =>
    rpc(db, "approve_books_warranty_cost", {
      p_org_id: orgId, p_visit_id: visit.id, p_date: "2026-10-13", p_sources: JSON.stringify([{ job_cost_entry_id: request.id, amount_cents: 100 }]),
      p_evidence_url: "https://example.test/receipt", p_actor_id: manager.userId,
    })

  await db.query("update warranty_requests set metadata = jsonb_build_object('pending_verification', true, 'completed_visit_id', $1::text)", [visit.id])
  await assert.rejects(approve(), /Verify the warranty visit/)
  await db.query("update warranty_requests set metadata = jsonb_build_object('pending_verification', false, 'rejected_visit_id', $1::text)", [visit.id])
  await assert.rejects(approve(), /Verify the warranty visit/)
  // Verified: the approval proceeds to its own source checks.
  await db.query("update warranty_requests set metadata = jsonb_build_object('pending_verification', false, 'verified_visit_id', $1::text)", [visit.id])
  await assert.rejects(approve(), /posted costs/)
})

test("an office resolution recorded without a photo or sign-off waits for verification", async (t) => {
  const { db, orgId, manager, project, request } = await home(t)
  const complete = async (visitNumber, input) => {
    const visit = await insert(db, "warranty_service_visits", {
      org_id: orgId, request_id: request.id, project_id: project.id, visit_number: visitNumber, assignee_kind: "tech", assigned_user_id: manager.userId,
      window_start: `2026-10-1${visitNumber}T14:00:00Z`, window_end: `2026-10-1${visitNumber}T16:00:00Z`,
    })
    const [current] = (await db.query("select updated_at from warranty_requests where id = $1", [request.id])).rows
    await rpc(db, "complete_warranty_visit_atomic", {
      p_org_id: orgId, p_visit_id: visit.id, p_actor_id: manager.userId,
      p_expected_visit_at: visit.updated_at, p_expected_request_at: current.updated_at, p_input: JSON.stringify({ outcome: "resolved", ...input }),
    })
    return (await db.query("select status, metadata from warranty_requests where id = $1", [request.id])).rows[0]
  }

  const bare = await complete(1, {})
  assert.equal(bare.status, "in_progress")
  assert.equal(bare.metadata.pending_verification, true)

  const signed = await complete(2, { buyer_signoff_name: "Dana Buyer" })
  assert.equal(signed.status, "resolved")
  assert.equal(signed.metadata.pending_verification, false)
})

test("any member reads routing rules, only a warranty manager writes them, and a rule names exactly one owner", async (t) => {
  const { db, orgId, manager, member } = await home(t)
  const rule = { org_id: orgId, name: "Emergencies", severity: "emergency", assignee_kind: "tech", assigned_user_id: manager.userId }

  await assert.rejects(asUser(db, member.userId, "insert into warranty_routing_rules (org_id, name, assignee_kind, assigned_user_id) values ($1, 'Mine', 'tech', $2)", [orgId, member.userId]))
  await insert(db, "warranty_routing_rules", rule)

  const read = await asUser(db, member.userId, "select name from warranty_routing_rules")
  assert.deepEqual(read.rows, [{ name: "Emergencies" }])
  const edited = await asUser(db, member.userId, "update warranty_routing_rules set priority = 1 returning id")
  assert.deepEqual(edited.rows, [])
  const managed = await asUser(db, manager.userId, "update warranty_routing_rules set priority = 1 returning priority")
  assert.deepEqual(managed.rows, [{ priority: 1 }])

  // A trade rule cannot also name a technician, and a rule must name somebody.
  await assert.rejects(insert(db, "warranty_routing_rules", { ...rule, name: "Both", assignee_kind: "trade", assigned_company_id: null }), /check/)
  await assert.rejects(insert(db, "warranty_routing_rules", { org_id: orgId, name: "Nobody", assignee_kind: "tech" }), /check/)
})

test("a homeowner's answer to an appointment is stored apart from the trade's confirmation", async (t) => {
  const { db, orgId, manager, project, request } = await home(t)
  const visit = await insert(db, "warranty_service_visits", {
    org_id: orgId, request_id: request.id, project_id: project.id, visit_number: 1, assignee_kind: "tech", assigned_user_id: manager.userId,
    window_start: "2026-10-12T14:00:00Z", window_end: "2026-10-12T16:00:00Z",
  })
  assert.equal(visit.buyer_confirmed_at, null)
  const { rows } = await db.query("update warranty_service_visits set buyer_confirmed_at = now() where id = $1 returning buyer_confirmed_at, confirmed_at", [visit.id])
  assert.ok(rows[0].buyer_confirmed_at)
  assert.equal(rows[0].confirmed_at, null)
})
