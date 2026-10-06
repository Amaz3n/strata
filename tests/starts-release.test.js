require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  ACTOR, LOT, ORG, PACKAGE, PROJECT, RELEASE_STEPS,
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


test("finalization transfers lot basis with the released house's organization, date and actor", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  assert.deepEqual(harness.calls.landTransfers, [{ orgId: ORG, lotId: LOT, date: "2026-09-07", actorId: ACTOR }])
  assert.equal(harness.store.start_packages[0].status, "released")
})

test("a failed lot-basis transfer prevents release and retries without regenerating completed work", async () => {
  let fail = true
  const harness = buildHarness({
    purchasing: false,
    instantiate: succeedingInstantiation(),
    transferLandAtStart: async () => { if (fail) throw new Error("Lot basis transfer unavailable") },
  })
  const pipeline = loadPipeline()
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  assert.equal(stepsByKey(harness.store).get("finalize").status, "failed")
  assert.match(stepsByKey(harness.store).get("finalize").error, /Lot basis transfer unavailable/)
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(harness.store.lots[0].status, "assigned")
  assert.equal(harness.store.projects[0].phase, "precon")
  assert.ok(!harness.calls.events.some(event => event.eventType === "start.released"))
  const completedWork = harness.calls.instantiate.length
  fail = false
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5_000 })
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.calls.landTransfers.length, 2)
  assert.equal(harness.calls.instantiate.length, completedWork)
})

test("a failed project finalization cannot publish a released package and retry repairs it", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  let fail = true
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => fail && table === "projects" && query.action === "update" && query.payload?.phase === "delivery"
      ? { data: null, error: { message: "Project write unavailable" } } : run()
    return query
  }
  const pipeline = loadPipeline()
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(harness.store.projects[0].phase, "precon")
  assert.equal(stepsByKey(harness.store).get("finalize").status, "failed")
  const instantiated = harness.calls.instantiate.length
  fail = false
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.store.projects[0].phase, "delivery")
  assert.equal(harness.calls.instantiate.length, instantiated)
})

test("failed final publication resumes from the completed ledger without repeating financial transfer", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  let fail = true
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => fail && table === "start_packages" && query.action === "update" && query.payload?.status === "released"
      ? { data: null, error: { message: "Publication unavailable" } } : run()
    return query
  }
  const pipeline = loadPipeline()
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(stepsByKey(harness.store).get("finalize").status, "completed")
  fail = false
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.calls.landTransfers.length, 1)
  assert.equal(harness.calls.events.filter((event) => event.eventType === "start.released").length, 1)
})

test("worker heartbeat executes its lazy outbox update during a long release step", async (t) => {
  const originalInterval = global.setInterval
  let heartbeat
  t.mock.method(global, "setInterval", (callback, ms) => { heartbeat = callback; return originalInterval(callback, ms) })
  let finish
  const gate = new Promise((resolve) => { finish = resolve })
  const harness = buildHarness({ purchasing: false, instantiate: async (input) => {
    if (input.steps[0] === "schedule") await gate
    return succeedingInstantiation()(input)
  } })
  const running = loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  try {
    while (!harness.calls.instantiate.some((call) => call.steps[0] === "schedule")) await new Promise((resolve) => setImmediate(resolve))
    const stale = "2020-01-01T00:00:00.000Z"
    harness.store.outbox[0].updated_at = stale
    heartbeat()
    await new Promise((resolve) => setImmediate(resolve))
    assert.notEqual(harness.store.outbox[0].updated_at, stale)
    assert.equal(harness.store.outbox[0].status, "processing")
  } finally { finish(); await running }
})

test("failed job completion is reported as failure and resumes without releasing twice", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  let fail = true
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => fail && table === "outbox" && query.action === "update" && query.payload?.status === "completed"
      ? { data: null, error: { message: "Completion unavailable" } } : run()
    return query
  }
  const pipeline = loadPipeline()
  const first = await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(first.processed, 0)
  assert.equal(first.failed, 1)
  assert.equal(harness.store.outbox[0].status, "pending")
  assert.match(harness.store.outbox[0].last_error, /Completion unavailable/)
  const work = harness.calls.instantiate.length
  fail = false
  requeue(harness.store)
  const resumed = await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(resumed.processed, 1)
  assert.equal(harness.store.outbox[0].status, "completed")
  assert.equal(harness.calls.instantiate.length, work)
  assert.equal(harness.calls.landTransfers.length, 1)
})

