const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

// Boundary: signing download URLs against the object store.
const signed = []
const storage = require("@/lib/storage/files-storage")
stubModule("lib/storage/files-storage.ts", {
  ...storage,
  async createFilesDownloadUrl({ path }) {
    signed.push(path)
    return { downloadUrl: `https://files.test/${path}` }
  },
})

const { deleteMobileFile, listMobileFiles, uploadMobileFile } = freshRequire("lib/mobile/files.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const DAILY_LOG = id(3)

const project = (projectId) => ({
  id: projectId,
  org_id: ORG,
  name: "Lot 12",
  phase: "delivery",
  property_type: "residential",
  status: "active",
  created_at: "2026-10-01T00:00:00Z",
})

const file = (n, overrides = {}) => ({
  id: id(10_000 + n),
  org_id: ORG,
  project_id: PROJECT,
  file_name: `${String(n).padStart(4, "0")}.pdf`,
  folder_path: "/",
  storage_path: `${ORG}/files/${n}`,
  archived_at: null,
  daily_log_id: null,
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
})

/** 1,002 live project documents (more than one PostgREST page) and some that must never show. */
function documents() {
  const rows = Array.from({ length: 1002 }, (_, n) => file(n))
  rows[1000].folder_path = "/Plans/Nested"
  rows[1001].folder_path = "/Plans2"
  rows.push(
    file(2000, { project_id: OTHER_PROJECT }),
    file(2001, { org_id: id(99) }),
    file(2002, { archived_at: "2026-10-02T00:00:00Z" }),
    file(2003, { daily_log_id: DAILY_LOG }),
  )
  return rows
}

function harness({ permissions = ["project.read", "docs.read", "docs.upload", "docs.delete"], files = documents() } = {}) {
  const service = createServiceHarness({
    permissions,
    maxRows: 1000,
    tables: { projects: [project(PROJECT), project(OTHER_PROJECT)], files },
  })
  service.context = mobileContext(service)
  return service
}

beforeEach(() => {
  signed.length = 0
})

describe("listing a project's documents", () => {
  test("the download manifest pages through every live document of this project only", async () => {
    const service = harness()

    const { files } = await service.run(() => listMobileFiles(service.context, PROJECT, "/", true))

    assert.equal(files.length, 1002)
    assert.equal(signed.length, 1002)
    const hidden = [2000, 2001, 2002, 2003].map((n) => file(n).id)
    assert.ok(files.every((entry) => !hidden.includes(entry.id)), "no foreign, archived or daily-log file")
  })

  test("browsing a folder lists its direct files and its immediate subfolders, kept apart from lookalikes", async () => {
    const service = harness()

    const plans = await service.run(() => listMobileFiles(service.context, PROJECT, "/Plans"))
    assert.deepEqual(plans, { folders: [{ path: "/Plans/Nested", name: "Nested", file_count: 1 }], files: [] })
    assert.deepEqual(signed, [])

    const root = await service.run(() => listMobileFiles(service.context, PROJECT, "/"))
    assert.deepEqual(
      root.folders.map((folder) => [folder.path, folder.file_count]),
      [
        ["/Plans", 1],
        ["/Plans2", 1],
      ],
    )
    assert.equal(root.files.length, 1000)
  })
})

test("reading, uploading and deleting each need their own permission", async () => {
  const upload = new FormData()
  upload.set("file", new File(["%PDF"], "plans.pdf", { type: "application/pdf" }))
  upload.set("client_id", id(7))
  const attempts = {
    "docs.read": (service) => listMobileFiles(service.context, PROJECT, "/"),
    "docs.upload": (service) => uploadMobileFile(service.context, PROJECT, upload),
    "docs.delete": (service) => deleteMobileFile(service.context, PROJECT, id(10_000)),
  }
  for (const [permission, attempt] of Object.entries(attempts)) {
    const others = Object.keys(attempts).filter((key) => key !== permission)
    const service = harness({ permissions: ["project.read", ...others] })
    await assert.rejects(service.run(() => attempt(service)), status(403), permission)
    assert.deepEqual(service.reads("files"), [], permission)
    assert.deepEqual(service.writes(), [], permission)
  }
})

test("a project the caller cannot see is not found", async () => {
  const service = harness()
  await assert.rejects(service.run(() => listMobileFiles(service.context, id(404), "/")), status(404))
})

describe("deleting a document", () => {
  test("delete archives the file, keeping the record, and audits it", async () => {
    const service = harness({ files: [file(1)] })

    await service.run(() => deleteMobileFile(service.context, PROJECT, file(1).id))

    assert.ok(service.db.files[0].archived_at)
    assert.equal(service.audits[0].entityId, file(1).id)
  })

  test("a daily-log photo, or another project's file, cannot be deleted here", async () => {
    const service = harness({ files: [file(1, { daily_log_id: DAILY_LOG }), file(2, { project_id: OTHER_PROJECT })] })

    await assert.rejects(service.run(() => deleteMobileFile(service.context, PROJECT, file(1).id)), status(409))
    await assert.rejects(service.run(() => deleteMobileFile(service.context, PROJECT, file(2).id)), status(404))
    assert.deepEqual(service.writes(), [])
  })
})
