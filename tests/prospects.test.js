"use strict"

/**
 * `lib/services/prospects.ts` — capturing a lead, editing a deal and logging
 * contact with it. Stage is derived from the documents: generic edits may move
 * a lead between new / contacted / qualified / lost, and never manufacture or
 * regress a stage the pricing, review or agreement workflow owns.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  assertManualProspectStatus,
  createProspectInputSchema,
  logProspectContactInputSchema,
} = require("@/lib/validation/prospects")
const { createProspect, logProspectContact, updateProspect } = freshRequire("lib/services/prospects.ts")
const { registerProductionInquiry, searchDirectoryPeople } = freshRequire("lib/services/sales-inquiries.ts")

const DEAL = id(1)
const SEEN = "2026-10-01T12:00:00+00:00"
const EARLIER = "2026-10-01T11:00:00+00:00"
const LATER = "2026-10-01T13:00:00+00:00"

/** Workflow-owned stages: only pricing, review, signing or handoff set them. */
const WORKFLOW_STAGES = ["pricing", "estimate_sent", "changes_requested", "client_approved", "executed", "won"]

function deal(overrides = {}) {
  return {
    id: DEAL,
    org_id: ORG,
    name: "Kitchen remodel",
    status: "contacted",
    owner_user_id: null,
    notes: "Renovate kitchen and adjoining living room",
    budget_range: "100k_250k",
    tags: [],
    updated_at: SEEN,
    ...overrides,
  }
}

function harness({ prospect = deal(), permissions = ["org.member", "sales.manage"] } = {}) {
  const service = createServiceHarness({
    tables: { prospects: [prospect], prospect_contacts: [], app_users: [{ id: ACTOR, email: "pm@example.test" }] },
    permissions,
    // The team roster reports MFA status; nobody here has it on.
    rpc: { get_org_member_mfa_status: () => ({ data: [], error: null }) },
  })
  // The actor is an active team member, so they can own the deals they create.
  service.db.memberships[0].user = { id: ACTOR, email: "pm@example.test" }
  return service
}

const stored = (service) => service.db.prospects.find((row) => row.id === DEAL)

describe("stage rules", () => {
  test("new leads start at new and can never be captured at a workflow or closed stage", () => {
    assert.equal(createProspectInputSchema.parse({ name: "New lead" }).status, "new")
    for (const status of [...WORKFLOW_STAGES, "lost"]) {
      assert.equal(createProspectInputSchema.safeParse({ name: "New lead", status }).success, false, status)
    }
  })

  test("a manual move may only land on new, contacted, qualified or lost", () => {
    for (const status of WORKFLOW_STAGES) {
      assert.throws(() => assertManualProspectStatus(status, "new"), /workflow/, status)
      assert.doesNotThrow(() => assertManualProspectStatus(status, status), status)
    }
    for (const status of ["new", "contacted", "qualified", "lost"]) {
      assert.doesNotThrow(() => assertManualProspectStatus(status, "new"), status)
    }
  })
})

describe("createProspect", () => {
  test("a name is enough to capture a lead, owned by its creator", async () => {
    const service = harness({ prospect: deal({ id: id(50) }) })
    const created = await service.run(() => createProspect({ input: { name: "New inquiry" } }))

    assert.equal(created.status, "new")
    assert.equal(created.owner_user_id, ACTOR)
    assert.deepEqual(service.events.map((event) => event.eventType), ["prospect_created"])
  })

  test("the builder may capture a lead already qualified", async () => {
    const service = harness({ prospect: deal({ id: id(50) }) })
    const created = await service.run(() => createProspect({ input: { name: "Referral", status: "qualified" } }))
    assert.equal(created.status, "qualified")
  })
})

