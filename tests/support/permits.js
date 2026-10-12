"use strict"

/**
 * A production home ready for permitting, on the full migrated schema: a
 * coordinator, a viewer and an office admin in one org; a community with its
 * permitting authority; a lot pinned to a released plan and elevation with its
 * home and an open start package carrying the permit and plot-plan gates.
 *
 *   const w = await permitWorld(t)
 *   const appId = await w.call("create_permit_application", { p_project_id: w.home.id, ... })
 *
 * `call` runs a permits function as a signed-in member (the coordinator unless
 * another user id is given), the way the service calls it through PostgREST.
 */

const full = require("./pglite")

async function permitWorld(t, { coordinatorRole = "org_starts_coordinator" } = {}) {
  const db = await full.createDatabase(t)
  const coordinator = await full.seedMember(db, { role: coordinatorRole })
  const orgId = coordinator.orgId
  const viewer = await full.seedMember(db, { orgId, role: "org_viewer" })
  const office = await full.seedMember(db, { orgId, role: "org_office_admin" })
  const authority = await full.insert(db, "companies", { org_id: orgId, name: "Collier County Growth Management" })
  const otherAuthority = await full.insert(db, "companies", { org_id: orgId, name: "City of Naples" })
  const community = await full.insert(db, "communities", { org_id: orgId, name: "Harbor Point", permit_jurisdiction_company_id: authority.id })
  const plan = await full.insert(db, "house_plans", { org_id: orgId, code: "MG1650", name: "The Mangrove" })
  const released = { status: "released", released_at: "2026-08-01T00:00:00Z", released_by: coordinator.userId, bundle_snapshot: {} }
  const version = await full.insert(db, "house_plan_versions", { org_id: orgId, house_plan_id: plan.id, version_number: 1, ...released, status: "superseded" })
  const nextVersion = await full.insert(db, "house_plan_versions", { org_id: orgId, house_plan_id: plan.id, version_number: 2, ...released })
  const elevation = await full.insert(db, "house_plan_elevations", { org_id: orgId, house_plan_id: plan.id, code: "A" })
  const home = await full.insert(db, "projects", { org_id: orgId, name: "Harbor Point 7" })
  const otherHome = await full.insert(db, "projects", { org_id: orgId, name: "Harbor Point 8" })
  const lot = await full.insert(db, "lots", {
    org_id: orgId, community_id: community.id, project_id: home.id, lot_number: "7", status: "assigned",
    house_plan_id: plan.id, house_plan_version_id: version.id, house_plan_elevation_id: elevation.id,
  })
  await full.insert(db, "lots", { org_id: orgId, community_id: community.id, project_id: otherHome.id, lot_number: "8", status: "assigned" })
  const pkg = await full.insert(db, "start_packages", { org_id: orgId, lot_id: lot.id, community_id: community.id, project_id: home.id, status: "open" })
  const definition = (row) => full.insert(db, "start_gate_definitions", { org_id: orgId, check_kind: "auto", applies_when: "always", ...row })
  const gates = {
    permit: await full.insert(db, "start_package_gates", {
      org_id: orgId, start_package_id: pkg.id,
      gate_definition_id: (await definition({ key: "permit", label: "Approved permit for this plan", auto_source: "permit_approved", sort_order: 10 })).id,
    }),
    plot: await full.insert(db, "start_package_gates", {
      org_id: orgId, start_package_id: pkg.id,
      gate_definition_id: (await definition({ key: "plot_plan", label: "Plot/site plan on file", auto_source: "plot_plan_file", sort_order: 20 })).id,
    }),
  }

  const w = { db, orgId, coordinator, viewer, office, authority, otherAuthority, community, plan, version, nextVersion, elevation, home, otherHome, lot, pkg, gates }

  /** A file row on a home: the stack has no storage, and the record is what permits cite. */
  w.file = async (name, projectId = home.id) =>
    (await full.insert(db, "files", { org_id: orgId, project_id: projectId, file_name: name, storage_path: `permits/${full.uuid()}/${name}` })).id

  w.call = (name, args, userId = coordinator.userId) =>
    full.rpc(db, name, { p_org_id: orgId, ...args }, { role: "authenticated", userId })

  w.row = async (sql, params = []) => (await db.query(sql, params)).rows[0]
  w.rows = async (sql, params = []) => (await db.query(sql, params)).rows

  w.open = (args = {}) => w.call("create_permit_application", {
    p_project_id: home.id, p_jurisdiction_company_id: authority.id, p_permit_type: "building", p_owner_user_id: null, p_supersedes_id: null, ...args,
  })
  w.attach = async (applicationId, kind, fileId) => w.call("set_permit_document", {
    p_application_id: applicationId, p_document_kind: kind, p_label: null, p_required_for: null, p_file_id: fileId,
  })
  w.submit = (applicationId, args = {}) => w.call("record_permit_submission", {
    p_application_id: applicationId, p_submitted_on: "2026-09-01", p_reference: null, p_note: null, p_responds_to_round_id: null, ...args,
  })
  w.decide = (applicationId, args = {}) => w.call("record_permit_decision", {
    p_application_id: applicationId, p_decision: "approved", p_decided_on: "2026-09-20", p_permit_number: "BLD-26-0412",
    p_issued_on: null, p_expires_on: null, p_issued_permit_file_id: null, p_approved_plans_file_id: null, p_note: null, ...args,
  })
  w.fee = (applicationId, args = {}) => w.call("assess_permit_fee", {
    p_application_id: applicationId, p_kind: "permit", p_description: null, p_amount_cents: 218000, p_assessed_on: "2026-09-02",
    p_due_before: "issuance", p_cost_code_id: null, p_replaces_fee_id: null, ...args,
  })
  w.bill = (row = {}) => full.insert(db, "vendor_bills", {
    org_id: orgId, project_id: home.id, company_id: authority.id, bill_number: `PRMT-${full.uuid().slice(-4)}`, status: "pending", total_cents: 218000, ...row,
  })
  w.expense = (row = {}) => full.insert(db, "project_expenses", {
    org_id: orgId, project_id: home.id, vendor_company_id: authority.id, expense_date: "2026-09-02", amount_cents: 45000, status: "submitted", ...row,
  })

  /** A building application submitted with its plot plan, approved on its evidence. */
  w.approvedApplication = async () => {
    const applicationId = await w.open()
    await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
    await w.submit(applicationId)
    await w.decide(applicationId, { p_issued_permit_file_id: await w.file("permit.pdf"), p_approved_plans_file_id: await w.file("approved-plans.pdf") })
    return applicationId
  }

  /** What the database says about the package's gate, as the starts service asks it. */
  w.evidence = (source) => full.rpc(db, "start_gate_sql_evidence", { p_org_id: orgId, p_package_id: pkg.id, p_source: source })

  return w
}

module.exports = { permitWorld }
