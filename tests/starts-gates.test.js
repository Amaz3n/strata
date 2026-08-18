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
  tables.lots[0].version = { status: "released" }
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
