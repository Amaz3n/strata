const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// Boundary: signing a download URL against the object store.
const signed = []
const storage = require("@/lib/storage/files-storage")
stubModule("lib/storage/files-storage.ts", {
  ...storage,
  async createFilesDownloadUrl(args) {
    signed.push(args)
    return { downloadUrl: `https://files.test/${args.path}` }
  },
})

const { getVersionSignedUrl, hasVersions, listVersions, updateVersion } = freshRequire("lib/services/file-versions.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const FILE = id(10)
const CURRENT = id(20)
const PREVIOUS = id(21)

const ALL = ["project.read", "docs.read", "docs.upload", "docs.download"]

function harness({ permissions = ALL, projects } = {}) {
  return createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG },
        { id: OTHER_PROJECT, org_id: ORG },
      ],
      files: [{ id: FILE, org_id: ORG, project_id: PROJECT, current_version_id: CURRENT }],
      doc_versions: [
        { id: PREVIOUS, org_id: ORG, file_id: FILE, version_number: 1, storage_path: `${ORG}/v1.pdf`, file_name: "v1.pdf" },
        { id: CURRENT, org_id: ORG, file_id: FILE, version_number: 2, storage_path: `${ORG}/v2.pdf`, file_name: "v2.pdf" },
      ],
    },
  })
}

beforeEach(() => {
  signed.length = 0
})

test("version history lists newest first and marks the file's current version", async () => {
  const service = harness()

  const versions = await service.run(() => listVersions(FILE))

  assert.deepEqual(
    versions.map((version) => [version.version_number, version.is_current]),
    [
      [2, true],
      [1, false],
    ],
  )
  assert.equal(await service.run(() => hasVersions(FILE)), true)
})

test("reading, downloading or relabelling a version needs access to the file's project", async () => {
  const attempts = [
    () => listVersions(FILE),
    () => hasVersions(FILE),
    () => getVersionSignedUrl(CURRENT),
    () => updateVersion(CURRENT, { label: "Issued" }),
  ]
  for (const attempt of attempts) {
    const service = harness({ projects: [OTHER_PROJECT] })
    await assert.rejects(service.run(attempt))
    assert.deepEqual(service.writes(), [])
    assert.ok(service.reads("doc_versions").length <= 1, "no history is listed")
  }
  assert.deepEqual(signed, [])
})

test("an authorized download signs the version as an attachment for the requested time", async () => {
  const service = harness()

  const url = await service.run(() => getVersionSignedUrl(PREVIOUS, 120))

  assert.equal(url, `https://files.test/${ORG}/v1.pdf`)
  assert.equal(signed[0].expiresIn, 120)
  assert.equal(signed[0].disposition, "attachment")
})

test("a relabel is audited and only touches label and notes", async () => {
  const service = harness()

  const version = await service.run(() => updateVersion(PREVIOUS, { label: "Issued for permit" }))

  assert.equal(version.label, "Issued for permit")
  assert.equal(version.is_current, false)
  assert.deepEqual(service.writes("doc_versions").map((write) => write.payload), [{ label: "Issued for permit" }])
  assert.equal(service.audits[0].entityId, PREVIOUS)
})
