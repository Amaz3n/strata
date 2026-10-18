require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { assertLiveSnapshotDate, requireRecognitionDate, exactPeriodPosition, wipSnapshotEvidence, assertReviewedWipUnchanged, wipReviewMatches } = require("../lib/services/books/wip-period-rules")
test("live snapshots cannot backdate today's inputs or predict tomorrow", () => {
  assert.doesNotThrow(() => assertLiveSnapshotDate("2026-09-30", "2026-09-30"))
  for (const date of ["2026-08-31", "2026-10-01"]) assert.throws(() => assertLiveSnapshotDate(date, "2026-09-30"), /Historical WIP requires dated inputs/)
})
test("recognition requires an exact period position and rejects future periods", () => {
  assert.throws(() => requireRecognitionDate("2026-10-31", "2026-10-02"), /future period/)
  assert.equal(exactPeriodPosition({ asOf: "2026-09-29", earnedRevenueCents: 100 }, "2026-09-30"), null)
  assert.equal(exactPeriodPosition(undefined, "2026-09-30"), null)
  const snapshot = { asOf: "2026-09-30", earnedRevenueCents: 125 }
  assert.equal(exactPeriodPosition(snapshot, "2026-09-30"), snapshot)
})

test("recognition preflights the entire period before any journal is posted", async () => {
  const Module = require("node:module")
  const posted = []
  const original = Module._load
  const client = { from(table) {
    const query = {
      select() { return query }, eq() { return query }, in() { return query }, lte() { return query }, order() { return query }, limit() { return query }, like() { return query },
      single: async () => ({ data: { workspace_enabled: true, arc_ledger_mode: "native", active_policy_version: 1 }, error: null }),
      maybeSingle: async () => ({ data: { version: 1 }, error: null }),
      range: async () => ({ data: [], error: null }),
      then(resolve, reject) { return Promise.resolve({ count: 0, error: null }).then(resolve, reject) },
    }
    return query
  } }
  const positions = new Map([
    ["exact", { asOf: "2026-09-30", earnedRevenueCents: 12500, warnings: [] }],
    ["stale", { asOf: "2026-09-29", earnedRevenueCents: 99000, warnings: [] }],
  ])
  let sourceEvidenceCurrent = true
  let recognize
  try {
    Module._load = function(name, ...args) {
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => client }
      if (name === "@/lib/services/books/wip-source-evidence") return { wipSourcesCurrent: async () => sourceEvidenceCurrent }
      if (name === "@/lib/services/books/ledger") return { postBooksJournalEntryForService: async draft => posted.push(draft) }
      if (name === "@/lib/services/books/wip-project-scope") return { loadWipScopesForPeriod: async () => ["exact", "stale", "missing"].map(projectId => ({ projectId, contractId: null, status: "active" })) }
      if (name === "@/lib/services/poc") return { loadPocPositionsAsOf: async () => positions }
      if (name === "@/lib/services/events") return { recordEvent: async () => {} }
      if (name === "@/lib/services/reports/dates") return { todayIsoDateOnly: () => "2026-09-30" }
      return original.call(this, name, ...args)
    }
    recognize = require("../lib/services/books/revenue-recognition").recognizeRevenueForPeriod
  } finally { Module._load = original }
  const result = await recognize("org", "2026-09-30")
  assert.equal(result.basis, "snapshot")
  assert.equal(result.postedCents, 0)
  assert.deepEqual(result.projectsWithoutSnapshot, ["stale", "missing"])
  assert.equal(posted.length, 0)
  assert.equal(result.results.find(row => row.projectId === "exact").skippedReason, "period_evidence_incomplete")
  const scopes = ["exact", "stale", "missing"].map(projectId => ({ projectId, contractId: null }))
  await assert.rejects(recognize("org", "2026-09-30", [scopes[0]]), /population changed/)
  await assert.rejects(recognize("org", "2026-10-31"), /future period/)
  assert.equal(posted.length, 0)
  positions.set("stale", { asOf: "2026-09-30", earnedRevenueCents: 0, warnings: [] })
  positions.set("missing", { asOf: "2026-09-30", earnedRevenueCents: 0, warnings: [] })
  for (const [projectId, position] of positions) Object.assign(position, { projectId, contractId: null, snapshotId: `snapshot-${projectId}`, inputsHash: `hash-${projectId}` })
  const reviewed = wipSnapshotEvidence(positions, scopes)
  positions.get("exact").snapshotId = "newer-snapshot-same-value"
  await assert.rejects(recognize("org", "2026-09-30", scopes, reviewed), /snapshot evidence changed/)
  assert.equal(posted.length, 0)
  positions.get("exact").snapshotId = "snapshot-exact"
  sourceEvidenceCurrent = false
  await assert.rejects(recognize("org", "2026-09-30", scopes, reviewed), /source evidence changed/)
  assert.equal(posted.length, 0)
  sourceEvidenceCurrent = true
  positions.get("exact").warnings = ["missing_eac"]
  const invalidEstimate = await recognize("org", "2026-09-30", scopes)
  assert.equal(invalidEstimate.results.find(row => row.projectId === "exact").skippedReason, "invalid_wip_inputs")
  assert.equal(posted.length, 0)
  positions.get("exact").warnings = []
  const ready = await recognize("org", "2026-09-30", scopes, reviewed)
  assert.equal(ready.postedCents, 12500)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].sourceId, "exact")
  assert.ok(posted[0].lines.every(line => line.dimensions.wip_snapshot_id === "snapshot-exact" && line.dimensions.wip_inputs_hash === "hash-exact"))
})


