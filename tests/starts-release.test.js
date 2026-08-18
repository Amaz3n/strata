require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  ACTOR, PACKAGE, PROJECT, RELEASE_STEPS,
  buildHarness, releasingFixture, stepsByKey, succeedingInstantiation,
} = require("./support/starts-harness")

/**
 * The orchestrator is loaded fresh per test so each one gets its own stub set —
 * node runs a test FILE in one process, so the module cache is shared and the
 * stubs installed by `buildHarness` must be in place before the require.
 */
function loadPipeline() {
  delete require.cache[require.resolve("@/lib/services/starts-pipeline")]
  delete require.cache[require.resolve("@/lib/services/starts")]
  return require("@/lib/services/starts-pipeline")
}

function loadStarts() {
  return require("@/lib/services/starts")
}

function requeue(store, { runAt = new Date(Date.now() - 1000).toISOString() } = {}) {
  for (const job of store.outbox) {
    if (job.status === "failed" || job.status === "completed") continue
    job.status = "pending"
    job.run_at = runAt
  }
}

test("a release with no price book skips PO generation and finishes the house", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  const steps = stepsByKey(harness.store)
  assert.equal(steps.get("pos").status, "skipped")
  assert.deepEqual(steps.get("pos").detail, { purchasing_enabled: false })
  for (const key of RELEASE_STEPS.filter((step) => step !== "pos")) {
    assert.equal(steps.get(key).status, "completed", `${key} should be completed`)
  }
  assert.equal(harness.calls.purchaseOrders.length, 0)
  // Budget is instantiated locally when purchasing is off, delegated when it is on.
  assert.deepEqual(harness.calls.instantiate.map((call) => call.steps[0]), ["budget", "schedule", "checklists", "drawings"])

  const pkg = harness.store.start_packages[0]
  assert.equal(pkg.status, "released")
  assert.equal(pkg.actual_start_date, "2026-09-07")
  assert.equal(harness.store.lots[0].status, "started")
  const project = harness.store.projects[0]
  assert.equal(project.phase, "delivery", "the house leaves precon only at release")
  assert.equal(project.start_date, "2026-09-07")
})

