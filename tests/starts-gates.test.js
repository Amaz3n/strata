require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { ORG, PACKAGE, PROJECT, VERSION, buildHarness, releasingFixture } = require("./support/starts-harness")

const GATE_DEFINITIONS = [
  { key: "plot_plan", label: "Plot/site plan on file", check_kind: "auto", auto_source: "plot_plan_file", applies_when: "always", sort_order: 20 },
  { key: "selections_locked", label: "Structural selections locked", check_kind: "auto", auto_source: "selections_locked", applies_when: "always", sort_order: 30 },
  { key: "plan_pinned", label: "Plan version & elevation pinned", check_kind: "auto", auto_source: "plan_pinned", applies_when: "always", sort_order: 40 },
  { key: "price_book", label: "Price book resolves", check_kind: "auto", auto_source: "po_exceptions_clear", applies_when: "purchasing_enabled", sort_order: 50 },
  { key: "final_approval", label: "Final start approval", check_kind: "manual", auto_source: null, applies_when: "always", sort_order: 90 },
]

/** An open package whose gates have never been evaluated. */
function gateFixture(overrides = {}) {
  const tables = releasingFixture({ purchasing: overrides.purchasing ?? true, packageStatus: "open" })
  tables.start_gate_definitions = GATE_DEFINITIONS.map((definition, index) => ({
    id: `def-${index}`, org_id: ORG, is_active: true, requires_attestation_permission: null,
    description: null, ...definition,
  }))
  tables.start_package_gates = tables.start_gate_definitions.map((definition, index) => ({
    id: `gate-${definition.key}`, org_id: ORG, start_package_id: PACKAGE, gate_definition_id: definition.id,
    status: "pending", passed_via: null, attested_by: null, attested_at: null, waived_reason: null,
    evidence_file_id: null, created_at: `2026-09-01T00:0${index}:00.000Z`, definition, attested_user: null,
  }))
  tables.lots[0].house_plan_version_id = VERSION
  tables.lots[0].house_plan_elevation_id = "elev-1"
  tables.lots[0].version = { status: "released", house_plan_id: "plan-1" }
  tables.lots[0].delivered_at = "2026-01-01T00:00:00.000Z"
  tables.community_plan_availability = overrides.offering ?? [
    { id: "cpa-1", org_id: ORG, community_id: tables.lots[0].community_id, house_plan_id: "plan-1", elevation_id: null, is_available: true, effective_start: null, effective_end: null },
  ]
  tables.files = [{ id: "file-1", org_id: ORG, project_id: PROJECT, archived_at: null, metadata: { document_kind: "plot_plan" } }]
  tables.project_selection_groups = overrides.selectionGroups ?? []
  tables.po_generation_runs = overrides.poRuns ?? []
  tables.po_generation_exceptions = overrides.poExceptions ?? []
  tables.budgets = []
  return tables
}

/** Always re-required: the service closes over whichever harness is installed. */
function loadStarts() {
  delete require.cache[require.resolve("@/lib/services/starts")]
  return require("@/lib/services/starts")
}

function statusOf(gates, key) {
  return gates.find((gate) => gate.key === key)?.status
}

test("a house with no selection groups does NOT satisfy the selections gate", async () => {
  // The vacuous-truth bug: "zero open groups" is trivially true before the
  // groups exist, so the one gate that stops a house starting on unlocked
  // structural selections passed on every package, every time.
  const harness = buildHarness({ tables: gateFixture({ selectionGroups: [] }), instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }) })
  const gates = await loadStarts().refreshAutoGates(PACKAGE)

  assert.equal(statusOf(gates, "selections_locked"), "pending")
  assert.equal(harness.store.start_packages[0].status, "open", "the package cannot go ready on an unproven gate")
})

