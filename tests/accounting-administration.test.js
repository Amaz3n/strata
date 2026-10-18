const test = require("node:test"),
  assert = require("node:assert/strict")
const { fixture } = require("./fixtures/accounting-administration")
const savedFetch = global.fetch
// Every dependency is explicitly stubbed; an accidental network dispatch fails.
test.before(() => {
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
})
test.after(() => {
  global.fetch = savedFetch
})
const calls = [
  [
    "settings",
    (api) =>
      api.updateAccountingConnectionSettings("connection", {
        auto_sync: false,
      }),
  ],
  [
    "label",
    (api) => api.updateAccountingConnectionLabel("connection", "Renamed"),
  ],
  ["refresh", (api) => api.refreshAccountingConnectionToken("connection")],
  ["disconnect", (api) => api.disconnectAccountingConnection("connection")],
  [
    "file create",
    (api) =>
      api.createFileAccountingConnection({
        label: "CSV Book",
        batchFormat: "csv",
      }),
  ],
]
for (const [name, invoke] of calls) {
  test(`${name}: direct service denies missing admin and failed authorization audit before effects`, async () => {
    for (const options of [
      { denied: "org.admin" },
      { permissionError: true },
    ]) {
      const f = fixture(options)
      await assert.rejects(invoke(f.connections), /Missing permission/)
      assert.equal(f.state.writes.length, 0)
      assert.equal(f.state.providerCalls.length, 0)
      assert.equal(f.state.serviceCreated, 0)
    }
  })
  test(`${name}: authorized administration executes once with scoped service writes`, async () => {
    const f = fixture()
    await invoke(f.connections)
    assert.ok(f.state.decisions.includes("org.admin"))
    if (name === "refresh")
      assert.deepEqual(
        f.state.providerCalls.map((x) => x[0]),
        ["refresh", "requeue"],
      )
    else {
      assert.equal(f.state.writes.length, 1)
      assert.equal(f.state.writes[0].role, "service")
      if (name !== "file create")
        assert.deepEqual(f.state.writes[0].filters, [
          ["org_id", "org"],
          ["id", "connection"],
        ])
    }
    if (name === "disconnect")
      assert.equal(
        f.state.providerCalls.filter((x) => x[0] === "disconnect").length,
        1,
      )
  })
  if (name !== "file create")
    test(`${name}: foreign connection is denied before provider or mutation`, async () => {
      const f = fixture({ connection: { org_id: "foreign" } })
      await assert.rejects(invoke(f.connections), /not found/)
      assert.equal(f.state.writes.length, 0)
      assert.equal(f.state.providerCalls.length, 0)
    })
}
test("settings audit persistence failure is surfaced, never reported successful", async () => {
  const f = fixture({ auditError: true })
  await assert.rejects(
    f.connections.updateAccountingConnectionSettings("connection", {}),
    /Audit write unavailable/,
  )
})
const route = (extra = {}) => ({
  connectionId: "connection",
  dimensions: {},
  ...extra,
})
for (const scope of [
  { divisionId: "other-division" },
  { communityId: "other-community" },
  {},
])
  test(`assigned division manager cannot change outside scope ${JSON.stringify(scope)}`, async () => {
    const f = fixture({ assignedOnly: true })
    await assert.rejects(
      f.target.upsertAccountingEntityMap(route(scope)),
      /outside your assigned/,
    )
    assert.equal(f.state.writes.length, 0)
    assert.equal(f.state.providerCalls.length, 0)
  })
for (const scope of [
  { divisionId: "division" },
  { communityId: "community" },
  {},
])
  test(`project assigned manager cannot change broad route ${JSON.stringify(scope)}`, async () => {
    const f = fixture({ projectAssignedOnly: true })
    await assert.rejects(
      f.target.upsertAccountingEntityMap(route(scope)),
      /all projects/,
    )
    assert.equal(f.state.writes.length, 0)
  })
