"use strict"

/**
 * The same invoice PDF uploaded twice. Payables accept the upload (a vendor
 * may resend an invoice) under a free file name, and warn only when another
 * bill already carries that PDF (`payableFileDuplicateWarning`,
 * lib/services/payable-file-duplicates.ts; file naming is
 * `resolveUploadFileName` in lib/services/files.ts).
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire } = require("./support/modules")

const { payableFileDuplicateWarning } = freshRequire("lib/services/payable-file-duplicates.ts")
const { resolveUploadFileName } = freshRequire("lib/services/files.ts")

const BILL = id(1)

test("an invoice upload with identical content is accepted under the next free name", async () => {
  const service = supportPostgrestFilters(
    createServiceHarness({
      tables: {
        files: [
          { id: id(10), org_id: ORG, project_id: null, folder_path: null, archived_at: null, file_name: "invoice.pdf", checksum: "same" },
          { id: id(11), org_id: ORG, project_id: null, folder_path: null, archived_at: null, file_name: "invoice (2).pdf", checksum: "other" },
        ],
      },
    }),
  )
  const input = { supabase: service.client, orgId: ORG, fileName: "invoice.pdf", checksum: "same" }

  assert.equal(await resolveUploadFileName({ ...input, allowDuplicateContent: true }), "invoice (3).pdf")
  await assert.rejects(resolveUploadFileName(input), /Duplicate upload blocked/)
})

test("only another bill carrying the same PDF is a duplicate, and it is advisory", async () => {
  const service = createServiceHarness({
    tables: {
      vendor_bills: [
        { id: BILL, org_id: ORG, invoice: { checksum: "hash" } },
        { id: id(2), org_id: ORG, invoice: { checksum: "other" } },
      ],
    },
  })
  const warning = (billId) => payableFileDuplicateWarning(service.client, ORG, "hash", billId)

  assert.equal(await warning(BILL), null, "a bill is not a duplicate of itself")
  assert.match(await warning(id(3)), /May be a duplicate/)
  assert.equal(await payableFileDuplicateWarning(service.client, ORG, undefined), null)
})

test("a leftover document with no bill is not a duplicate", async () => {
  const service = createServiceHarness({ tables: { vendor_bills: [] } })
  assert.equal(await payableFileDuplicateWarning(service.client, ORG, "hash"), null)
})

test("when the check cannot run, the bill is flagged for review rather than passed", async () => {
  const service = createServiceHarness({ tables: { vendor_bills: [] } })
  service.tamper("vendor_bills", replies.error())
  assert.match(await payableFileDuplicateWarning(service.client, ORG, "hash"), /Duplicate check unavailable/)
})
