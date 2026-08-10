require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  SEARCH_TYPE_PERMISSION,
  WILDCARD_PERMISSION,
  canReadSearchType,
  describeBlockedTypes,
  filterResultsByPermission,
  permissionForSearchType,
  visibleSearchEntityTypes,
} = require("../lib/ai/search-visibility")

const fs = require("node:fs")
const path = require("node:path")

// ---------------------------------------------------------------------------
// The map must stay honest about the catalog
//
// `lib/services/team.ts` is server-only and cannot be imported here, so the
// catalog is read as source. Worth the awkwardness: a gate on a permission key
// that does not exist would deny every user silently, which is the one failure
// mode of this file nobody would notice.
// ---------------------------------------------------------------------------

function catalogPermissionKeys() {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "services", "team.ts"), "utf8")
  const keys = new Set()
  for (const match of source.matchAll(/\{\s*key:\s*"([^"]+)"/g)) {
    keys.add(match[1])
  }
  return keys
}

test("every gated permission exists in the RBAC catalog", () => {
  const catalog = catalogPermissionKeys()
  assert.ok(catalog.size > 50, "failed to read the permission catalog")
  for (const [type, permission] of Object.entries(SEARCH_TYPE_PERMISSION)) {
    assert.ok(catalog.has(permission), `${type} is gated on unknown permission "${permission}"`)
  }
})

test("financial entity types are gated", () => {
  // The whole point: these are the ones a member can be inside an org and still
  // have no clearance for.
  for (const type of ["invoice", "budget", "commitment", "payable"]) {
    assert.ok(permissionForSearchType(type), `${type} must be gated`)
  }
})

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("an ungated type is readable by any member", () => {
  assert.equal(canReadSearchType("rfi", new Set()), true)
  assert.equal(canReadSearchType("daily_log", new Set()), true)
})

test("a gated type needs its permission", () => {
  assert.equal(canReadSearchType("invoice", new Set()), false)
  assert.equal(canReadSearchType("invoice", new Set(["invoice.read"])), true)
})

test("a different financial permission does not unlock invoices", () => {
  assert.equal(canReadSearchType("invoice", new Set(["budget.read"])), false)
})

test("the wildcard unlocks everything", () => {
  assert.equal(canReadSearchType("invoice", new Set([WILDCARD_PERMISSION])), true)
  assert.equal(canReadSearchType("payable", new Set([WILDCARD_PERMISSION])), true)
})

// ---------------------------------------------------------------------------
// Pre-filtering requested types
// ---------------------------------------------------------------------------

test("blocked types are dropped before retrieval runs", () => {
  const visible = visibleSearchEntityTypes(
    ["project", "invoice", "rfi", "budget"],
    new Set(["budget.read"]),
  )
  assert.deepEqual(visible, ["project", "rfi", "budget"])
})

test("a user with no permissions still gets the ungated types", () => {
  const visible = visibleSearchEntityTypes(["invoice", "task"], new Set())
  assert.deepEqual(visible, ["task"])
})

test("requesting nothing returns nothing rather than everything", () => {
  assert.deepEqual(visibleSearchEntityTypes([], new Set([WILDCARD_PERMISSION])), [])
})

// ---------------------------------------------------------------------------
// Post-filtering results
// ---------------------------------------------------------------------------

const RESULTS = [
  { type: "project", id: "p1" },
  { type: "invoice", id: "i1" },
  { type: "invoice", id: "i2" },
  { type: "payable", id: "b1" },
]

test("results the user cannot read are removed and the types reported", () => {
  const { visible, blockedTypes } = filterResultsByPermission(RESULTS, new Set())
  assert.deepEqual(
    visible.map((result) => result.id),
    ["p1"],
  )
  assert.deepEqual(blockedTypes, ["invoice", "payable"])
})

test("a blocked type is reported once however many rows it had", () => {
  const { blockedTypes } = filterResultsByPermission(RESULTS, new Set(["bill.read"]))
  assert.deepEqual(blockedTypes, ["invoice"])
})

test("nothing is filtered for a wildcard holder", () => {
  const { visible, blockedTypes } = filterResultsByPermission(RESULTS, new Set([WILDCARD_PERMISSION]))
  assert.equal(visible.length, RESULTS.length)
  assert.deepEqual(blockedTypes, [])
})

test("a fully permitted user sees everything and is told nothing was dropped", () => {
  const granted = new Set(["invoice.read", "bill.read"])
  const { visible, blockedTypes } = filterResultsByPermission(RESULTS, granted)
  assert.equal(visible.length, 4)
  assert.equal(describeBlockedTypes(blockedTypes), null)
})

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

test("exclusions are stated, never silent", () => {
  const message = describeBlockedTypes(["invoice", "payable"])
  assert.match(message, /left out/)
  assert.match(message, /invoice, payable/)
})

test("underscores are humanised in the disclosure", () => {
  assert.match(describeBlockedTypes(["change_event"]), /change event/)
})

test("no exclusions produces no message", () => {
  assert.equal(describeBlockedTypes([]), null)
})
