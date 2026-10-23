const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

process.env.FILES_STORAGE = "r2"
process.env.R2_ENDPOINT = "https://files.example.test"
process.env.R2_ACCESS_KEY_ID = "test-access-key"
process.env.R2_SECRET_ACCESS_KEY = "test-secret-key"

stubModule("lib/services/books/payroll-document-access.ts", {
  isPayrollDocumentPrivate: async () => false,
  assertPayrollDocumentStorageRead: async () => {},
})
stubModule("lib/storage/payroll-private-storage.ts", {
  isPrivatePayrollPath: () => false,
  readPrivatePayrollRegisterObject: async () => { throw new Error("not under test") },
})

const { createFilesUploadUrl } = freshRequire("lib/storage/files-storage.ts")

test("a signed single PUT covers the reservation metadata as headers the uploader must send", async () => {
  const metadata = { "transfer-id": "transfer-1", "content-identity": `sha256-chain-v1:10:${"a".repeat(64)}` }
  const signed = await createFilesUploadUrl({
    supabase: {}, orgId: "org", path: "org/project/documents/uploads/file.pdf",
    contentType: "application/pdf", metadata, preventOverwrite: true,
  })
  const query = new URL(signed.uploadUrl).searchParams

  assert.deepEqual(signed.uploadHeaders, {
    "x-amz-meta-transfer-id": metadata["transfer-id"],
    "x-amz-meta-content-identity": metadata["content-identity"],
  })
  const signedHeaders = query.get("X-Amz-SignedHeaders").split(";")
  assert.ok(signedHeaders.includes("x-amz-meta-transfer-id"))
  assert.ok(signedHeaders.includes("x-amz-meta-content-identity"))
  assert.ok(signedHeaders.includes("if-none-match"))
  assert.equal(query.get("x-amz-meta-transfer-id"), null, "metadata is not hoisted into the query string")
})
