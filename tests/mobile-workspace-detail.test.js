const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService, status } = require("./support/mobile")

const PROJECT = id(1)
const RECORD = id(2)
const CHILD = id(3)
const OTHER_CHILD = id(4)

// The domain services each workspace module reads and hands its actions to
// (their own suites). `world` holds the record each one answers with.
const world = { calls: [], status: "in_progress", responded: false }
const calls = (name) => world.calls.filter(([called]) => called === name).map(([, ...args]) => args)

stubModule(
  "lib/services/inspections.ts",
  recordingService(world.calls, {
    listInspections: () => [{ id: RECORD, status: world.status }],
    getInspection: () => ({
      id: RECORD,
      status: world.status,
      items: [{ id: CHILD, prompt: "Roof flashing", response_type: "pass_fail", response: null, note: null, is_deficient: false }],
    }),
    updateInspectionItem: null,
  }),
)
stubModule("lib/services/vendor-bills.ts", recordingService(world.calls, { listVendorBillsForProject: () => [{ id: RECORD }] }))
stubModule(
  "lib/mobile/payables.ts",
  recordingService(world.calls, {
    getMobilePayable: () => ({
      coding: { lines: [], uncoded_cents: 0 },
      holds: { reasons: [] },
      evidence: {},
      can_approve: true,
      updated_at: "revision-new",
      status: "pending",
    }),
    decideMobilePayable: null,
  }),
)
stubModule(
  "app/(app)/signatures/actions.ts",
  recordingService(world.calls, {
    listSignaturesHubAction: () => ({
      rows: [
        {
          envelope_id: RECORD,
          envelope_status: "sent",
          project_id: PROJECT,
          document_title: "Agreement",
          source_file_id: null,
          recipient_statuses: [
            { id: CHILD, email: "signer@example.com", can_remind: true },
            { id: OTHER_CHILD, email: "done@example.com", can_remind: false },
          ],
          activity: [],
          can_download: false,
          can_void: false,
        },
      ],
    }),
    sendDocumentSigningReminderAction: () => ({ success: true, data: {} }),
  }),
)
stubModule(
  "lib/services/warranty.ts",
  recordingService(world.calls, {
    listWarrantyRequests: () => [
      { id: RECORD, project_id: PROJECT, title: "Door", status: "open", first_responded_at: world.responded ? "2026-10-01" : null },
    ],
    listWarrantyVisitsForProject: () => [],
    acknowledgeWarrantyRequest: null,
  }),
)
stubModule(
  "lib/services/submittals.ts",
  recordingService(world.calls, {
    listSubmittals: () => [{ id: RECORD, status: world.status }],
    listSubmittalItems: () => [],
    listSubmittalReviewSteps: () => [{ id: CHILD, role_label: "Architect", status: "in_review" }],
    decideSubmittalReviewStep: null,
  }),
)
stubModule(
  "lib/services/meetings.ts",
  recordingService(world.calls, {
    listMeetings: () => [{ id: RECORD, status: world.status }],
    getMeeting: () => ({
      id: RECORD,
      status: world.status,
      pdf_file_id: null,
      items: [],
      attendees: [{ id: CHILD, display_name: "Alex", present: true }],
    }),
    updateMeetingAttendee: null,
    distributeMeetingMinutes: null,
  }),
)

const { performWorkspaceAction } = freshRequire("lib/mobile/workspace-detail.ts")

const EVERYONE = [
  "project.read",
  "project.manage",
  "org.member",
  "bill.read",
  "inspection.write",
  "meeting.write",
  "submittal.read",
  "submittal.route",
  "warranty.read",
  "warranty.write",
]

function harness(permissions = EVERYONE) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [
        {
          id: PROJECT,
          org_id: ORG,
          name: "Tower",
          phase: "delivery",
          property_type: "commercial",
          status: "active",
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
      feature_flags: [{ org_id: ORG, flag_key: "unified_esign", enabled: true, expires_at: null }],
    },
  })
  const context = mobileContext(service)
  service.act = (moduleId, actionId, values = {}, revision) =>
    service.run(() => performWorkspaceAction(context, moduleId, PROJECT, RECORD, actionId, values, revision))
  return service
}

/** Every attempt in `attempts` is refused with `code` and reaches no service write. */
async function refused(code, attempts, writes) {
  for (const attempt of attempts) {
    await assert.rejects(attempt(), status(code))
  }
  for (const name of writes) assert.deepEqual(calls(name), [], name)
}

beforeEach(() => {
  world.calls.length = 0
  world.status = "in_progress"
  world.responded = false
})