test("failed retry persistence surfaces to the caller and leaves the job reclaimable", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: async () => { throw new Error("Artifact unavailable") } })
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => table === "outbox" && query.action === "update" && query.payload?.last_error
      ? { data: null, error: { message: "Retry persistence unavailable" } } : run()
    return query
  }
  await assert.rejects(loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 }), /Retry persistence unavailable/)
  assert.equal(harness.store.outbox[0].status, "processing")
  assert.equal(harness.store.start_packages[0].status, "releasing")
})

test("job completion cannot overwrite a job whose processing status changed", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: async (input) => {
    if (input.steps[0] === "drawings") harness.store.outbox[0].status = "failed"
    return succeedingInstantiation()(input)
  } })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.store.outbox[0].status, "failed")
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(harness.calls.landTransfers.length, 0)
})

test("remaining queue read failures cannot report an empty healthy queue", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  harness.store.outbox = []
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => table === "outbox" && query.action === "select"
      ? { data: null, count: null, error: { message: "Queue count unavailable" } } : run()
    return query
  }
  await assert.rejects(loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 }), /Queue count unavailable/)
})

test("exhausted completion-write failures preserve an already released house", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => table === "outbox" && query.action === "update" && query.payload?.status === "completed"
      ? { data: null, error: { message: "Completion unavailable" } } : run()
    return query
  }
  const pipeline = loadPipeline()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    requeue(harness.store)
    await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  }
  assert.equal(harness.store.outbox[0].status, "failed")
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.store.projects[0].phase, "delivery")
  assert.equal(harness.calls.landTransfers.length, 1)
  assert.equal(harness.calls.events.filter(event => event.eventType === "start.release_failed").length, 0)
})

test("release trade notices include companies beyond the first 500 assignments", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  harness.store.schedule_assignments = Array.from({ length: 1001 }, (_, index) => ({
    id: `assignment-${String(index).padStart(5, "0")}`, org_id: ORG, project_id: PROJECT,
    company_id: index === 1000 ? "late-company" : "first-company",
  }))
  harness.store.schedule_assignments.push({ id: "other-home", org_id: ORG, project_id: "another-home", company_id: "excluded-company" })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.deepEqual(stepsByKey(harness.store).get("notify_trades").detail, { companies: 2, queued: 2 })
})

test("failed trade assignment reads prevent releasing without durable notices", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = (table) => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => table === "schedule_assignments"
      ? { data: null, error: { message: "Assignments unavailable" } } : run()
    return query
  }
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  const step = stepsByKey(harness.store).get("notify_trades")
  assert.equal(step.status, "failed")
  assert.match(step.error, /Assignments unavailable/)
  assert.equal(harness.store.start_packages[0].status, "releasing")
})

test("rejected trade sends retry independently after release", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  harness.store.schedule_assignments = [{ id: "assignment", org_id: ORG, project_id: PROJECT, company_id: "trade" }]
  require("./support/starts-harness").stubModule("@/lib/services/trade-lookahead", {
    sendTradeLookahead: async () => { throw new Error("Mail provider unavailable") },
    sendScheduleChangeDigestJob: async () => undefined,
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  const step = stepsByKey(harness.store).get("notify_trades")
  assert.equal(step.status, "completed")
  assert.equal(harness.store.start_packages[0].status, "released")
  const notice = harness.store.outbox.find(job => job.job_type === "start_release_trade_notice")
  assert.equal(notice.status, "pending")
  assert.equal(notice.retry_count, 1)
  assert.match(notice.last_error, /Mail provider unavailable/)
})

test("mail recovery completes its own job without repeating the home release", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  harness.store.schedule_assignments = [{ id: "assignment", org_id: ORG, project_id: PROJECT, company_id: "trade" }]
  let fail = true, sent = 0
  require("./support/starts-harness").stubModule("@/lib/services/trade-lookahead", {
    sendTradeLookahead: async (_company, opts) => {
      assert.equal(opts.releaseNoticeKey, PACKAGE)
      if (fail) throw new Error("Mail unavailable")
      sent += 1
      return { sent: true }
    },
    sendScheduleChangeDigestJob: async () => undefined,
  })
  const pipeline = loadPipeline()
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  const work = harness.calls.instantiate.length
  fail = false
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(sent, 1)
  assert.equal(harness.store.outbox.find(job => job.job_type === "start_release_trade_notice").status, "completed")
  assert.equal(harness.calls.instantiate.length, work)
  assert.equal(harness.calls.landTransfers.length, 1)
})

