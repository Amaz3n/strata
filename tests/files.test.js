const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getFileCounts, listFileTimeline, listFiles, prepareProjectDocumentUpload } = freshRequire("lib/services/files.ts")
const { projectUploadRequestSchema } = require("../lib/validation/files")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const PROSPECT = id(3)

const file = (n, overrides = {}) => ({
  id: id(100 + n),
  org_id: ORG,
  project_id: null,
  prospect_id: null,
  file_name: `${n}.pdf`,
  archived_at: null,
  created_at: `2026-10-0${n}T00:00:00Z`,
  ...overrides,
})

function harness({ permissions = ["project.read", "docs.read", "docs.upload"], projects } = {}) {
  return createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG },
        { id: OTHER_PROJECT, org_id: ORG },
      ],
      files: [
        file(1),
        file(2),
        file(3),
        file(4, { project_id: PROJECT }),
        file(5, { prospect_id: PROSPECT }),
        file(6, { org_id: id(99) }),
        file(7, { archived_at: "2026-10-01T00:00:00Z" }),
      ],
    },
    rpc: {
      office_document_counts: ({ p_org_id }) => ({
        data: p_org_id === ORG ? [{ category: "all", file_count: 4 }] : [],
        error: null,
      }),
    },
  })
}

const names = (result) => result.data.map((row) => row.file_name).sort()

describe("listing documents", () => {
  test("the office list holds only live org files with no project and no prospect, paged", async () => {
    const service = harness()

    const first = await service.run(() => listFiles({ org_only: true, offset: 0, limit: 2 }))
    const second = await service.run(() => listFiles({ org_only: true, offset: 2, limit: 2 }))

    assert.equal(first.count, 3)
    assert.equal(first.hasMore, true)
    assert.equal(second.hasMore, false)
    assert.deepEqual([...names(first), ...names(second)].sort(), ["1.pdf", "2.pdf", "3.pdf"])
  })

  test("a project list holds only that project's files", async () => {
    const service = harness()
    assert.deepEqual(names(await service.run(() => listFiles({ project_id: PROJECT }))), ["4.pdf"])
  })

  test("office counts come from the office-only aggregate for the caller's org", async () => {
    const service = harness()
    assert.deepEqual(await service.run(() => getFileCounts(undefined, undefined, true)), { all: 4 })
  })
})

describe("preparing an upload", () => {
  const upload = { fileName: "Plans.pdf", contentType: "application/pdf", fileSize: 100 }

  test("an office upload is authorized by the org and lands in the general namespace", async () => {
    const service = harness()

    const result = await service.run(() => prepareProjectDocumentUpload(upload))

    assert.ok(result.storagePath.startsWith(`${ORG}/general/documents/uploads/`), result.storagePath)
    assert.equal(result.projectId, undefined)
    assert.deepEqual(service.reads("projects"), [])
  })

  test("a project upload lands under the project the actor may upload to", async () => {
    const service = harness()

    const result = await service.run(() => prepareProjectDocumentUpload({ ...upload, projectId: PROJECT }))

    assert.ok(result.storagePath.startsWith(`${ORG}/${PROJECT}/documents/uploads/`), result.storagePath)
  })

  test("uploads without permission, or into an unreachable project, are forbidden", async () => {
    const cases = [
      { options: { permissions: ["project.read", "docs.read"] }, input: upload },
      { options: { projects: [OTHER_PROJECT] }, input: { ...upload, projectId: PROJECT } },
      { options: {}, input: { ...upload, projectId: id(404) } },
    ]
    for (const { options, input } of cases) {
      const service = harness(options)
      await assert.rejects(service.run(() => prepareProjectDocumentUpload(input)), (error) => error.status === 403)
    }
  })

  test("an active web document or an empty file is a bad request", async () => {
    for (const input of [{ ...upload, fileName: "page.html", contentType: "text/html" }, { ...upload, fileSize: 0 }]) {
      const service = harness()
      await assert.rejects(service.run(() => prepareProjectDocumentUpload(input)), (error) => error.status === 400)
    }
  })

  test("the upload request schema refuses a malformed project id", () => {
    assert.equal(projectUploadRequestSchema.safeParse({ projectId: "bad", fileName: "Handbook.pdf" }).success, false)
  })
})

describe("a file's timeline", () => {
  const audit = (n, org_id = ORG, entity_id = id(101)) => ({
    id: n, org_id, entity_type: "file", entity_id, action: "update", before_data: null, after_data: { file_name: "x.pdf" },
    actor_user_id: null, created_at: `2026-10-0${n}T00:00:00Z`,
  })

  function timelineHarness(permissions) {
    return createServiceHarness({
      permissions,
      tables: {
        file_access_events: [],
        events: [],
        app_users: [],
        audit_log: [audit(1), audit(2), audit(3, id(99)), audit(4, ORG, id(102))],
      },
    })
  }

  test("a document reader sees this file's change history in this org only", async () => {
    const service = timelineHarness(["docs.read"])
    const timeline = await service.run(() => listFileTimeline(id(101)))
    assert.deepEqual(timeline.map((event) => event.id).sort(), ["audit-1", "audit-2"])
  })

  test("without docs.read the timeline is refused before any history is read", async () => {
    const service = timelineHarness([])
    await assert.rejects(service.run(() => listFileTimeline(id(101))))
    assert.deepEqual(service.reads("audit_log"), [])
  })
})