test("selection groups must exist AND be closed before the gate clears", async () => {
  const open = buildHarness({
    tables: gateFixture({
      selectionGroups: [
        { id: "psg-1", org_id: ORG, project_id: PROJECT, status: "locked" },
        { id: "psg-2", org_id: ORG, project_id: PROJECT, status: "open" },
      ],
    }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "selections_locked"), "pending")
  assert.equal(open.store.start_packages[0].status, "open")

  buildHarness({
    tables: gateFixture({
      selectionGroups: [
        { id: "psg-1", org_id: ORG, project_id: PROJECT, status: "locked" },
        { id: "psg-2", org_id: ORG, project_id: PROJECT, status: "locked" },
      ],
    }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  const cleared = await loadStarts().refreshAutoGates(PACKAGE)
  assert.equal(statusOf(cleared, "selections_locked"), "passed")
  assert.equal(cleared.find((gate) => gate.key === "selections_locked").passedVia, "auto")
})

test("the price book gate needs a run that actually happened, not just an absence of exceptions", async () => {
  const untested = buildHarness({
    tables: gateFixture({ poRuns: [], poExceptions: [] }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "price_book"), "pending")
  assert.equal(untested.store.start_packages[0].status, "open")

  buildHarness({
    tables: gateFixture({
      poRuns: [{ id: "run-1", org_id: ORG, project_id: PROJECT, mode: "dry_run", status: "succeeded_with_exceptions" }],
      poExceptions: [{ id: "exc-1", org_id: ORG, project_id: PROJECT, status: "open" }],
    }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "price_book"), "pending", "open exceptions still block")

  buildHarness({
    tables: gateFixture({
      poRuns: [{ id: "run-1", org_id: ORG, project_id: PROJECT, mode: "dry_run", status: "succeeded" }],
      poExceptions: [{ id: "exc-1", org_id: ORG, project_id: PROJECT, status: "resolved_manual" }],
    }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "price_book"), "passed")
})

test("the price book gate does not apply when the community has no price book", async () => {
  buildHarness({
    tables: gateFixture({ purchasing: false }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  const gates = await loadStarts().refreshAutoGates(PACKAGE)
  assert.equal(statusOf(gates, "price_book"), "not_applicable")
})

test("a package goes ready only once every auto gate is proven and the manual one is attested", async () => {
  const harness = buildHarness({
    tables: gateFixture({
      selectionGroups: [{ id: "psg-1", org_id: ORG, project_id: PROJECT, status: "locked" }],
      poRuns: [{ id: "run-1", org_id: ORG, project_id: PROJECT, mode: "dry_run", status: "succeeded" }],
      poExceptions: [],
    }),
    instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }),
  })
  const starts = loadStarts()
  const gates = await starts.refreshAutoGates(PACKAGE)
  for (const key of ["plot_plan", "selections_locked", "plan_pinned", "price_book"]) {
    assert.equal(statusOf(gates, key), "passed", `${key} should have cleared`)
  }
  // Final approval is a human signature, so the package is still open.
  assert.equal(harness.store.start_packages[0].status, "open")

  await starts.attestGate(PACKAGE, "gate-final_approval", {})
  assert.equal(harness.store.start_packages[0].status, "ready")
})

test("a plan the community no longer offers does not clear the plan gate without a recorded override", async () => {
  const withdrawn = [{ id: "cpa-1", org_id: ORG, community_id: "00000000-0000-4000-8000-000000000006", house_plan_id: "plan-1", elevation_id: null, is_available: false, effective_start: null, effective_end: null }]
  buildHarness({ tables: gateFixture({ offering: withdrawn }), instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }) })
  assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "plan_pinned"), "pending")
})

test("a recorded offering override clears the plan gate only for the plan it names", async () => {
  const withdrawn = [{ id: "cpa-1", org_id: ORG, community_id: "00000000-0000-4000-8000-000000000006", house_plan_id: "plan-1", elevation_id: null, is_available: false, effective_start: null, effective_end: null }]
  const override = (housePlanId) => ({ offering_override: { house_plan_id: housePlanId, reason: "Buyer pre-sold this plan before withdrawal", by: "00000000-0000-4000-8000-0000000000aa", at: "2026-09-01T00:00:00.000Z" } })
  for (const [housePlanId, expected] of [["00000000-0000-4000-8000-0000000000b1", "passed"], ["00000000-0000-4000-8000-0000000000b2", "pending"]]) {
    const tables = gateFixture({ offering: withdrawn })
    tables.lots[0].version = { status: "released", house_plan_id: "00000000-0000-4000-8000-0000000000b1" }
    tables.community_plan_availability[0].house_plan_id = "00000000-0000-4000-8000-0000000000b1"
    tables.lots[0].metadata = override(housePlanId)
    buildHarness({ tables, instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }) })
    assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "plan_pinned"), expected)
  }
})

test("a home on a superseded edition clears the plan gate only once a plan change review decided it keeps that edition", async () => {
  for (const [decision, expected] of [["defer", "pending"], ["decline", "passed"]]) {
    const tables = gateFixture()
    tables.lots[0].version = { status: "superseded", house_plan_id: "plan-1" }
    tables.plan_change_proposal_homes = [{ id: "pch-1", org_id: ORG, lot_id: tables.lots[0].id, from_version_id: VERSION, decision }]
    buildHarness({ tables, instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }) })
    assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "plan_pinned"), expected, decision)
  }
})

test("a home sold on an elevation retired since still clears the plan gate; a home not sold on it does not", async () => {
  const soldOn = (elevationId, contractStatus = "active") => ({
    id: `hpr-${elevationId}`, org_id: ORG, project_id: PROJECT, stage: "agreement", elevation_id: elevationId, contract: { status: contractStatus },
  })
  const cases = [
    ["sold on it before it was retired", [soldOn("elev-1")], "passed"],
    ["a spec home, never sold", [], "pending"],
    ["sold on another elevation", [soldOn("elev-2")], "pending"],
    ["its sale on it was cancelled", [soldOn("elev-1", "cancelled")], "pending"],
  ]
  for (const [label, records, expected] of cases) {
    const tables = gateFixture()
    tables.lots[0].elevation = { is_active: false }
    tables.home_product_revisions = records
    buildHarness({ tables, instantiate: async () => ({ success: true, skipped: [], warnings: [], errors: [] }) })
    assert.equal(statusOf(await loadStarts().refreshAutoGates(PACKAGE), "plan_pinned"), expected, label)
  }
})