test("partial notice queue writes resume with company deduplication", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  harness.store.schedule_assignments = ["trade-a", "trade-b"].map(company_id => ({ id: company_id, org_id: ORG, project_id: PROJECT, company_id }))
  const outbox = require("@/lib/services/outbox")
  const original = outbox.enqueueOutboxJob
  let fail = true
  outbox.enqueueOutboxJob = async input => fail && input.payload.company_id === "trade-b" ? { enqueued: false, reason: "error" } : original(input)
  const pipeline = loadPipeline()
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(harness.calls.tradeNotices.length, 0)
  fail = false
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.equal(harness.store.outbox.filter(job => job.job_type === "start_release_trade_notice").length, 2)
  // A job claimed alongside release may defer until the next cron.
  requeue(harness.store)
  await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.calls.tradeNotices.length, 2)
})

test("revoked release permission stops a queued job before instantiation or financial writes", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  require("./support/starts-harness").stubModule("@/lib/services/permissions", {
    requirePermission: async permission => { if (permission === "start.release") throw new Error("Release permission revoked") },
    getCurrentUserPermissions: async () => ({ permissions: [] }),
  })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.calls.instantiate.length, 0)
  assert.equal(harness.calls.landTransfers.length, 0)
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.match(harness.store.outbox[0].last_error, /permission revoked/)
})

test("queued release cannot operate outside the actor's current community or lot divisions", async () => {
  for (const hiddenParent of ["community", "lot"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    harness.store.communities[0].division_id = hiddenParent === "community" ? "other" : "division"
    harness.store.start_packages[0].lot.division_id = hiddenParent === "lot" ? "other" : "division"
    require("./support/starts-harness").stubModule("@/lib/services/authorization", {
      getDivisionAccessForUser: async () => ({ assignedOnly: true, divisionIds: ["division"] }),
      getDivisionScopedProjectIds: async () => null,
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1)
    assert.equal(harness.calls.instantiate.length, 0)
    assert.equal(harness.calls.landTransfers.length, 0)
    assert.match(harness.store.outbox[0].last_error, /division access/)
  }
})

test("a worker whose lease changes during a long step stops without overwriting the next owner's ledger", async () => {
  let harness
  harness = buildHarness({ purchasing: false, instantiate: async input => {
    if (input.steps[0] === "schedule") {
      harness.store.start_packages[0].metadata = { release_lease_token: "new-owner", release_lease_at: new Date().toISOString() }
      const step = harness.store.start_release_steps.find(step => step.step_key === "schedule")
      step.status = "completed"
      step.detail = { owner: "new-owner" }
    }
    return succeedingInstantiation()(input)
  } })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.calls.instantiate.length, 2)
  assert.equal(harness.calls.landTransfers.length, 0)
  assert.equal(stepsByKey(harness.store).get("schedule").detail.owner, "new-owner")
  assert.equal(harness.store.start_packages[0].metadata.release_lease_token, "new-owner")
  assert.equal(harness.store.outbox[0].status, "processing")
})

test("an expired lease cannot finish its step even when no replacement worker has claimed it", async () => {
  let harness
  harness = buildHarness({ purchasing: false, instantiate: async input => {
    if (input.steps[0] === "schedule") harness.store.start_packages[0].metadata.release_lease_at = "2020-01-01T00:00:00Z"
    return succeedingInstantiation()(input)
  } })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(stepsByKey(harness.store).get("schedule").status, "running")
  assert.equal(harness.calls.landTransfers.length, 0)
})

test("coordinator cancellation during instantiation is preserved by the returning worker", async () => {
  let harness
  harness = buildHarness({ purchasing: false, instantiate: async input => {
    if (input.steps[0] === "schedule") await loadStarts().cancelRelease(PACKAGE)
    return succeedingInstantiation()(input)
  } })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.store.start_packages[0].status, "ready")
  assert.equal(harness.store.outbox[0].status, "failed")
  assert.equal(stepsByKey(harness.store).get("schedule").status, "pending")
  assert.equal(harness.calls.landTransfers.length, 0)
})

