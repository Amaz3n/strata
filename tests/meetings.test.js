const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getMeeting, listMeetings, updateMeeting } = freshRequire("lib/services/meetings.ts")

const OWN_DIVISION = id(10)
const OTHER_DIVISION = id(11)
const OWN_PROJECT = id(20)
const OTHER_PROJECT = id(21)
const NOW = "2026-10-06T12:00:00+00:00"

const meeting = (n, projectId) => ({
  id: id(30 + n),
  org_id: ORG,
  project_id: projectId,
  meeting_number: n,
  series: "oac",
  title: `OAC ${n}`,
  held_at: null,
  location: null,
  status: "draft",
  finalized_at: null,
  pdf_file_id: null,
  minutes_distributed_at: null,
  minutes_distributed_by: null,
  metadata: {},
  created_at: NOW,
  updated_at: NOW,
})

function divisionLimitedReader(permissions = ["project.read", "meeting.write"]) {
  return createServiceHarness({
    tables: {
      orgs: [{ id: ORG, document_numbering: {} }],
      projects: [
        { id: OWN_PROJECT, org_id: ORG, division_id: OWN_DIVISION },
        { id: OTHER_PROJECT, org_id: ORG, division_id: OTHER_DIVISION },
      ],
      meetings: [meeting(1, OWN_PROJECT), meeting(2, OTHER_PROJECT)],
      meeting_items: [],
      meeting_attendees: [],
      meeting_distribution_recipients: [],
    },
    permissions,
    divisions: [OWN_DIVISION],
  })
}

test("a division-limited member opens meetings in their division and no other", async () => {
  const service = divisionLimitedReader()

  const own = await service.run(() => getMeeting(id(31)))
  assert.equal(own.title, "OAC 1")

  await assert.rejects(service.run(() => getMeeting(id(32))), /Missing permission/)
  assert.deepEqual(service.reads("meeting_items").length, 1, "the other division's items are never read")

  await assert.rejects(service.run(() => listMeetings(OTHER_PROJECT)), /Missing permission/)
})

test("a division-limited member cannot edit a meeting in another division", async () => {
  const service = divisionLimitedReader()

  await assert.rejects(service.run(() => updateMeeting(id(32), { title: "Renamed" })), /Missing permission/)
  assert.deepEqual(service.writes(), [])
})