describe("a returning buyer", () => {
  const JANE = id(80)
  const PROSPECT_ROLE = id(81)
  const entry = (n, patch = {}) => ({
    id: id(200 + n), org_id: ORG, kind: "contact", name: `Buyer ${String(n).padStart(2, "0")}`, email: null, phone: null, role_states: [], archived_at: null, ...patch,
  })
  const directory = (extra = {}) => {
    const service = harness({ permissions: ["org.member", "sales.manage", "sales.read"] })
    const type = { id: PROSPECT_ROLE, key: "prospect", label: "Prospect", canonical_category: "client", applies_to: "contact", sort_order: 1 }
    Object.assign(service.db, {
      contacts: [{ id: JANE, org_id: ORG, full_name: "Jane Buyer", email: "Jane.Buyer@Example.com", phone: "555-0100", archived_at: null, created_at: "2026-01-01T00:00:00Z" }],
      directory_relationship_types: [{ ...type, org_id: ORG, is_active: true }],
      party_roles: [{ id: id(82), org_id: ORG, contact_id: JANE, company_id: null, relationship_type_id: PROSPECT_ROLE, status: "active", since: "2026-01-01", until: null, source: "manual", notes: null, relationship_type: type }],
      directory_entries: [],
      ...extra,
    })
    return service
  }
  const inquiry = (patch) => ({ buyerName: "Jane B.", channel: "walk_in", loggedDate: "2026-10-03", ...patch })
  const register = (service, patch) => service.run(() => registerProductionInquiry(inquiry(patch)))

  test("a picked buyer who is archived or belongs to another organization is refused before anything is written", async () => {
    const service = directory()
    service.db.contacts.push({ id: id(83), org_id: id(999), full_name: "Elsewhere", email: null, archived_at: null })
    service.db.contacts.push({ id: id(84), org_id: ORG, full_name: "Gone", email: null, archived_at: "2026-02-01T00:00:00Z" })

    for (const existingContactId of [id(83), id(84)]) {
      await assert.rejects(register(service, { existingContactId }), /no longer in the directory/)
    }
    assert.deepEqual(service.writes(), [])
  })

  test("the buyer search matches name, email or phone within the organization, a page at a time", async () => {
    const service = directory({
      directory_entries: [
        entry(1, { name: "Jane Buyer", email: "jane@example.com", phone: "555-0100", role_states: [{ key: "prospect", label: "Prospect", status: "inquiry" }] }),
        entry(2, { name: "Sam Walker", email: "swalker@example.com", phone: "555-0199" }),
        entry(3, { name: "Jane Elsewhere", org_id: id(999) }),
        entry(4, { name: "Jane Archived", archived_at: "2026-02-01T00:00:00Z" }),
        entry(5, { name: "Jane Plumbing", kind: "company" }),
        ...Array.from({ length: 30 }, (_, index) => entry(10 + index, { name: `Crowd ${String(index).padStart(2, "0")}`, email: `crowd${index}@example.com` })),
      ],
    })
    const names = async (search, page) => (await service.run(() => searchDirectoryPeople({ search, page }))).people.map((person) => person.name)

    assert.deepEqual(await names("jane"), ["Jane Buyer"])
    assert.deepEqual(await names("swalker@"), ["Sam Walker"])
    assert.deepEqual(await names("555-01"), ["Jane Buyer", "Sam Walker"])
    const everyone = await service.run(() => searchDirectoryPeople({ search: "" }))
    const rest = await service.run(() => searchDirectoryPeople({ search: "", page: 2 }))
    assert.deepEqual([everyone.people.length, everyone.total, rest.people.length], [25, 32, 7])
    assert.deepEqual((await service.run(() => searchDirectoryPeople({ search: "jane" }))).people[0].roles, ["Prospect"])
  })
})

