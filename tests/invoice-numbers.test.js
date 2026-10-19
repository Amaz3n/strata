"use strict"

/**
 * Invoice numbering: the number formats (`lib/invoices/invoice-number-format.ts`)
 * and the reservation every composer gets (`getNextInvoiceNumber`,
 * lib/services/invoice-numbers.ts). A number is offered only once it is
 * reserved in the database, never from a cache or a guess.
 *
 * Replaced: which ledger is authoritative and which accounting connection a
 * project routes to (their own services), and the accounting provider itself.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const { compareInvoiceNumbers, incrementInvoiceNumber } = require("@/lib/invoices/invoice-number-format")

let world
stubModule("@/lib/services/books/authority", { resolveLedgerAuthority: async () => world.authority })
stubModule("@/lib/services/accounting-target", {
  resolveAccountingTarget: async ({ projectId }) => {
    world.routedProject = projectId
    return { connection: { id: `connection-${world.connection}`, provider: "qbo", settings: {} } }
  },
})
stubModule("@/lib/integrations/accounting/registry", {
  getProvider: () => ({
    getLastInvoiceNumber: async () => {
      world.providerReads += 1
      if (world.providerFails) throw new Error("offline")
      return world.providerNumber
    },
  }),
})

const { getNextInvoiceNumber } = freshRequire("lib/services/invoice-numbers.ts")

let connections = 0
function setup({ authority = "arc", invoices = [], reservations = [], providerNumber = "100", providerFails = false } = {}) {
  const service = createServiceHarness({
    tables: {
      invoices: invoices.map((invoice_number, n) => ({ id: id(1000 + n), org_id: ORG, invoice_number })),
      qbo_invoice_reservations: reservations.map((row) => ({ org_id: ORG, ...row })),
    },
  })
  // The unique index on live reservations: a second insert of the same number fails.
  service.tamper(
    "qbo_invoice_reservations",
    (result) => {
      const [inserted] = result.data ? [result.data] : []
      const rows = service.db.qbo_invoice_reservations
      const taken = rows.some(
        (row) => row !== rows.at(-1) && row.reserved_number === inserted?.reserved_number && (row.status ?? "reserved") === "reserved",
      )
      if (!taken) return result
      rows.pop()
      return { data: null, error: { code: "23505", message: "duplicate key" } }
    },
    { on: "insert" },
  )
  // Each test gets its own connection so the provider-cursor cache never leaks between tests.
  connections += 1
  world = { authority, providerNumber, providerFails, providerReads: 0, routedProject: undefined, connection: connections }
  return service
}

test("numbers keep their prefix and padding, and very large sequences stay exact", () => {
  assert.equal(incrementInvoiceNumber("0012"), "0013")
  assert.equal(incrementInvoiceNumber("JOB-2026/0099"), "JOB-2026/0100")
  assert.equal(incrementInvoiceNumber("other", { invoice_number_pattern: "prefix", invoice_number_prefix: "INV-" }), "INV-0001")
  assert.equal(incrementInvoiceNumber("9007199254740993"), "9007199254740994")
  assert.equal(compareInvoiceNumbers("9007199254740994", "9007199254740993"), 1)
})

test("simultaneous composers each get a different reserved number, without asking any provider", async () => {
  const service = setup({ invoices: ["99", "12", "15"] })
  const results = await service.run(() =>
    Promise.all(Array.from({ length: 12 }, () => getNextInvoiceNumber(ORG, "project"))),
  )

  assert.equal(new Set(results.map((result) => result.number)).size, 12)
  assert.ok(results.every((result) => result.reservation_id && result.source === "local"))
  assert.ok(results.every((result) => Number(result.number) > 99))
  assert.equal(world.providerReads, 0)
  assert.equal(world.routedProject, undefined)
})

test("the next number counts every invoice, past the first page, and numbers already used by reservations", async () => {
  const invoices = [...Array.from({ length: 1000 }, (_, n) => String(n + 1)), "5000"]
  const service = setup({ invoices, reservations: [{ id: id(1), status: "used", reserved_number: "6000" }] })
  const result = await service.run(() => getNextInvoiceNumber())
  assert.equal(result.number, "6001")
})

test("with external books, the project's provider is asked once and concurrent composers still differ", async () => {
  const service = setup({ authority: "external", providerNumber: "INV-0100" })
  const results = await service.run(() => Promise.all([getNextInvoiceNumber(ORG, "job"), getNextInvoiceNumber(ORG, "job")]))

  assert.equal(world.providerReads, 1)
  assert.equal(world.routedProject, "job")
  assert.deepEqual(results.map((result) => result.number).sort(), ["INV-0101", "INV-0102"])
  assert.ok(results.every((result) => result.source === "accounting"))
})

test("a provider outage still reserves a real local number, with a warning to check it", async () => {
  const service = setup({ authority: "external", providerFails: true, invoices: ["INV-0200"] })
  const result = await service.run(() => getNextInvoiceNumber())

  assert.equal(result.number, "INV-0201")
  assert.equal(result.source, "local")
  assert.ok(result.reservation_id)
  assert.match(result.warning, /couldn't confirm/)
})

test("a database failure refuses to offer an unreserved number", async () => {
  const service = setup()
  service.tamper("invoices", replies.error("database unavailable"))
  await assert.rejects(service.run(() => getNextInvoiceNumber()), /database unavailable/)
  assert.equal(service.writes("qbo_invoice_reservations").filter((query) => query.action === "insert").length, 0)
})