test("queued trade jobs recheck current permission and source division before delivery", async () => {
  for (const type of ["trade_schedule_change_notice", "start_release_trade_notice"]) {
    for (const deniedBy of ["permission", "division"]) {
      const harness = buildHarness({ packageStatus: "released", instantiate: succeedingInstantiation() })
      harness.store.outbox[0].job_type = type
      harness.store.outbox[0].payload = { actor_id: ACTOR, start_package_id: PACKAGE, project_id: PROJECT, company_id: "trade" }
      require("./support/starts-harness").stubModule("@/lib/services/permissions", {
        requirePermission: async () => { if (deniedBy === "permission") throw new Error("Notice permission revoked") },
        getCurrentUserPermissions: async () => ({ permissions: [] }),
      })
      require("./support/starts-harness").stubModule("@/lib/services/authorization", {
        getDivisionAccessForUser: async () => ({ assignedOnly: true, divisionIds: ["other"] }),
        getDivisionScopedProjectIds: async () => null,
      })
      let deliveries = 0
      require("./support/starts-harness").stubModule("@/lib/services/trade-lookahead", {
        sendTradeLookahead: async () => { deliveries += 1; return { sent: true } },
        sendScheduleChangeDigestJob: async () => { deliveries += 1 },
      })
      const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
      assert.equal(summary.failed, 1)
      assert.equal(deliveries, 0)
      assert.match(harness.store.outbox[0].last_error, /permission revoked|division access/)
    }
  }
})

test("an ownership verification outage stops before writes rather than assuming the lease is valid", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => table === "outbox" && q.action === "select" && !q.head
      ? { data: null, error: { message: "Ownership read unavailable" } } : run()
    return q
  }
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.calls.instantiate.length, 0)
  assert.equal(harness.store.outbox[0].status, "processing")
  assert.equal(stepsByKey(harness.store).get("budget").status, "pending")
})

test("a delayed heartbeat cannot resurrect an already expired package lease", async t => {
  const originalInterval = global.setInterval
  let heartbeat, finish
  t.mock.method(global, "setInterval", (callback, ms) => { heartbeat = callback; return originalInterval(callback, ms) })
  const gate = new Promise(resolve => { finish = resolve })
  const harness = buildHarness({ purchasing: false, instantiate: async input => {
    if (input.steps[0] === "schedule") await gate
    return succeedingInstantiation()(input)
  } })
  const running = loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  try {
    while (!harness.calls.instantiate.some(call => call.steps[0] === "schedule")) await new Promise(resolve => setImmediate(resolve))
    harness.store.start_packages[0].metadata.release_lease_at = "2020-01-01T00:00:00Z"
    heartbeat()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(harness.store.start_packages[0].metadata.release_lease_at, "2020-01-01T00:00:00Z")
  } finally { finish() }
  const summary = await running
  assert.equal(summary.failed, 1)
  assert.equal(harness.calls.landTransfers.length, 0)
})

test("a terminal authorization failure cannot park a package held by a different worker", async () => {
  const harness = buildHarness({ purchasing: false, metadata: { release_lease_token: "other-owner", release_lease_at: new Date().toISOString() }, instantiate: succeedingInstantiation() })
  harness.store.outbox[0].retry_count = 2
  require("./support/starts-harness").stubModule("@/lib/services/permissions", {
    requirePermission: async () => { throw new Error("Permission revoked") },
    getCurrentUserPermissions: async () => ({ permissions: [] }),
  })
  await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(harness.store.outbox[0].status, "failed")
  assert.equal(harness.store.start_packages[0].status, "releasing")
  assert.equal(harness.store.start_packages[0].metadata.release_lease_token, "other-owner")
  assert.equal(harness.calls.events.filter(event => event.eventType === "start.release_failed").length, 0)
})

test("mandatory skipped steps resume their work instead of being accepted as complete", async () => {
  const tables = releasingFixture({ purchasing: false })
  for (const step of tables.start_release_steps) if (step.step_key !== "project") step.status = "skipped"
  const harness = buildHarness({ tables, instantiate: succeedingInstantiation() })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.processed, 1)
  assert.deepEqual(harness.calls.instantiate.map(call => call.steps[0]), ["budget", "schedule", "checklists", "drawings"])
  assert.equal(stepsByKey(harness.store).get("finalize").status, "completed")
  assert.deepEqual(stepsByKey(harness.store).get("pos").detail, { purchasing_enabled: false })
})

