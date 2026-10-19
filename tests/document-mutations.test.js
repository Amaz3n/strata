const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { mutateDocuments, undoDocumentMutation } = freshRequire("lib/services/document-mutations.ts")

// The SQL side (row locks, receipts, undo conflicts) is tests/documents-db.test.js.

const PROJECT_A = id(1)
const PROJECT_B = id(2)
const FILE_A = id(10)
const FILE_B = id(11)
const FOREIGN_FILE = id(12)
const RECEIPT = id(20)

const NOTHING = { receiptId: null, projectIds: [], files: [] }

function harness({ permissions = ["project.read", "docs.upload", "docs.delete"], projects, receipts = [] } = {}) {
  const service = createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: PROJECT_A, org_id: ORG },
        { id: PROJECT_B, org_id: ORG },
      ],
      files: [
        { id: FILE_A, org_id: ORG, project_id: PROJECT_A },
        { id: FILE_B, org_id: ORG, project_id: PROJECT_B },
        { id: FOREIGN_FILE, org_id: id(99), project_id: id(98) },
      ],
      document_mutation_receipts: receipts,
    },
    rpc: {
      mutate_documents: (args) => ({ data: { receiptId: RECEIPT, projectIds: Object.values(args.p_scopes), files: [] }, error: null }),
      undo_document_mutation: () => ({ data: NOTHING, error: null }),
    },
  })
  service.rpcCalls = (name) => service.queries.filter((query) => query.table === `rpc:${name}`).map((query) => query.payload)
  return service
}

describe("mutating documents", () => {
  test("a move hands the transaction the actor and each file's authorized project", async () => {
    const service = harness()

    const result = await service.run(() =>
      mutateDocuments({ fileIds: [FILE_A, FILE_B, FILE_A], kind: "move", folderPath: "/Target" }),
    )

    assert.equal(result.receiptId, RECEIPT)
    const [call] = service.rpcCalls("mutate_documents")
    assert.equal(call.p_actor_id, ACTOR)
    assert.equal(call.p_org_id, ORG)
    assert.deepEqual(call.p_file_ids, [FILE_A, FILE_B])
    assert.deepEqual(call.p_scopes, { [FILE_A]: PROJECT_A, [FILE_B]: PROJECT_B })
  })

  test("a selection reaching a project the actor cannot write is refused whole", async () => {
    for (const kind of ["move", "archive"]) {
      const service = harness({ projects: [PROJECT_A] })
      await assert.rejects(service.run(() => mutateDocuments({ fileIds: [FILE_A, FILE_B], kind })))
      assert.deepEqual(service.rpcCalls("mutate_documents"), [], kind)
    }
  })

  test("archiving needs docs.delete, not docs.upload", async () => {
    const service = harness({ permissions: ["project.read", "docs.upload"] })
    await assert.rejects(service.run(() => mutateDocuments({ fileIds: [FILE_A], kind: "archive" })))
    assert.deepEqual(service.rpcCalls("mutate_documents"), [])
  })

  test("a file from another org or one that does not exist makes the selection unavailable", async () => {
    for (const missing of [FOREIGN_FILE, id(404)]) {
      const service = harness()
      await assert.rejects(
        service.run(() => mutateDocuments({ fileIds: [FILE_A, missing], kind: "restore" })),
        /unavailable/,
      )
      assert.deepEqual(service.rpcCalls("mutate_documents"), [])
    }
  })

  test("malformed ids and oversized selections are refused before any read", async () => {
    for (const fileIds of [["not-a-uuid"], Array(501).fill(FILE_A)]) {
      const service = harness()
      await assert.rejects(service.run(() => mutateDocuments({ fileIds, kind: "move" })))
      assert.deepEqual(service.reads("files"), [])
    }
  })

  test("an empty selection is a no-op", async () => {
    const service = harness()
    assert.deepEqual(await service.run(() => mutateDocuments({ fileIds: [], kind: "move" })), NOTHING)
    assert.deepEqual(service.rpcCalls("mutate_documents"), [])
  })
})

describe("undoing a mutation", () => {
  const receipt = (overrides = {}) => ({
    id: RECEIPT,
    org_id: ORG,
    actor_id: ACTOR,
    kind: "archive",
    project_ids: [PROJECT_A],
    ...overrides,
  })

  test("undo takes its scope from the actor's own server receipt", async () => {
    const service = harness({ receipts: [receipt()] })

    assert.deepEqual(await service.run(() => undoDocumentMutation(RECEIPT)), NOTHING)
    assert.deepEqual(service.rpcCalls("undo_document_mutation"), [
      { p_org_id: ORG, p_actor_id: ACTOR, p_receipt_id: RECEIPT },
    ])
  })

  test("another actor's receipt, or one for a project the actor lost, cannot be undone", async () => {
    const cases = [
      { receipts: [receipt({ actor_id: id(77) })], error: /unavailable/ },
      { receipts: [receipt({ project_ids: [PROJECT_B] })], projects: [PROJECT_A], error: /./ },
    ]
    for (const { error, ...options } of cases) {
      const service = harness(options)
      await assert.rejects(service.run(() => undoDocumentMutation(RECEIPT)), error)
      assert.deepEqual(service.rpcCalls("undo_document_mutation"), [])
    }
  })
})
