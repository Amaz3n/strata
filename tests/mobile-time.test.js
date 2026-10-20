const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { recordingService } = require("./support/mobile")

// Boundary: Supabase Auth validating the bearer token ("valid-token" is the
// actor's live session) and the clock and timesheet services, which have their
// own suites. The routes, the auth wrapper and the wire mapping are real.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://supabase.test"
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key"
const supabaseJs = require("@supabase/supabase-js")
stubModule("@supabase/supabase-js", {
  ...supabaseJs,
  createClient: () => ({
    auth: {
      async getUser(token) {
        if (token !== "valid-token") return { data: { user: null }, error: { message: "invalid JWT" } }
        return { data: { user: { id: ACTOR, email: "actor@example.test", user_metadata: {} } }, error: null }
      },
    },
  }),
})

const PROJECT = id(1)
const ENTRY = id(2)

const calls = []
const session = {
  id: id(3),
  projectId: PROJECT,
  projectName: "Lot 12",
  costCodeId: null,
  costCodeLabel: null,
  workerUserId: ACTOR,
  workDate: "2026-10-19",
  startedAt: "2026-10-19T12:00:00Z",
  onBreakSince: null,
  breakMinutes: 0,
  source: "mobile",
}
const queueItem = {
  id: ENTRY,
  workerName: "Sam Framer",
  projectId: PROJECT,
  projectName: "Lot 12",
  costCode: "03 · Framing",
  workDate: "2026-10-16",
  hours: 8,
  kind: "regular",
  overtimeSource: null,
  notes: null,
}
let denied = false
let clockInRefusal = null
const { timeBulkRejectSchema } = require("@/lib/validation/time-clock")

const guard = (answer) => (...args) => {
  if (denied) throw Object.assign(new Error("Denied"), { code: "AUTH_FORBIDDEN" })
  return typeof answer === "function" ? answer(...args) : answer
}

stubModule(
  "lib/services/time-clock.ts",
  recordingService(calls, {
    getClockState: guard({ open: session, jobs: [{ id: PROJECT, name: "Lot 12" }], jobsTotal: 1, jobsCap: 50, canClockOthers: false }),
    getClockCostCodes: guard({ required: true, costCodes: [{ id: id(4), label: "03 · Framing" }] }),
    clockIn: guard(() => {
      if (clockInRefusal) throw new Error(clockInRefusal)
      return session
    }),
    switchClock: guard({ closed: {}, session }),
    startBreak: guard(session),
    endBreak: guard(session),
    clockOut: guard({}),
  }),
)
stubModule(
  "lib/services/timesheets.ts",
  recordingService(calls, {
    getMyHours: guard({ current: myPeriod(), previous: myPeriod(), payFrequency: "weekly" }),
    // The service already omits rates; a rate leaking in here would be a service bug the route must not widen.
    getTimesheet: guard({
      period: { startsOn: "2026-10-12", endsOn: "2026-10-18" },
      queue: [queueItem],
      canApprove: true,
      truncated: false,
      grid: [{ workerName: "Sam Framer" }],
    }),
    approveTimeEntries: guard({ done: [ENTRY], failed: [] }),
    // The real validation runs in the service; the route must not swallow its refusal.
    rejectTimeEntries: guard((input) => ({ done: timeBulkRejectSchema.parse(input).ids, failed: [] })),
  }),
)

function myPeriod() {
  return {
    period: { startsOn: "2026-10-12", endsOn: "2026-10-18" },
    days: ["2026-10-12"],
    grid: { hours: 8, regular: 8, overtime: 0, doubleTime: 0 },
    entries: [{ ...queueItem, status: "rejected", rejectionReason: "Wrong job" }],
  }
}

const route = (path) => freshRequire(`app/api/mobile/v1/time/${path}/route.ts`)

function harness() {
  calls.length = 0
  denied = false
  clockInRefusal = null
  return createServiceHarness({
    tables: { orgs: [{ id: ORG, name: "Builder", slug: "builder", status: "active", billing_model: "license", product_tier: "residential" }], subscriptions: [] },
  })
}