test("a release with a price book delegates the budget and commits the PO set", async () => {
  const harness = buildHarness({
    purchasing: true,
    instantiate: succeedingInstantiation(),
    generatePurchaseOrders: () => ({
      runId: "run-1",
      purchaseOrders: [{ totalCents: 250_000 }, { totalCents: 125_000 }],
      exceptions: [],
    }),
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  const steps = stepsByKey(harness.store)
  assert.deepEqual(steps.get("budget").detail, { delegated_to: "pos" })
  assert.equal(steps.get("pos").status, "completed")
  assert.equal(steps.get("pos").detail.po_count, 2)
  assert.equal(steps.get("pos").detail.total_cents, 375_000)
  assert.equal(harness.calls.purchaseOrders.length, 1)
  assert.equal(harness.calls.purchaseOrders[0].mode, "commit")
  assert.deepEqual(harness.calls.instantiate.map((call) => call.steps[0]), ["schedule", "checklists", "drawings"])
})

test("finalize records the gates it actually produced instead of asserting both", async () => {
  const gateFixture = (tables) => {
    tables.start_gate_definitions = [
      { id: "def-budget", org_id: tables.orgs[0].id, key: "budget", label: "Budget generated", check_kind: "auto", auto_source: "budget_generated", applies_when: "always", sort_order: 60, is_active: true },
      { id: "def-po", org_id: tables.orgs[0].id, key: "po_set", label: "PO set generated", check_kind: "auto", auto_source: "pos_generated", applies_when: "purchasing_enabled", sort_order: 70, is_active: true },
    ]
    tables.start_package_gates = [
      { id: "gate-budget", org_id: tables.orgs[0].id, start_package_id: PACKAGE, gate_definition_id: "def-budget", status: "pending", passed_via: null, created_at: "2026-09-01T00:00:00.000Z", definition: tables.start_gate_definitions[0] },
      { id: "gate-po", org_id: tables.orgs[0].id, start_package_id: PACKAGE, gate_definition_id: "def-po", status: "pending", passed_via: null, created_at: "2026-09-01T00:01:00.000Z", definition: tables.start_gate_definitions[1] },
    ]
    // The budget landed; no PO run ever did, because purchasing is off.
    tables.budgets = [{ id: "budget-1", org_id: tables.orgs[0].id, project_id: PROJECT }]
    tables.po_generation_runs = []
    return tables
  }
  const harness = buildHarness({ tables: gateFixture(releasingFixture({ purchasing: false })), instantiate: succeedingInstantiation() })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  const gates = new Map(harness.store.start_package_gates.map((gate) => [gate.id, gate]))
  assert.equal(gates.get("gate-budget").status, "passed")
  assert.equal(gates.get("gate-budget").passed_via, "auto")
  assert.equal(gates.get("gate-po").status, "pending", "a skipped PO step must not claim a PO set exists")
  assert.equal(gates.get("gate-po").passed_via, null)
})

test("a transient failure at any step resumes without re-running what already landed", async () => {
  for (const failing of ["budget", "schedule", "checklists", "drawings"]) {
    let thrown = false
    const harness = buildHarness({
      purchasing: false,
      instantiate: async (input) => {
        const step = input.steps[0]
        if (step === failing && !thrown) {
          thrown = true
          throw new Error(`${step} blew up`)
        }
        return succeedingInstantiation()(input)
      },
    })
    const pipeline = loadPipeline()
    await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

    const afterFailure = stepsByKey(harness.store)
    assert.equal(afterFailure.get(failing).status, "failed", `${failing} should have failed on the first pass`)
    assert.equal(harness.store.start_packages[0].status, "releasing")
    assert.equal(harness.store.outbox[0].status, "pending", "a retryable failure stays queued")

    requeue(harness.store)
    await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

    const steps = stepsByKey(harness.store)
    for (const key of RELEASE_STEPS.filter((step) => step !== "pos")) {
      assert.equal(steps.get(key).status, "completed", `${key} should be completed after the retry (${failing} run)`)
    }
    assert.equal(harness.store.start_packages[0].status, "released")
    // Every instantiation step runs exactly once beyond the one that threw.
    const perStep = harness.calls.instantiate.reduce((counts, call) => {
      counts[call.steps[0]] = (counts[call.steps[0]] ?? 0) + 1
      return counts
    }, {})
    for (const [step, count] of Object.entries(perStep)) {
      assert.equal(count, step === failing ? 2 : 1, `${step} ran ${count} times during the ${failing} run`)
    }
  }
})

test("an instantiation the project already recorded is a resume, not a wedge", async () => {
  const harness = buildHarness({
    purchasing: false,
    instantiate: async (input) => {
      const step = input.steps[0]
      // Exactly what the real service returns under `resume` when its ledger
      // says the step landed but `start_release_steps` never heard about it.
      if (step === "schedule") {
        return { success: true, skipped: ["schedule"], warnings: ["schedule was already instantiated for this project; skipped."], errors: [] }
      }
      return succeedingInstantiation()(input)
    },
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  const steps = stepsByKey(harness.store)
  assert.equal(steps.get("schedule").status, "completed")
  assert.deepEqual(steps.get("schedule").detail, { already_instantiated: true })
  assert.equal(harness.store.start_packages[0].status, "released")
  // The orchestrator must ask for a resume; without it the service returns an
  // error and the package parks in `attention` forever.
  for (const call of harness.calls.instantiate) assert.equal(call.resume, true)
})

test("a package another worker holds is deferred, not run twice", async () => {
  const heldMetadata = {
    release_lease_token: "another-worker",
    release_lease_at: new Date().toISOString(),
  }
  const harness = buildHarness({
    tables: releasingFixture({ purchasing: false, metadata: heldMetadata }),
    instantiate: succeedingInstantiation(),
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  assert.equal(harness.calls.instantiate.length, 0, "a leased package must not be touched")
  assert.equal(harness.store.start_packages[0].status, "releasing")
  const job = harness.store.outbox[0]
  assert.equal(job.status, "pending", "deferral requeues rather than failing")
  assert.equal(job.retry_count, 0, "deferral must not burn a retry")
  assert.ok(job.run_at > new Date().toISOString(), "the deferred job waits for the lease to clear")
})

test("an expired lease is reclaimed so a dead worker cannot block its own retry", async () => {
  const staleMetadata = {
    release_lease_token: "dead-worker",
    release_lease_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  }
  const harness = buildHarness({
    tables: releasingFixture({ purchasing: false, metadata: staleMetadata }),
    instantiate: succeedingInstantiation(),
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.store.start_packages[0].metadata.release_lease_token, null, "the lease is handed back")
})

test("two workers racing the same package still build the house once", async () => {
  // The second worker is started while the first is genuinely mid-flight, which
  // is the shape `resetStaleProcessingJobs` and an out-of-band trigger create.
  let openGate = () => undefined
  const gate = new Promise((resolve) => { openGate = resolve })
  const harness = buildHarness({
    purchasing: true,
    instantiate: async (input) => {
      if (input.steps[0] === "schedule") await gate
      return succeedingInstantiation()(input)
    },
    generatePurchaseOrders: () => ({ runId: "run-1", purchaseOrders: [{ totalCents: 1_000 }], exceptions: [] }),
  })
  const pipeline = loadPipeline()
  const first = pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  while (!harness.calls.instantiate.some((call) => call.steps[0] === "schedule")) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  const past = new Date(Date.now() - 60_000).toISOString()
  harness.store.outbox.push({
    id: "job-2", org_id: harness.store.orgs[0].id, job_type: "start_release", status: "pending",
    payload: { start_package_id: PACKAGE, actor_id: ACTOR }, retry_count: 0,
    run_at: past, updated_at: past, dedupe_key: "start_release:duplicate",
  })
  const second = pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  await second
  openGate()
  await first

  const perStep = harness.calls.instantiate.reduce((counts, call) => {
    counts[call.steps[0]] = (counts[call.steps[0]] ?? 0) + 1
    return counts
  }, {})
  for (const [step, count] of Object.entries(perStep)) {
    assert.equal(count, 1, `${step} instantiated ${count} times under a two-worker race`)
  }
  assert.equal(harness.calls.purchaseOrders.length, 1, "PO generation must not commit twice")
  assert.equal(harness.store.start_packages[0].status, "released")
  const deferred = harness.store.outbox.find((job) => job.id === "job-2")
  assert.equal(deferred.status, "pending", "the second worker backs off instead of racing")
  assert.equal(deferred.retry_count, 0)
})

test("a terminal failure parks the package in attention and retryRelease resumes it", async () => {
  let alwaysFail = true
  const harness = buildHarness({
    purchasing: false,
    instantiate: async (input) => {
      if (input.steps[0] === "drawings" && alwaysFail) throw new Error("plan set is missing")
      return succeedingInstantiation()(input)
    },
  })
  const pipeline = loadPipeline()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    requeue(harness.store)
    await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  }

  assert.equal(harness.store.start_packages[0].status, "attention")
  assert.equal(harness.store.outbox[0].status, "failed")
  const failed = stepsByKey(harness.store)
  assert.equal(failed.get("drawings").status, "failed")
  assert.equal(failed.get("checklists").status, "completed", "work before the failure is kept")
  assert.ok(harness.calls.events.some((event) => event.eventType === "start.release_failed"))

  alwaysFail = false
  await loadStarts().retryRelease(PACKAGE)
  assert.equal(harness.store.start_packages[0].status, "releasing")
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })

  const steps = stepsByKey(harness.store)
  assert.equal(harness.store.start_packages[0].status, "released")
  for (const key of RELEASE_STEPS.filter((step) => step !== "pos")) {
    assert.equal(steps.get(key).status, "completed", `${key} should be completed after the retry`)
  }
  const instantiatedTwice = harness.calls.instantiate.filter((call) => call.steps[0] === "budget")
  assert.equal(instantiatedTwice.length, 1, "a retry must not regenerate the budget")
})

test("cancelling a release keeps what already landed and says so", async () => {
  const harness = buildHarness({
    purchasing: false,
    instantiate: async (input) => {
      if (input.steps[0] === "drawings") throw new Error("plan set is missing")
      return succeedingInstantiation()(input)
    },
  })
  const pipeline = loadPipeline()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    requeue(harness.store)
    await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  }
  assert.equal(harness.store.start_packages[0].status, "attention")

  const result = await loadStarts().cancelRelease(PACKAGE)
  assert.deepEqual(result.preserved.sort(), ["budget", "checklists", "project", "schedule"])
  assert.deepEqual(result.reset.sort(), ["drawings", "finalize", "notify_trades", "pos"])

  const steps = stepsByKey(harness.store)
  // The old implementation reset everything but `project`, which both lied
  // about undoing the work and wedged the next release on the instantiation
  // ledger it had already written.
  assert.equal(steps.get("schedule").status, "completed")
  assert.equal(steps.get("budget").status, "completed")
  assert.equal(steps.get("drawings").status, "pending")
  assert.equal(steps.get("drawings").error, null)
  assert.equal(harness.store.start_packages[0].status, "ready")
  assert.equal(harness.store.start_packages[0].metadata.release_lease_token, null)
})
