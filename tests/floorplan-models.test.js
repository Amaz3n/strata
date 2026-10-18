const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")
const {
  areaEvidence,
  createTileStorage,
  createVisionProvider,
  rectanglePath,
  stubTileStorage,
  stubVisionProvider,
  withEmbedded,
} = require("./support/drawings")

const { runAreaEngine } = require("../lib/drawings/area-engine")
const { encodeTextRuns } = require("../lib/drawings/text-runs")

const orgId = randomUUID()
const otherOrgId = randomUUID()
const projectId = randomUUID()
const generationId = randomUUID()
const sheetId = randomUUID()
const revisionId = randomUUID()

// A 1000px sheet at 0.02 ft/px: a double wall line whose inner face encloses 15 ft x 15 ft.
const evidence = areaEvidence([
  rectanglePath(0, [0.1, 0.1, 0.9, 0.9], { layer: ["A_WALL"] }),
  rectanglePath(1, [0.125, 0.125, 0.875, 0.875], { layer: ["A_WALL"] }),
])
const textRuns = [{ text: "LIVING", x: 0.4, y: 0.4, w: 0.1, h: 0.03 }]

const storage = stubTileStorage(createTileStorage())
const vision = stubVisionProvider(createVisionProvider(null, { configured: false }))
const events = []
stubModule("lib/services/events.ts", { recordEvent: async (event) => events.push(event) })
const database = { client: null }
stubModule("lib/supabase/server.ts", { createServiceSupabaseClient: () => database.client })

const { runFloorplanInterpretation } = freshRequire("lib/services/floorplan-models.ts")

const PREVIOUS_DRAFT = { previous: true }

/** One project with a published floor plan sheet, plus the same shape in another org. */
function seed() {
  const generation = (org, id) => ({
    id: randomUUID(),
    org_id: org,
    project_id: projectId,
    generation_id: id,
    status: "processing",
    source_selection: [
      { sheetVersionId: sheetId, name: "Ground", order: 0, feetPerImagePx: 0.02, region: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    ],
    model: PREVIOUS_DRAFT,
  })
  const sheetVersion = (org) =>
    withEmbedded(
      {
        id: org === orgId ? sheetId : randomUUID(),
        org_id: org,
        file_id: null,
        page_index: 0,
        image_width: 1000,
        image_height: 1000,
        tiles_base_path: `${org}/sheet`,
        drawing_revision_id: revisionId,
        extracted_metadata: {},
        drawing_sheets: {
          sheet_number: "A1",
          sheet_title: "Floor plan",
          discipline: "Architectural",
          current_revision_id: revisionId,
          project_id: projectId,
        },
      },
      "drawing_sheets",
    )
  return createFakeSupabase({
    floorplan_models: [generation(orgId, generationId), generation(otherOrgId, randomUUID())],
    drawing_revisions: [
      { id: revisionId, org_id: orgId, project_id: projectId, status: "published", published_at: "2026-10-01T00:00:00Z" },
    ],
    drawing_sheet_versions: [sheetVersion(orgId), sheetVersion(otherOrgId)],
    sheet_building_records: [],
  })
}

const currentModel = () => database.client.store.floorplan_models.find((row) => row.org_id === orgId)

test.beforeEach(() => {
  database.client = seed()
  events.length = 0
  storage.objects.clear()
  storage.uploads.length = 0
  storage.objects.set(`${orgId}/sheet/area-evidence.json`, Buffer.from(JSON.stringify(evidence)))
  storage.objects.set(`${orgId}/sheet/text-runs.json`, Buffer.from(encodeTextRuns(textRuns)))
})

test("the generation worker saves the same physical geometry that takeoff measures", async () => {
  await runFloorplanInterpretation({ orgId, target: { kind: "project", projectId }, generationId })

  const saved = currentModel()
  assert.equal(saved.status, "draft")
  assert.equal(saved.drawing_revision_id, revisionId)
  const [level] = saved.model.levels
  assert.equal(level.walls.length, 4)
  assert.equal(level.rooms.length, 1)
  assert.equal(level.rooms[0].areaSqft, 225)
  assert.ok(level.reconstruction)

  const takeoff = await runAreaEngine(
    {
      evidence,
      textRuns,
      segments: [],
      imageWidth: 1000,
      imageHeight: 1000,
      feetPerImagePx: 0.02,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      finishPolicy: "include-fixtures",
    },
    { wholeSheet: true },
  )
  assert.deepEqual(
    level.walls.map((wall) => wall.id),
    takeoff.detection.architecture.building.walls.map((wall) => wall.id),
  )
  assert.equal(level.rooms[0].areaSqft, takeoff.detection.architecture.spaces[0].areaSqft)

  assert.equal(events.length, 1)
  assert.equal(events[0].eventType, "floorplan.interpreted")
  assert.equal(storage.uploads.length, 0, "interpretation never rewrites the sheet's source artifacts")
  assert.equal(vision.calls.length, 0)
  const otherOrg = database.client.store.floorplan_models.find((row) => row.org_id === otherOrgId)
  assert.deepEqual(otherOrg.model, PREVIOUS_DRAFT)
})

test("a superseded generation cannot replace the current draft", async () => {
  currentModel().generation_id = randomUUID()

  await runFloorplanInterpretation({ orgId, target: { kind: "project", projectId }, generationId })

  assert.deepEqual(currentModel().model, PREVIOUS_DRAFT)
  assert.equal(currentModel().status, "processing")
  assert.equal(events.length, 0)
})