for (const scope of [
  { divisionId: "division" },
  { communityId: "community" },
  { projectId: "project" },
  {},
])
  test(`allowed manager saves scoped mapping once ${JSON.stringify(scope)}`, async () => {
    const f = fixture({
      assignedOnly: !!scope.divisionId || !!scope.communityId,
      projectAssignedOnly: !!scope.projectId,
    })
    await f.target.upsertAccountingEntityMap(route(scope))
    assert.equal(f.state.writes.length, 1)
    assert.equal(f.state.writes[0].payload.org_id, "org")
    assert.equal(f.state.writes[0].role, "service")
    assert.equal(
      f.state.reads.filter((x) => x.table === "projects").length,
      scope.projectId ? 1 : 0,
    )
  })
test("exact project authorization denial prevents route mutation", async () => {
  const f = fixture({ deniedProject: "other-project" })
  await assert.rejects(
    f.target.upsertAccountingEntityMap(route({ projectId: "other-project" })),
    /Project authorization/,
  )
  assert.equal(f.state.writes.length, 0)
})
for (const id of ["missing", "foreign"])
  test(`forged map id ${id} never implicitly creates`, async () => {
    const f = fixture({
      tables: { accounting_entity_map: [{ id: "foreign", org_id: "foreign" }] },
    })
    await assert.rejects(
      f.target.upsertAccountingEntityMap(route({ id, projectId: "project" })),
      /not found/,
    )
    assert.equal(f.state.writes.length, 0)
  })
test("both source and destination project scopes are authorized on update", async () => {
  const current = {
    id: "map",
    org_id: "org",
    connection_id: "connection",
    project_id: "other-project",
    division_id: null,
    community_id: null,
  }
  const f = fixture({
    deniedProject: "other-project",
    tables: { accounting_entity_map: [current] },
  })
  await assert.rejects(
    f.target.upsertAccountingEntityMap(
      route({ id: "map", projectId: "project" }),
    ),
    /Project authorization/,
  )
  assert.equal(f.state.writes.length, 0)
  const allowed = fixture({ tables: { accounting_entity_map: [current] } })
  await allowed.target.upsertAccountingEntityMap(
    route({ id: "map", projectId: "project" }),
  )
  assert.deepEqual(
    allowed.state.decisions
      .filter((x) => typeof x === "object")
      .map((x) => x.projectId),
    ["other-project", "project"],
  )
})
test("assigned division authorization checks original community when moved into allowed division", async () => {
  const f = fixture({
    assignedOnly: true,
    tables: {
      accounting_entity_map: [
        {
          id: "map",
          org_id: "org",
          connection_id: "connection",
          community_id: "other-community",
        },
      ],
    },
  })
  await assert.rejects(
    f.target.upsertAccountingEntityMap(
      route({ id: "map", communityId: "community" }),
    ),
    /outside your assigned/,
  )
  assert.equal(f.state.writes.length, 0)
})
test("foreign company, malformed scopes, unsupported dimensions and failed authorization all fail before writes", async () => {
  for (const [options, input] of [
    [{ connection: { org_id: "foreign" } }, {}],
    [{}, { projectId: "project", divisionId: "division" }],
    [{}, { dimensions: { department: { id: "remote" } } }],
    [{ authorizationError: true }, { projectId: "project" }],
  ]) {
    const f = fixture(options)
    await assert.rejects(f.target.upsertAccountingEntityMap(route(input)))
    assert.equal(f.state.writes.length, 0)
    assert.equal(f.state.providerCalls.length, 0)
  }
})
test("reassignment retains explicit acknowledgement and admin gate for synced identities", async () => {
  const options = {
    synced: 2,
    tables: {
      accounting_entity_map: [
        {
          id: "map",
          org_id: "org",
          connection_id: "old-connection",
          project_id: null,
          division_id: null,
          community_id: null,
        },
      ],
    },
  }
  const unacknowledged = fixture(options)
  await assert.rejects(
    unacknowledged.target.upsertAccountingEntityMap(route({ id: "map" })),
    /acknowledgement/,
  )
  assert.equal(unacknowledged.state.writes.length, 0)
  const denied = fixture({ ...options, denied: "org.admin" })
  await assert.rejects(
    denied.target.upsertAccountingEntityMap(
      route({ id: "map", acknowledgeResync: true }),
    ),
    /Missing permission/,
  )
  assert.equal(denied.state.writes.length, 0)
  const allowed = fixture(options)
  await allowed.target.upsertAccountingEntityMap(
    route({ id: "map", acknowledgeResync: true }),
  )
  assert.equal(allowed.state.writes.length, 1)
  assert.equal(
    allowed.state.writes[0].payload.reassignment_acknowledged_by,
    "user",
  )
})
test("reassignment count RPC errors and invalid scalars fail closed before mutation", async () => {
  for (const failure of [
    { rpcError: true },
    ...[null, -1, "0", 1.5, Number.MAX_SAFE_INTEGER + 1].map((rpcValue) => ({
      rpcValue,
    })),
  ]) {
    const f = fixture({
      ...failure,
      tables: {
        accounting_entity_map: [
          {
            id: "map",
            org_id: "org",
            connection_id: "old",
            division_id: "division",
          },
        ],
      },
    })
    await assert.rejects(
      f.target.upsertAccountingEntityMap(
        route({ id: "map", divisionId: "other-division" }),
      ),
      /Unable to inspect/,
    )
    assert.equal(f.state.rpcCalls.length, 1)
    assert.equal(f.state.rpcCalls[0].input.p_division_id, "division")
    assert.equal(f.state.writes.length, 0)
  }
})