test("a previously skipped PO step is generated when purchasing becomes applicable", async () => {
  const tables = releasingFixture({ purchasing: true })
  const pos = tables.start_release_steps.find(step => step.step_key === "pos")
  Object.assign(pos, { status: "skipped", detail: { purchasing_enabled: false }, completed_at: new Date().toISOString() })
  const harness = buildHarness({ tables, instantiate: succeedingInstantiation() })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.processed, 1)
  assert.equal(harness.calls.purchaseOrders.length, 1)
  assert.equal(stepsByKey(harness.store).get("pos").status, "completed")
})

function afterFinalize(harness, mutate) {
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => {
      const result = run()
      if (table === "start_release_steps" && query.action === "update" && query.payload?.status === "completed"
        && query.filters.every(filter => filter(harness.store.start_release_steps.find(step => step.step_key === "finalize")))) mutate()
      return result
    }
    return query
  }
}

test("publication rechecks every durable step after finalization", async () => {
  for (const corruption of ["missing", "failed", "skipped", "timestamp", "error", "duplicate"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    afterFinalize(harness, () => {
      const step = stepsByKey(harness.store).get("schedule")
      if (corruption === "missing") harness.store.start_release_steps = harness.store.start_release_steps.filter(row => row !== step)
      if (corruption === "failed" || corruption === "skipped") step.status = corruption
      if (corruption === "timestamp") step.completed_at = "not-a-date"
      if (corruption === "error") step.error = "Unresolved schedule failure"
      if (corruption === "duplicate") harness.store.start_release_steps.push({ ...step, id: "duplicate-schedule" })
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.processed, 0, corruption)
    assert.equal(summary.failed, 1, corruption)
    assert.notEqual(harness.store.start_packages[0].status, "released", corruption)
    assert.match(harness.store.outbox[0].last_error, /completion/, corruption)
  }
})

test("publication verifies the final home date, phase and lot ancestry", async () => {
  for (const corruption of ["date", "phase", "lot_status", "lot_home", "missing_home"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    afterFinalize(harness, () => {
      if (corruption === "date") harness.store.projects[0].start_date = "2026-09-08"
      if (corruption === "phase") harness.store.projects[0].phase = "precon"
      if (corruption === "lot_status") harness.store.lots[0].status = "assigned"
      if (corruption === "lot_home") harness.store.lots[0].project_id = "another-home"
      if (corruption === "missing_home") harness.store.projects.length = 0
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, corruption)
    assert.notEqual(harness.store.start_packages[0].status, "released", corruption)
    assert.match(harness.store.outbox[0].last_error, /completed start|completion records/, corruption)
  }
})

test("completion verification read failures keep the release unpublished", async () => {
  for (const failingTable of ["start_release_steps", "projects", "lots"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    let finalized = false
    afterFinalize(harness, () => { finalized = true })
    const from = harness.supabase.from.bind(harness.supabase)
    harness.supabase.from = table => {
      const query = from(table), run = query.run.bind(query)
      query.run = () => finalized && table === failingTable && query.action === "select"
        ? { data: null, error: { message: "Completion evidence unavailable" } } : run()
      return query
    }
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, failingTable)
    assert.notEqual(harness.store.start_packages[0].status, "released", failingTable)
    assert.match(harness.store.outbox[0].last_error, /Completion evidence unavailable/, failingTable)
  }
})

test("another division's price book does not switch the home to PO-backed release", async () => {
  const tables = releasingFixture({ purchasing: true })
  tables.communities[0].division_id = "west"
  Object.assign(tables.vendor_price_agreements[0], { community_id: null, division_id: "east" })
  const harness = buildHarness({ tables, instantiate: succeedingInstantiation() })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.processed, 1)
  assert.equal(harness.calls.purchaseOrders.length, 0)
  assert.deepEqual(stepsByKey(harness.store).get("pos").detail, { purchasing_enabled: false })
  assert.ok(harness.calls.instantiate.some(call => call.steps[0] === "budget"))
})

test("publication rechecks approvals, active definitions and applicability", async () => {
  for (const change of ["pending", "missing", "not_applicable", "new_definition", "financed", "duplicate", "empty", "short_waiver"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    afterFinalize(harness, () => {
      const gate = harness.store.start_package_gates[0]
      if (change === "pending" || change === "not_applicable") gate.status = change
      if (change === "missing") harness.store.start_package_gates.length = 0
      if (change === "duplicate") harness.store.start_package_gates.push({ ...gate, id: "duplicate-gate" })
      if (change === "empty") harness.store.start_gate_definitions.length = 0
      if (change === "short_waiver") Object.assign(gate, { status: "waived", waived_reason: "short" })
      if (change === "new_definition" || change === "financed") {
        harness.store.start_gate_definitions.push({ id: "new-gate", org_id: ORG, key: "financing", check_kind: "manual", applies_when: change === "financed" ? "financed_only" : "always", is_active: true })
        if (change === "financed") harness.store.start_packages[0].is_financed = true
      }
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, change)
    assert.notEqual(harness.store.start_packages[0].status, "released", change)
    assert.match(harness.store.outbox[0].last_error, /gate/, change)
  }
})

test("valid waivers, inactive definitions and inapplicable gates permit completion", async () => {
  for (const exception of ["waiver", "inactive", "inapplicable"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    afterFinalize(harness, () => {
      if (exception === "waiver") Object.assign(harness.store.start_package_gates[0], { status: "waived", waived_reason: "Reviewed and approved by starts manager" })
      else harness.store.start_gate_definitions.push({ id: "extra-gate", org_id: ORG, key: "financing", check_kind: "manual", applies_when: "financed_only", is_active: exception !== "inactive" })
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.processed, 1, exception)
    assert.equal(harness.store.start_packages[0].status, "released", exception)
  }
})

test("purchasing or package scope changes before publication block release", async () => {
  for (const change of ["price_book", "date", "community", "home", "lot"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    afterFinalize(harness, () => {
      const pkg = harness.store.start_packages[0]
      if (change === "price_book") harness.store.vendor_price_agreements.push({ id: "new-price-book", org_id: ORG, status: "active", community_id: pkg.community_id, division_id: null })
      if (change === "date") pkg.scheduled_start_date = "2026-09-08"
      if (change === "community") pkg.community_id = "another-community"
      if (change === "home") pkg.project_id = "another-home"
      if (change === "lot") pkg.lot_id = "another-lot"
    })
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, change)
    assert.notEqual(harness.store.start_packages[0].status, "released", change)
    assert.match(harness.store.outbox[0].last_error, /applicability changed|scope or date changed/, change)
  }
})

test("final gate reads cannot silently fail or truncate", async () => {
  for (const failure of ["start_gate_definitions", "start_package_gates", "overflow"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    let finalized = false
    afterFinalize(harness, () => {
      finalized = true
      if (failure === "overflow") for (let i = 0; i < 1001; i++) harness.store.start_gate_definitions.push({ id: `definition-${i}`, org_id: ORG, key: `gate_${i}`, applies_when: "always", is_active: true })
    })
    const from = harness.supabase.from.bind(harness.supabase)
    harness.supabase.from = table => {
      const query = from(table), run = query.run.bind(query)
      query.run = () => finalized && table === failure && query.action === "select"
        ? { data: null, error: { message: "Gate evidence unavailable" } } : run()
      return query
    }
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, failure)
    assert.notEqual(harness.store.start_packages[0].status, "released", failure)
    assert.match(harness.store.outbox[0].last_error, /Gate evidence unavailable|supported limit/, failure)
  }
})

test("passed automatic gates are re-derived from current evidence before publication", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  afterFinalize(harness, () => {
    harness.store.start_gate_definitions.push({ id: "def-selections", org_id: ORG, key: "selections_locked", check_kind: "auto", auto_source: "selections_locked", applies_when: "always", is_active: true })
    harness.store.start_package_gates.push({ id: "gate-selections", org_id: ORG, start_package_id: PACKAGE, gate_definition_id: "def-selections", status: "passed" })
    harness.store.project_selection_groups = [{ id: "unlocked", org_id: ORG, project_id: PROJECT, status: "open" }]
  })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.notEqual(harness.store.start_packages[0].status, "released")
  assert.match(harness.store.outbox[0].last_error, /evidence no longer satisfies.*selections_locked/)
})

test("a failed publication emits no release event or user notification", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => table === "start_packages" && query.action === "update" && query.payload?.status === "released"
      ? { data: null, error: { message: "Publication rejected" } } : run()
    return query
  }
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.failed, 1)
  assert.equal(harness.calls.events.filter(event => event.eventType === "start.released").length, 0)
  assert.equal(harness.calls.notifications.length, 0)
})

test("confirmation runs after publication and retries without rebuilding artifacts", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  let fail = true, delivered = 0
  require("./support/starts-harness").stubModule("@/lib/services/notifications", {
    NotificationService: class {
      async createAndQueue() {
        assert.equal(harness.store.start_packages[0].status, "released")
        if (fail) throw new Error("Notification unavailable")
        delivered++
      }
    },
  })
  const pipeline = loadPipeline()
  const first = await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(first.failed, 1)
  assert.equal(harness.store.start_packages[0].status, "released")
  assert.match(harness.store.outbox[0].last_error, /Notification unavailable/)
  const work = harness.calls.instantiate.length
  fail = false
  requeue(harness.store)
  const second = await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(second.processed, 1)
  assert.equal(delivered, 1)
  assert.equal(harness.calls.instantiate.length, work)
  assert.equal(harness.calls.landTransfers.length, 1)
})

test("confirmation rechecks recipient access before exposing the released home", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  require("./support/starts-harness").stubModule("@/lib/services/authorization", {
    getDivisionAccessForUser: async () => ({ assignedOnly: false, divisionIds: [] }),
    authorize: async () => ({ allowed: false }),
  })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.processed, 1)
  assert.equal(harness.calls.notifications.length, 0)
})

