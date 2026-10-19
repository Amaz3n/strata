const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")

// Boundaries: the service database client and the object store's HEAD.
const world = { db: null, object: null }
stubModule("lib/supabase/server.ts", { createServiceSupabaseClient: () => world.db })
stubModule("lib/storage/files-storage.ts", { headFilesObject: async () => world.object })

const { assertDocumentUploadObject } = freshRequire("lib/services/document-upload-object.ts")

const input = {
  orgId: "org",
  userId: "actor",
  projectId: "project",
  storagePath: "org/object",
  fileName: "plan.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
}
const reservation = {
  id: "transfer",
  org_id: "org",
  storage_path: "org/object",
  created_by: "actor",
  project_id: "project",
  file_name: "plan.pdf",
  content_type: "application/pdf",
  file_size: 10,
  identity: "content",
  cancelled_at: null,
}
const uploaded = { size: 10, metadata: { "transfer-id": "transfer", "content-identity": "content" } }

function verify({ transfer = reservation, object = uploaded, ...overrides } = {}) {
  world.db = createFakeSupabase({ document_upload_transfers: transfer ? [transfer] : [] })
  world.object = object
  return assertDocumentUploadObject({ ...input, ...overrides })
}

test("an object matching its reservation finalizes", async () => {
  await verify()
})

test("an upload without a reservation still has to match its byte length", async () => {
  await verify({ transfer: null })
  await assert.rejects(verify({ transfer: null, object: { ...uploaded, size: 9 } }), /size/)
})

test("a reservation made by someone else, cancelled, or for a different file is refused", async () => {
  const changes = [
    { created_by: "other" },
    { cancelled_at: "2026-10-01T00:00:00Z" },
    { file_size: 11 },
    { project_id: "other" },
    { file_name: "other.pdf" },
    { content_type: "image/png" },
  ]
  for (const change of changes) {
    await assert.rejects(verify({ transfer: { ...reservation, ...change } }), /reservation/, JSON.stringify(change))
  }
})

test("an equal-sized object must still prove it came from the reserved transfer", async () => {
  const foreign = { size: 10, metadata: { "transfer-id": "other", "content-identity": "content" } }
  await assert.rejects(verify({ object: foreign }), /reservation/)
})

test("a direct version upload requires a reservation, and another org's does not count", async () => {
  await assert.rejects(verify({ transfer: null, requireReservation: true }), /reservation is required/)
  await assert.rejects(
    verify({ transfer: { ...reservation, org_id: "other-org" }, requireReservation: true }),
    /reservation is required/,
  )
})