describe("inspections", () => {
  test("an answer reaches only this inspection's item, and the service derives deficiency", async () => {
    const service = harness()

    await refused(403, [() => service.act("inspections", `inspection-item:${OTHER_CHILD}`, { response: "fail" })], ["updateInspectionItem"])
    await service.act("inspections", `inspection-item:${CHILD}`, { response: "fail", note: "Missing flashing" })

    assert.deepEqual(calls("updateInspectionItem"), [[CHILD, { response: "fail", note: "Missing flashing" }, ORG]])
  })

  test("a completed inspection, or a reader without inspection.write, cannot change answers", async () => {
    world.status = "completed"
    const completed = harness()
    const reader = harness(EVERYONE.filter((key) => key !== "inspection.write"))
    const answer = (service) => () => service.act("inspections", `inspection-item:${CHILD}`, { response: "pass" })

    await refused(403, [answer(completed)], ["updateInspectionItem"])
    world.status = "in_progress"
    await refused(403, [answer(reader)], ["updateInspectionItem"])
  })
})

test("a bill decision must carry the revision the approver reviewed", async () => {
  const service = harness()

  await refused(409, [() => service.act("payables", "approve-bill", {}, "revision-old")], ["decideMobilePayable"])
  await service.act("payables", "approve-bill", {}, "revision-new")

  const [[, billId, decision]] = calls("decideMobilePayable")
  assert.equal(billId, RECORD)
  assert.deepEqual(decision, { decision: "approved", expected_updated_at: "revision-new", reason: undefined })
})

test("signature reminders go only to remindable recipients of this envelope", async () => {
  const service = harness()

  await refused(
    403,
    [
      () => service.act("signatures", `signature-reminder:${OTHER_CHILD}`),
      () => service.act("signatures", "signature-reminder:another-envelope-recipient"),
    ],
    ["sendDocumentSigningReminderAction"],
  )
  await service.act("signatures", `signature-reminder:${CHILD}`)

  assert.deepEqual(calls("sendDocumentSigningReminderAction"), [[CHILD]])
})

test("a warranty first response uses the canonical channels and is recorded once", async () => {
  const service = harness()

  await service.act("warranty", "acknowledge-warranty", { channel: "text", note: "Confirmed appointment" })
  await refused(422, [() => service.act("warranty", "acknowledge-warranty", { channel: "sms" })], [])
  world.responded = true
  await refused(403, [() => service.act("warranty", "acknowledge-warranty", { channel: "phone" })], [])

  assert.deepEqual(calls("acknowledgeWarrantyRequest"), [[{ request_id: RECORD, channel: "text", note: "Confirmed appointment" }, ORG]])
})

describe("submittal review routing", () => {
  beforeEach(() => {
    world.status = "in_review"
  })

  test("a routed decision targets a live step of this submittal", async () => {
    const service = harness()

    await refused(403, [() => service.act("submittals", `review-step:${OTHER_CHILD}`, { decision: "approved" })], ["decideSubmittalReviewStep"])
    await service.act("submittals", `review-step:${CHILD}`, { decision: "approved_as_noted", notes: "Use updated spec" })

    const [[{ input }]] = calls("decideSubmittalReviewStep")
    assert.equal(input.step_id, CHILD)
    assert.equal(input.decision, "approved_as_noted")
  })

  test("without route permission, or once decided, no step can be reviewed", async () => {
    const decide = (service) => () => service.act("submittals", `review-step:${CHILD}`, { decision: "approved" })
    await refused(403, [decide(harness(EVERYONE.filter((key) => key !== "submittal.route")))], ["decideSubmittalReviewStep"])
    world.status = "approved"
    await refused(403, [decide(harness())], ["decideSubmittalReviewStep"])
  })
})

describe("meetings", () => {
  test("attendance changes only this meeting's attendees, and never finalized minutes", async () => {
    world.status = "draft"
    const service = harness()

    await refused(403, [() => service.act("meetings", `attendance:${OTHER_CHILD}`, { present: "false" })], ["updateMeetingAttendee"])
    await service.act("meetings", `attendance:${CHILD}`, { present: "false" })
    assert.deepEqual(calls("updateMeetingAttendee"), [[CHILD, { present: false }, ORG]])

    world.status = "finalized"
    await refused(403, [() => service.act("meetings", `attendance:${CHILD}`, { present: "true" })], [])
  })

  test("minutes go only to valid, explicitly listed addresses", async () => {
    world.status = "finalized"
    const service = harness()

    await assert.rejects(service.act("meetings", "distribute-minutes", { recipients: "not an email" }))
    assert.deepEqual(calls("distributeMeetingMinutes"), [])
    await service.act("meetings", "distribute-minutes", { recipients: "alex@example.com;pat@example.com" })

    const [[{ recipients }]] = calls("distributeMeetingMinutes")
    assert.deepEqual(recipients, [{ email: "alex@example.com" }, { email: "pat@example.com" }])
  })
})
