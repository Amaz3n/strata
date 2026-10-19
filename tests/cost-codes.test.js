"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { createCostCode, setCostCodeActive, updateCostCode } = freshRequire("lib/services/cost-codes.ts")

const CODE = id(1)
const PARENT = id(2)
const ROOT = id(3)
const FOREIGN_ORG = id(4)

const ADMIN = ["org.admin"]

function costCode(codeId, parentId = null, overrides = {}) {
  return {
    id: codeId,
    org_id: ORG,
    code: codeId.slice(-4),
    name: `Code ${codeId.slice(-4)}`,
    parent_id: parentId,
    is_active: true,
    default_unit_cost_cents: 12345,
    ...overrides,
  }
}

/** The catalog every test starts from: CODE (a root) plus `extra` rows. */
function catalog(extra = [], options = {}) {
  return createServiceHarness({
    tables: { cost_codes: [costCode(CODE), ...extra] },
    permissions: ADMIN,
    ...options,
  })
}

function assertNothingWritten(service) {
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.audits, [])
}

test("every cost code mutation requires org.admin before it reads the catalog", async () => {
  const work = [
    () => createCostCode({ code: "New", name: "New" }),
    () => updateCostCode({ id: CODE, name: "Changed" }),
    () => setCostCodeActive(CODE, false),
  ]
  for (const mutation of work) {
    const service = catalog([], { permissions: [] })
    await assert.rejects(service.run(mutation))
    assert.deepEqual(service.reads("cost_codes"), [])
    assertNothingWritten(service)
  }
})

test("a code is created under a valid parent and audited as the actor", async () => {
  const service = catalog([costCode(PARENT, ROOT), costCode(ROOT)])

  const created = await service.run(() => createCostCode({ code: "New", name: "New", parent_id: PARENT }))

  assert.equal(created.parent_id, PARENT)
  assert.equal(created.org_id, ORG)
  assert.equal(service.audits.length, 1)
  assert.equal(service.audits[0].actorId, ACTOR)
  assert.equal(service.audits[0].after.id, created.id)
})

test("reparenting changes only the parent and audits before and after", async () => {
  const service = catalog([costCode(PARENT, ROOT), costCode(ROOT)])

  const updated = await service.run(() => updateCostCode({ id: CODE, parent_id: PARENT }))

  assert.equal(updated.parent_id, PARENT)
  assert.equal(updated.name, `Code ${CODE.slice(-4)}`)
  assert.equal(updated.default_unit_cost_cents, 12345)
  assert.equal(updated.is_active, true)
  const [audit] = service.audits
  assert.equal(audit.actorId, ACTOR)
  assert.equal(audit.before.parent_id, null)
  assert.equal(audit.after.parent_id, PARENT)
})

test("deactivating a code is the same guarded, audited update", async () => {
  const service = catalog()
  const result = await service.run(() => setCostCodeActive(CODE, false))
  assert.equal(result.is_active, false)
  assert.equal(service.audits[0].after.is_active, false)
})

test("a parent that would form or keep a cycle, or lies outside the org, is refused without writing", async () => {
  const cases = [
    { name: "own parent", rows: [], parent: CODE, error: /own parent/ },
    { name: "a descendant", rows: [costCode(PARENT, CODE)], parent: PARENT, error: /circular/ },
    { name: "an existing cycle", rows: [costCode(PARENT, ROOT), costCode(ROOT, PARENT)], parent: PARENT, error: /circular/ },
    { name: "a missing parent", rows: [], parent: PARENT, error: /parent must belong/ },
    { name: "a missing ancestor", rows: [costCode(PARENT, ROOT)], parent: PARENT, error: /parent must belong/ },
    {
      name: "a foreign parent",
      rows: [costCode(PARENT, null, { org_id: FOREIGN_ORG })],
      parent: PARENT,
      error: /parent must belong/,
    },
    {
      name: "a foreign ancestor",
      rows: [costCode(PARENT, ROOT), costCode(ROOT, null, { org_id: FOREIGN_ORG })],
      parent: PARENT,
      error: /parent must belong/,
    },
  ]
  for (const { name, rows, parent, error } of cases) {
    const service = catalog(rows)
    await assert.rejects(service.run(() => updateCostCode({ id: CODE, parent_id: parent })), error, name)
    assertNothingWritten(service)
  }

  const created = catalog([costCode(PARENT, ROOT), costCode(ROOT, PARENT)])
  await assert.rejects(created.run(() => createCostCode({ code: "New", name: "New", parent_id: PARENT })), /circular/)
  assertNothingWritten(created)
})

test("a descendant past the first page of a large catalog is still found", async () => {
  const many = Array.from({ length: 2000 }, (_, i) => costCode(id(100 + i)))
  const deep = id(5000)
  const service = catalog([...many, costCode(deep, CODE)], { maxRows: 1000 })

  await assert.rejects(service.run(() => updateCostCode({ id: CODE, parent_id: deep })), /circular/)
  assertNothingWritten(service)
})

test("ancestry deeper than the supported limit is refused, not treated as a root", async () => {
  const chain = Array.from({ length: 1001 }, (_, i) => costCode(id(5000 + i), i === 1000 ? null : id(5001 + i)))
  const service = catalog(chain)

  await assert.rejects(service.run(() => updateCostCode({ id: CODE, parent_id: chain[0].id })), /supported depth/)
  assertNothingWritten(service)
})

test("a failed ancestry read refuses the parent instead of treating it as a root", async () => {
  const service = catalog([costCode(PARENT, ROOT), costCode(ROOT)])
  service.tamper("cost_codes", (result, query) => (query.where.id === ROOT ? replies.error()(result) : result))

  await assert.rejects(service.run(() => updateCostCode({ id: CODE, parent_id: PARENT })), /Unable to validate/)
  assertNothingWritten(service)
})

test("clearing the parent repairs a code whose parent no longer exists", async () => {
  const service = catalog()
  service.db.cost_codes[0].parent_id = id(99)

  const repaired = await service.run(() => updateCostCode({ id: CODE, parent_id: null }))
  assert.equal(repaired.parent_id, null)
})

test("a save that returns no row is not reported or audited as a success", async () => {
  for (const [action, mutation] of [
    ["insert", () => createCostCode({ code: "New", name: "New" })],
    ["update", () => updateCostCode({ id: CODE, name: "Changed" })],
  ]) {
    const service = catalog()
    service.tamper("cost_codes", replies.missing(), { on: action })
    await assert.rejects(service.run(mutation), /Missing saved cost code/, action)
    assert.deepEqual(service.audits, [], action)
  }
})