test("WIP review pins snapshot identity, inputs and earned amount per project or contract, with deterministic ordering", () => {
  const rows = new Map([
    ["b", { projectId: "b", contractId: null, snapshotId: "s-b", inputsHash: "h-b", asOf: "2026-09-30", earnedRevenueCents: 50, warnings: ["b", "a"] }],
    ["a", { projectId: "a", contractId: null, snapshotId: "s-a", inputsHash: "h-a", asOf: "2026-09-30", earnedRevenueCents: 100, warnings: [] }],
    // One project with two contracts has a position for each.
    ["c:k2", { projectId: "c", contractId: "k2", snapshotId: "s-c2", inputsHash: "h-c2", asOf: "2026-09-30", earnedRevenueCents: 20, warnings: [] }],
    ["c:k1", { projectId: "c", contractId: "k1", snapshotId: "s-c1", inputsHash: "h-c1", asOf: "2026-09-30", earnedRevenueCents: 10, warnings: [] }],
  ])
  const scope = (projectId, contractId = null) => ({ projectId, contractId })
  const pinned = wipSnapshotEvidence(rows, [scope("b"), scope("a"), scope("a"), scope("c", "k2"), scope("c", "k1")])
  assert.deepEqual(pinned.map(row => [row.projectId, row.contractId]), [["a", null], ["b", null], ["c", "k1"], ["c", "k2"]])
  assert.deepEqual(pinned[1].warnings, ["a", "b"])
  assert.doesNotThrow(() => assertReviewedWipUnchanged(pinned, wipSnapshotEvidence(rows, [scope("a"), scope("b"), scope("c", "k1"), scope("c", "k2")])))
  for (const field of ["snapshotId", "inputsHash", "earnedRevenueCents", "asOf", "contractId"]) {
    const changed = structuredClone(pinned)
    changed[2][field] = field === "earnedRevenueCents" ? 101 : "changed"
    assert.throws(() => assertReviewedWipUnchanged(pinned, changed), /evidence changed/)
  }
})


test("close requires an attributed WIP review and invalidates it when evidence changes", () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const snapshots = [{ projectId: id(1), snapshotId: id(2), inputsHash: "hash", asOf: "2026-09-30", earnedRevenueCents: 10000, warnings: [] }]
  const review = { reviewerId: id(3), reviewedAt: "2026-10-02T12:00:00Z", note: "Reviewed contract and estimate", snapshots }
  assert.equal(wipReviewMatches(undefined, snapshots), false)
  assert.equal(wipReviewMatches({ snapshots }, snapshots), false)
  assert.equal(wipReviewMatches(review, snapshots), true)
  assert.equal(wipReviewMatches(review, [{ ...snapshots[0], inputsHash: "new-hash" }]), false)
  assert.equal(wipReviewMatches(review, []), false)
})
