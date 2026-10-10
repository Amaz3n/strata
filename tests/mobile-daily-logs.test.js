const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

// Boundary: the object store. Nothing here should upload; retries only sign.
const storage = require("@/lib/storage/files-storage")
stubModule("lib/storage/files-storage.ts", {
  ...storage,
  async uploadFilesObject() {
    throw new Error("a retry must not upload")
  },
  async createFilesDownloadUrl({ path }) {
    return { downloadUrl: `https://files.test/${path}` }
  },
})

const { uploadMobileDailyLogPhoto } = freshRequire("lib/mobile/daily-logs.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const LOG = id(3)
const OTHER_LOG = id(4)
const PHOTO = id(5)

const project = (projectId) => ({
  id: projectId,
  org_id: ORG,
  name: "Lot 12",
  phase: "delivery",
  property_type: "residential",
  status: "active",
  created_at: "2026-10-01T00:00:00Z",
})

const photoFile = (overrides) => ({
  id: PHOTO,
  org_id: ORG,
  project_id: PROJECT,
  daily_log_id: LOG,
  file_name: "slab.jpg",
  mime_type: "image/jpeg",
  storage_path: `${ORG}/${PROJECT}/daily-logs/uploads/slab.jpg`,
  ...overrides,
})

function harness(existing) {
  const service = createServiceHarness({
    permissions: ["project.read", "daily_log.read", "daily_log.write"],
    tables: {
      projects: [project(PROJECT), project(OTHER_PROJECT)],
      daily_logs: [
        { id: LOG, org_id: ORG, project_id: PROJECT },
        { id: OTHER_LOG, org_id: ORG, project_id: PROJECT },
      ],
      files: [existing],
    },
  })
  service.context = mobileContext(service)
  return service
}

function upload() {
  const form = new FormData()
  form.set("client_id", PHOTO)
  form.set("file", new File([Buffer.from("jpeg")], "slab.jpg", { type: "image/jpeg" }))
  return form
}

describe("retrying a daily-log photo upload", () => {
  test("a retry of this log's own upload returns the stored photo", async () => {
    const service = harness(photoFile())

    const photo = await service.run(() => uploadMobileDailyLogPhoto(service.context, PROJECT, LOG, upload()))

    assert.equal(photo.id, PHOTO)
    assert.match(photo.download_url, /slab\.jpg$/)
  })

  test("an upload id that names a file on another house or another log is a conflict", async () => {
    for (const existing of [photoFile({ project_id: OTHER_PROJECT }), photoFile({ daily_log_id: OTHER_LOG })]) {
      const service = harness(existing)

      await assert.rejects(
        service.run(() => uploadMobileDailyLogPhoto(service.context, PROJECT, LOG, upload())),
        status(409),
      )
      assert.deepEqual(service.writes(), [])
    }
  })
})
