"use strict"

/**
 * The database contract behind `lib/services/closings.ts`: a closing bills the
 * home once.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember, uuid } = require("./support/pglite")

test("a closing has at most one closing invoice", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const closingId = uuid()
  const invoice = (number, metadata) =>
    insert(db, "invoices", { org_id: orgId, project_id: project.id, invoice_number: number, title: "Closing", metadata: JSON.stringify(metadata) })

  await invoice("CLOSE-1", { invoice_kind: "closing", source_closing_id: closingId })
  await assert.rejects(invoice("CLOSE-2", { invoice_kind: "closing", source_closing_id: closingId }), /invoices_closing_source_unique/)
  // Another closing, and other kinds of invoice on the same home, are unaffected.
  await invoice("CLOSE-3", { invoice_kind: "closing", source_closing_id: uuid() })
  await invoice("DEP-1", { invoice_kind: "earnest_deposit", source_closing_id: closingId })
})