describe("updateProspect", () => {
  const update = (service, input) => service.run(() => updateProspect({ prospectId: DEAL, input }))

  test("qualifying is the builder's judgment; it needs no completed intake", async () => {
    const service = harness({ prospect: deal({ notes: null, budget_range: "undecided" }) })
    await update(service, { status: "qualified" })

    assert.equal(stored(service).status, "qualified")
    assert.deepEqual(service.events.map((event) => event.payload), [{ from: "contacted", to: "qualified" }])
  })

  test("a generic edit cannot move a deal onto or off a workflow stage", async () => {
    const early = harness()
    await assert.rejects(update(early, { status: "executed" }), /workflow/)
    assert.deepEqual(early.writes(), [])

    const executed = harness({ prospect: deal({ status: "executed" }) })
    await assert.rejects(update(executed, { status: "qualified" }), /document workflow/)
    assert.deepEqual(executed.writes(), [])
  })

  test("ordinary edits on a workflow-stage deal keep its stage", async () => {
    const service = harness({ prospect: deal({ status: "executed", notes: null }) })
    await update(service, { status: "executed", name: "Updated project name" })
    assert.equal(stored(service).status, "executed")
    assert.equal(stored(service).name, "Updated project name")
  })

  test("an editor holding a stale revision cannot overwrite the deal", async () => {
    const service = harness({ prospect: deal({ notes: "Latest scope" }) })
    await assert.rejects(
      update(service, { notes: "Old scope", expected_updated_at: EARLIER }),
      /changed while you were editing/,
    )
    assert.equal(stored(service).notes, "Latest scope")
    assert.deepEqual(service.writes(), [])
  })

  test("a change landing between the read and the write is caught at the write", async () => {
    const service = harness()
    // Someone else saves right after this edit read the deal.
    service.tamper(
      "prospects",
      (result) => {
        Object.assign(stored(service), { notes: "Their scope", updated_at: LATER })
        return result
      },
      { on: "select", times: 1 },
    )
    await assert.rejects(
      update(service, { budget_range: "250k_500k", expected_updated_at: SEEN }),
      /changed while you were editing/,
    )
    assert.equal(stored(service).notes, "Their scope")
    assert.equal(stored(service).budget_range, "100k_250k")
  })

  test("an actor without org membership cannot edit a deal", async () => {
    const service = harness({ permissions: [] })
    await assert.rejects(update(service, { status: "qualified" }))
    assert.deepEqual(service.writes(), [])
  })
})

describe("logProspectContact", () => {
  const log = (service, input) => service.run(() => logProspectContact({ prospectId: DEAL, input }))
  const eventTypes = (service) => service.events.map((event) => event.eventType)

  test("talking to a new inquiry moves it to contacted; an internal note does not", async () => {
    const noted = harness({ prospect: deal({ status: "new" }) })
    await log(noted, { kind: "note", note: "Internal planning" })
    assert.equal(stored(noted).status, "new")
    assert.deepEqual(eventTypes(noted), ["prospect_contact_logged"])

    const called = harness({ prospect: deal({ status: "new" }) })
    await log(called, { kind: "call" })
    assert.equal(stored(called).status, "contacted")
    assert.deepEqual(eventTypes(called), ["prospect_contact_logged", "prospect_status_changed"])
  })

  test("contact on an issued deal never regresses its stage", async () => {
    const service = harness({ prospect: deal({ status: "estimate_sent" }) })
    await log(service, { kind: "email" })
    assert.equal(stored(service).status, "estimate_sent")
    assert.deepEqual(eventTypes(service), ["prospect_contact_logged"])
  })

  test("a failed write or a concurrent stage change records no activity", async () => {
    const failed = harness({ prospect: deal({ status: "new" }) })
    failed.tamper("prospects", replies.error("Write failed"), { on: "update" })
    await assert.rejects(log(failed, { kind: "call" }), /Write failed/)
    assert.deepEqual(failed.events, [])

    const raced = harness({ prospect: deal({ status: "new" }) })
    // The stage moves right after the log reads it: the access check reads the
    // deal first, the log itself second.
    let reads = 0
    raced.tamper(
      "prospects",
      (result) => {
        reads += 1
        if (reads === 2) stored(raced).status = "qualified"
        return result
      },
      { on: "select" },
    )
    await assert.rejects(log(raced, { kind: "call" }), /deal changed/)
    assert.equal(stored(raced).status, "qualified")
    assert.deepEqual(raced.events, [])
  })

  test("a logged contact needs a known kind, a note for notes, and bounded text", () => {
    for (const input of [{ kind: "note", note: " " }, { kind: "unsupported" }, { kind: "call", note: "a".repeat(2001) }]) {
      assert.equal(logProspectContactInputSchema.safeParse(input).success, false, JSON.stringify(input).slice(0, 40))
    }
    assert.equal(logProspectContactInputSchema.safeParse({ kind: "call" }).success, true)
  })
})