test("a house cannot be started on a lot a buyer is holding, or on land that was never delivered", async () => {
  const cases = [
    { lot: { project_id: null, delivered_at: "2026-01-01T00:00:00.000Z", metadata: {} }, reservations: [{ id: "res-1", org_id: ORG, lot_id: "lot-open", status: "hold", expires_at: "2999-01-01T00:00:00.000Z" }], expected: /live hold or reservation/ },
    { lot: { project_id: null, delivered_at: null, metadata: {} }, reservations: [], expected: /not been delivered/ },
  ]
  for (const { lot, reservations, expected } of cases) {
    const tables = gateFixture()
    tables.role_permissions.push({ role_id: tables.memberships[0].role_id, permission_key: "start.write" })
    tables.lots = [{ id: "lot-open", org_id: ORG, community_id: tables.lots[0].community_id, status: "developed", lot_number: "9", ...lot }]
    tables.lot_reservations = reservations
    const harness = buildHarness({ tables })
    await assert.rejects(loadStarts().openStartPackage("lot-open", {}), expected)
    assert.equal(harness.store.start_packages.length, 1, "no second package was opened")
  }
})

test("automatic readiness evidence read failures surface instead of recording a false verdict", async () => {
  for (const failingTable of ["lots", "files", "budgets", "po_generation_runs"]) {
    const tables = gateFixture({ purchasing: true })
    for (const [key, auto_source] of [["budget", "budget_generated"], ["po_set", "pos_generated"]]) {
      const definition = { id: `def-${key}`, org_id: ORG, key, auto_source, check_kind: "auto", applies_when: "always", is_active: true }
      tables.start_gate_definitions.push(definition)
      tables.start_package_gates.push({ id: `gate-${key}`, org_id: ORG, start_package_id: PACKAGE, gate_definition_id: definition.id, status: "pending", definition })
    }
    const harness = buildHarness({ tables, instantiate: async () => ({ success: true }) })
    const from = harness.supabase.from.bind(harness.supabase)
    harness.supabase.from = table => {
      const query = from(table), run = query.run.bind(query)
      query.run = () => table === failingTable && query.action === "select"
        ? { data: null, count: null, error: { message: "Readiness evidence unavailable" } } : run()
      return query
    }
    await assert.rejects(loadStarts().refreshAutoGates(PACKAGE), /Readiness evidence unavailable/, failingTable)
    assert.equal(harness.store.start_packages[0].status, "open")
  }
})

test("missing selection or exception counts cannot prove readiness", async () => {
  for (const failingTable of ["project_selection_groups", "po_generation_exceptions"]) {
    const harness = buildHarness({ tables: gateFixture({ purchasing: true }), instantiate: async () => ({ success: true }) })
    const from = harness.supabase.from.bind(harness.supabase)
    harness.supabase.from = table => {
      const query = from(table), run = query.run.bind(query)
      query.run = () => table === failingTable && query.action === "select"
        ? { data: null, count: null, error: null } : run()
      return query
    }
    await assert.rejects(loadStarts().refreshAutoGates(PACKAGE), /evidence counts unavailable/, failingTable)
  }
})

test("the yard lists every lot still waiting for a package, past the first page of lots", async () => {
  const tables = releasingFixture({ purchasing: false })
  const community = { name: "Cypress Run", settings: {} }
  tables.lots = Array.from({ length: 1_100 }, (_, index) => ({
    id: `lot-${String(index).padStart(4, "0")}`, org_id: ORG, community_id: "community-1", project_id: null,
    status: "developed", delivered_at: "2026-01-01T00:00:00.000Z", metadata: {}, lot_number: String(index).padStart(4, "0"), block: null, community,
    plan: null, elevation: null, project: null,
    // The first 600 lots already have a package; only the rest are waiting.
    packages: index < 600 ? [{ id: `pkg-${index}`, status: "open" }] : [],
  }))
  buildHarness({ tables })

  const candidates = await loadStarts().listStartPackageCandidates()
  assert.equal(candidates.length, 500)
})

test("the yard does not offer a lot that land development has not delivered", async () => {
  const tables = releasingFixture({ purchasing: false })
  const row = (id, extra) => ({
    id, org_id: ORG, community_id: "community-1", project_id: null, status: "assigned", lot_number: id, block: null,
    community: { name: "Cypress Run", settings: {} }, plan: null, elevation: null, project: null, packages: [], ...extra,
  })
  tables.lots = [
    row("delivered", { delivered_at: "2026-01-01T00:00:00.000Z", metadata: {} }),
    row("reserved-but-undeveloped", { delivered_at: null, metadata: {} }),
    row("excepted", { delivered_at: null, metadata: { delivery_exception: { reason: "Lot finishes with the house pad", by: "00000000-0000-4000-8000-0000000000aa", at: "2026-09-01T00:00:00.000Z" } } }),
  ]
  buildHarness({ tables })

  const candidates = await loadStarts().listStartPackageCandidates()
  assert.deepEqual(candidates.map((candidate) => candidate.lotLabel).sort(), ["delivered", "excepted"])
})