const signedIn = { authorization: "Bearer valid-token", "x-arc-organization-id": ORG }
const get = (query = "") => new Request(`https://arc.test/api/mobile/v1/time${query}`, { headers: signedIn })
const post = (body, headers = signedIn) =>
  new Request("https://arc.test/api/mobile/v1/time", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const serviceCall = (name) => calls.find(([called]) => called === name)

describe("the time routes", () => {
  let service
  beforeEach(() => {
    service = harness()
  })

  test("a request without a valid session is refused before any service runs", async () => {
    const cases = [
      [route("clock").GET, new Request("https://arc.test/api/mobile/v1/time/clock")],
      [route("mine").GET, new Request("https://arc.test/api/mobile/v1/time/mine", { headers: { authorization: "Bearer forged", "x-arc-organization-id": ORG } })],
      [route("clock/in").POST, post({ project_id: PROJECT }, {})],
      [route("approvals/approve").POST, post({ ids: [ENTRY] }, {})],
    ]
    for (const [handler, request] of cases) {
      const response = await service.run(() => handler(request))
      assert.equal(response.status, 401)
    }
    assert.deepEqual(calls, [])
  })

  test("clocking in from the phone records the mobile source and maps the session to snake_case", async () => {
    const response = await service.run(() =>
      route("clock/in").POST(post({ project_id: PROJECT, location: { lat: 40.1, lng: -75.2, accuracy_m: 12 } })),
    )

    assert.equal(response.status, 200)
    const [, input, orgId] = serviceCall("clockIn")
    assert.equal(input.source, "mobile")
    assert.equal(input.projectId, PROJECT)
    assert.deepEqual(input.location, { lat: 40.1, lng: -75.2, accuracy_m: 12 })
    assert.equal(orgId, ORG)
    const { data } = await response.json()
    assert.equal(data.session.project_name, "Lot 12")
    assert.equal(data.session.started_at, "2026-10-19T12:00:00Z")
  })

  test("a clock-in without a job is a 400", async () => {
    const response = await service.run(() => route("clock/in").POST(post({})))
    assert.equal(response.status, 400)
    assert.equal(serviceCall("clockIn"), undefined)
  })

  test("a break and a clock-out need no body", async () => {
    for (const path of ["clock/break/start", "clock/break/end", "clock/out"]) {
      const response = await service.run(() => route(path).POST(post(undefined)))
      assert.equal(response.status, 200, path)
    }
  })

  test("the clock state and a job's cost codes come back in the wire format", async () => {
    const state = await (await service.run(() => route("clock").GET(get("/clock")))).json()
    assert.equal(state.data.open.project_id, PROJECT)
    assert.equal(state.data.can_clock_others, false)

    const codes = await (await service.run(() => route("clock/cost-codes").GET(get(`/clock/cost-codes?project_id=${PROJECT}`)))).json()
    assert.equal(codes.data.required, true)
    const missing = await service.run(() => route("clock/cost-codes").GET(get("/clock/cost-codes")))
    assert.equal(missing.status, 400)
  })

  test("sending time back needs a reason", async () => {
    const { POST } = route("approvals/reject")

    for (const body of [{ ids: [ENTRY] }, { ids: [ENTRY], reason: "   " }]) {
      assert.equal((await service.run(() => POST(post(body)))).status, 400, JSON.stringify(body))
    }
    const sent = await service.run(() => POST(post({ ids: [ENTRY], reason: "Wrong job" })))
    assert.equal(sent.status, 200)
    assert.deepEqual((await sent.json()).data.done, [ENTRY])
  })

  test("approving returns which entries were done and which failed", async () => {
    const response = await service.run(() => route("approvals/approve").POST(post({ ids: [ENTRY] })))
    assert.deepEqual((await response.json()).data, { done: [ENTRY], failed: [] })
    assert.deepEqual(serviceCall("approveTimeEntries")[1], { ids: [ENTRY] })
  })

  test("the approval queue carries hours and who, never a rate or the week grid", async () => {
    const response = await service.run(() => route("approvals").GET(get("/approvals?period=previous")))
    const { data } = await response.json()

    assert.equal(serviceCall("getTimesheet")[1].period, "previous")
    assert.deepEqual(data.period, { starts_on: "2026-10-12", ends_on: "2026-10-18" })
    assert.equal(data.can_approve, true)
    assert.equal(data.queue[0].hours, 8)
    assert.equal(data.queue[0].worker_name, "Sam Framer")
    assert.doesNotMatch(JSON.stringify(data), /rate|cents|cost_cents|wage|grid/i)
  })

  test("my hours show the current and previous period, with why an entry came back", async () => {
    const response = await service.run(() => route("mine").GET(get("/mine")))
    const { data } = await response.json()
    assert.equal(data.current.total_hours, 8)
    assert.equal(data.previous.entries[0].rejection_reason, "Wrong job")
    assert.doesNotMatch(JSON.stringify(data), /rate|cents|wage/i)
  })

  test("a permission refusal is a 403, and a rule the person can fix is a 409", async () => {
    denied = true
    assert.equal((await service.run(() => route("clock").GET(get("/clock")))).status, 403)
    denied = false
    clockInRefusal = "Already clocked in. Clock out or switch jobs first."
    const response = await service.run(() => route("clock/in").POST(post({ project_id: PROJECT })))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.message, "Already clocked in. Clock out or switch jobs first.")
  })
})
