const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext } = require("./support/mobile")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const ESTIMATE = id(3)
const EXECUTED = id(4)

// Boundaries: the bearer-token session (lib/mobile/auth has its own suite), the
// stored executed PDF, and the desk's live PDF renderer.
const world = { context: null, renders: 0, downloads: [] }
stubModule("lib/mobile/auth.ts", { requireMobileOrg: async () => world.context })
const storage = require("@/lib/storage/files-storage")
stubModule("lib/storage/files-storage.ts", {
  ...storage,
  async downloadFilesObject({ path }) {
    world.downloads.push(path)
    return Buffer.from("%PDF-stored")
  },
})
stubModule("app/(app)/estimates/[id]/export/route.ts", {
  async GET() {
    world.renders += 1
    return new Response("%PDF-draft", { headers: { "Content-Type": "application/pdf" } })
  },
})

const { GET } = freshRequire("app/api/mobile/v1/workspace/estimates/[recordId]/pdf/route.ts")

const project = (projectId) => ({
  id: projectId,
  org_id: ORG,
  name: "Lot 12",
  phase: "delivery",
  property_type: "residential",
  status: "active",
  created_at: "2026-10-01T00:00:00Z",
})

function harness({ permissions = ["project.read", "project.manage"], estimate = {}, files = [] } = {}) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [project(PROJECT), project(OTHER_PROJECT)],
      estimates: [{ id: ESTIMATE, org_id: ORG, project_id: PROJECT, executed_file_id: null, ...estimate }],
      files,
    },
  })
  world.context = mobileContext(service)
  service.get = (projectId = PROJECT) =>
    service.run(() =>
      GET(new Request(`https://arc.test/api/mobile/v1/workspace/estimates/${ESTIMATE}/pdf?project_id=${projectId}`), {
        params: Promise.resolve({ recordId: ESTIMATE }),
      }),
    )
  return service
}

beforeEach(() => {
  world.renders = 0
  world.downloads.length = 0
})

test("a draft estimate renders through the desk's PDF, never cached", async () => {
  const response = await harness().get()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.equal(await response.text(), "%PDF-draft")
})

test("an executed estimate serves its stored file and never re-renders", async () => {
  const executed = { estimate: { executed_file_id: EXECUTED } }
  const stored = await harness({ ...executed, files: [{ id: EXECUTED, org_id: ORG, storage_path: `${ORG}/executed.pdf` }] }).get()
  assert.equal(await stored.text(), "%PDF-stored")
  assert.deepEqual(world.downloads, [`${ORG}/executed.pdf`])

  const missing = await harness(executed).get()
  assert.equal(missing.status, 404)
  assert.equal(world.renders, 0)
})

test("an estimate from another project, or a caller without the module, gets no PDF", async () => {
  const cases = [
    { options: { estimate: { project_id: OTHER_PROJECT } }, status: 404 },
    { options: { permissions: ["project.read"] }, status: 403 },
  ]
  for (const { options, status } of cases) {
    assert.equal((await harness(options).get()).status, status)
  }
  assert.equal(world.renders, 0)
  assert.deepEqual(world.downloads, [])
})

test("a malformed project id is refused before any lookup", async () => {
  const service = harness()
  assert.equal((await service.get("not-a-uuid")).status, 422)
  assert.deepEqual(service.reads("estimates"), [])
})