function actions(f) {
  const cookies = []
  const api = f.load("app/(app)/settings/integrations/actions.ts", {
    ...f.stubs,
    "@/lib/integrations/accounting/oauth-state": {
      verifyAccountingOAuthState: () => ({ provider: "qbo" }),
      accountingOAuthCookieName: () => "fixture-cookie",
    },
    "next/headers": {
      cookies: async () => ({ set: (input) => cookies.push(input) }),
    },
    "@/lib/services/stripe-connected-accounts": {},
    "@/lib/services/accounting-batches": {},
    "@/lib/services/accounting-sync": {},
    "@/lib/validation/accounting": {},
    "@/lib/services/accounting-target": f.target,
    "@/lib/services/financial-exports": {},
    "@/lib/action-result": {
      actionError: (error) => ({ success: false, error: error.message }),
    },
  })
  return { api, cookies }
}
test("settings refresh delegates to authorized service once and keeps reconnect replay", async () => {
  const f = fixture(),
    a = actions(f)
  assert.equal(
    (await a.api.refreshAccountingConnectionAction("connection")).success,
    true,
  )
  assert.deepEqual(
    f.state.providerCalls.map((x) => x[0]),
    ["refresh", "requeue"],
  )
  const denied = fixture({ denied: "org.admin" })
  assert.equal(
    (await actions(denied).api.refreshAccountingConnectionAction("connection"))
      .success,
    false,
  )
  assert.equal(denied.state.providerCalls.length, 0)
})
test("OAuth initiation preserves admin, reconnect realm binding and signed attempt cookie", async () => {
  const f = fixture(),
    a = actions(f)
  assert.equal(
    (await a.api.connectAccountingProviderAction("qbo", "connection")).success,
    true,
  )
  assert.equal(f.state.providerCalls[0][1].expectedAccountId, "realm")
  assert.equal(f.state.providerCalls[0][1].connectionId, "connection")
  assert.equal(a.cookies.length, 1)
  assert.equal(a.cookies[0].value, "signed-state")
  assert.equal(a.cookies[0].httpOnly, true)
  const denied = fixture({ denied: "org.admin" })
  assert.equal(
    (await actions(denied).api.connectAccountingProviderAction("qbo")).success,
    false,
  )
  assert.equal(denied.state.providerCalls.length, 0)
})
test("effective platform authority permits broad routes despite raw assigned-division membership", async () => {
  for (const scope of [
    { divisionId: "other-division" },
    { communityId: "other-community" },
    {},
  ]) {
    const f = fixture({
      assignedOnly: true,
      divisionIds: ["division"],
      projectAssignedOnly: true,
      platformAccess: true,
    })
    await f.target.upsertAccountingEntityMap(route(scope))
    assert.equal(f.state.writes.length, 1)
    assert.ok(
      f.state.decisions.some(
        (x) =>
          typeof x === "object" &&
          x.permission === "accounting.entity_map.manage",
      ),
    )
  }
})