test("explicit release-permission grants are included in the confirmation audience", async () => {
  const tables = releasingFixture({ purchasing: false })
  tables.role_permissions = []
  tables.membership_permission_overrides = [{ membership_id: tables.memberships[0].id, permission_key: "start.release", effect: "grant" }]
  const harness = buildHarness({ tables, instantiate: succeedingInstantiation() })
  const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(summary.processed, 1)
  assert.equal(harness.calls.notifications.length, 1)
  assert.equal(harness.calls.notifications[0].userId, ACTOR)
})

test("confirmation audience read failures remain retryable after publication", async () => {
  for (const failingTable of ["memberships", "role_permissions", "membership_permission_overrides"]) {
    const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
    const from = harness.supabase.from.bind(harness.supabase)
    harness.supabase.from = table => {
      const query = from(table), run = query.run.bind(query)
      query.run = () => harness.store.start_packages[0].status === "released" && table === failingTable && query.action === "select"
        ? { data: null, error: { message: "Audience unavailable" } } : run()
      return query
    }
    const summary = await loadPipeline().runStartsPipeline({ deadlineMs: Date.now() + 5000 })
    assert.equal(summary.failed, 1, failingTable)
    assert.equal(harness.store.start_packages[0].status, "released", failingTable)
    assert.match(harness.store.outbox[0].last_error, /Audience unavailable/, failingTable)
    assert.equal(harness.calls.notifications.length, 0, failingTable)
  }
})

test("lost job completion reuses release event and per-user notification identities", async () => {
  const harness = buildHarness({ purchasing: false, instantiate: succeedingInstantiation() })
  const from = harness.supabase.from.bind(harness.supabase)
  let fail = true
  harness.supabase.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => fail && table === "outbox" && query.action === "update" && query.payload?.status === "completed"
      ? { data: null, error: { message: "Lost completion write" } } : run()
    return query
  }
  const pipeline = loadPipeline()
  assert.equal((await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })).failed, 1)
  assert.equal(harness.calls.events.filter(event => event.eventType === "start.released").length, 1)
  assert.equal(harness.calls.notifications.length, 1)
  fail = false
  requeue(harness.store)
  assert.equal((await pipeline.runStartsPipeline({ deadlineMs: Date.now() + 5000 })).processed, 1)
  assert.equal(harness.calls.events.filter(event => event.eventType === "start.released").length, 1)
  assert.equal(harness.calls.notifications.length, 1)
  assert.equal(harness.store.start_packages[0].released_by, ACTOR)
})
