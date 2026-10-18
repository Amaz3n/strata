const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module"),
  ts = require("typescript")
function load(relativePath, stubs) {
  const filename = path.resolve(__dirname, "../..", relativePath),
    mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (name === "crypto") return require("node:crypto")
    throw new Error(`Unstubbed administration dependency: ${name}`)
  }
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  )
  return mod.exports
}
function fixture(options = {}) {
  const state = {
    writes: [],
    providerCalls: [],
    decisions: [],
    audits: [],
    events: [],
    reads: [],
    serviceCreated: 0,
    rpcCalls: [],
    ...options,
  }
  const connection = {
    id: "connection",
    org_id: "org",
    provider: "qbo",
    label: "Book",
    external_account_id: "realm",
    status: "active",
    settings: {},
    ...options.connection,
  }
  const tables = {
    accounting_connections: [connection],
    accounting_entity_map: [],
    divisions: [
      { id: "division", org_id: "org" },
      { id: "other-division", org_id: "org" },
    ],
    communities: [
      { id: "community", org_id: "org", division_id: "division" },
      { id: "other-community", org_id: "org", division_id: "other-division" },
    ],
    projects: [
      { id: "project", org_id: "org" },
      { id: "other-project", org_id: "org" },
    ],
    ...options.tables,
  }
  function client(role) {
    return {
      async rpc(name, input) {
        if (role !== "service" || name !== "accounting_count_synced_scope")
          throw new Error("Unexpected RPC")
        state.rpcCalls.push({ name, input })
        return {
          data:
            state.rpcValue !== undefined ? state.rpcValue : (state.synced ?? 0),
          error: state.rpcError ? { message: "Fixture RPC failed" } : null,
        }
      },
      from(table) {
        const filters = [],
          q = { op: "read", payload: null, singleRow: false }
        const builder = {
          select() {
            return this
          },
          eq(k, v) {
            filters.push([k, v])
            return this
          },
          in() {
            return this
          },
          not() {
            return this
          },
          neq() {
            return this
          },
          is() {
            return this
          },
          order() {
            return this
          },
          maybeSingle() {
            q.singleRow = true
            return this
          },
          single() {
            q.singleRow = true
            return this
          },
          update(payload) {
            q.op = "update"
            q.payload = payload
            return this
          },
          insert(payload) {
            q.op = "insert"
            q.payload = payload
            return this
          },
          then(resolve, reject) {
            try {
              if (q.op !== "read" && role !== "service")
                throw new Error("Application mutation forbidden in fixture")
              let rows = (tables[table] ?? []).filter((row) =>
                filters.every(([k, v]) => row[k] === v),
              )
              if (q.op === "read") state.reads.push({ table, filters, role })
              else {
                state.writes.push({
                  table,
                  op: q.op,
                  payload: q.payload,
                  filters,
                  role,
                })
                if (q.op === "insert") {
                  rows = [{ id: "new-id", ...q.payload }]
                  tables[table] ??= []
                  tables[table].push(rows[0])
                } else rows.forEach((row) => Object.assign(row, q.payload))
              }
              return Promise.resolve({
                data: q.singleRow ? (rows[0] ?? null) : rows,
                error:
                  state.readError || state.failedTable === table
                    ? { message: "Fixture database failed" }
                    : null,
                count:
                  table === "accounting_sync_records"
                    ? (state.synced ?? 0)
                    : rows.length,
              }).then(resolve, reject)
            } catch (error) {
              return Promise.reject(error).then(resolve, reject)
            }
          },
        }
        return builder
      },
    }
  }
  const app = client("authenticated"),
    service = client("service"),
    context = { supabase: app, orgId: "org", userId: "user" }
  const provider = {
    capabilities: { dimensions: ["class"] },
    validateSettings: (x) => x,
    async refreshConnection(key) {
      state.providerCalls.push(["refresh", key])
      return { ok: true }
    },
    async disconnect(input) {
      state.providerCalls.push(["disconnect", input])
    },
    async getConnectUrl(input) {
      state.providerCalls.push(["connect", input])
      return { url: "https://fixture.invalid/auth", state: "signed-state" }
    },
  }
  const stubs = {
    "@/lib/supabase/server": {
      createServiceSupabaseClient: () => {
        state.serviceCreated++
        return service
      },
    },
    "@/lib/services/context": {
      requireOrgContext: async (orgId) => {
        if (orgId && orgId !== "org") throw new Error("Foreign organization")
        return context
      },
    },
    "@/lib/services/permissions": {
      requirePermission: async (key) => {
        state.decisions.push(key)
        if (state.permissionError || state.denied === key)
          throw new Error(
            "Missing permission or authorization audit unavailable",
          )
      },
    },
    "@/lib/services/authorization": {
      getProjectReadScopeForUser: async () => ({
        projectMembershipRequired: state.platformAccess
          ? false
          : (state.projectAssignedOnly ?? false),
        divisionIds:
          state.platformAccess || !state.assignedOnly
            ? null
            : (state.divisionIds ?? ["division"]),
      }),
      requireAuthorization: async (input) => {
        state.decisions.push(input)
        if (
          state.authorizationError ||
          (state.deniedProject && input.projectId === state.deniedProject)
        )
          throw new Error("Project authorization denied")
      },
    },
    "@/lib/integrations/accounting/registry": {
      getProvider: () => provider,
      isAccountingProviderKey: (key) => ["qbo", "file"].includes(key),
      listProviders: () => [],
    },
    "@/lib/integrations/accounting/settings": {
      accountingCommonSettingsUpdateSchema: { parse: (x) => x },
    },
    "@/lib/services/audit": {
      recordAudit: async (input) => {
        state.audits.push(input)
        if (state.auditError) throw new Error("Audit write unavailable")
      },
    },
    "@/lib/services/events": {
      recordEvent: async (input) => state.events.push(input),
    },
    "@/lib/services/accounting-logger": { logAccounting: () => {} },
    "@/lib/services/accounting-job-types": { ACCOUNTING_JOB_TYPES: [] },
    "@/lib/services/accounting-enqueue": {
      requeueAccountingSyncAfterReconnect: async () => {
        state.providerCalls.push(["requeue"])
        return { queued: 1 }
      },
    },
    "@/lib/integrations/accounting/file/formats": {
      BATCH_FORMATS: { csv: { label: "CSV" } },
      isAccountingBatchFormat: (x) => x === "csv",
    },
    "@/lib/services/accounting-delivery": {
      accountingDeliveryDeadline: () => Infinity,
      withAccountingDeadline: (_deadline, fn) => fn(),
    },
    "@/lib/services/accounting-rules": { selectAccountingMap: () => null },
  }
  const connections = load("lib/services/accounting-connections.ts", stubs)
  stubs["@/lib/services/accounting-connections"] = connections
  const target = load("lib/services/accounting-target.ts", stubs)
  return { state, tables, connections, target, context, provider, stubs, load }
}
module.exports = { fixture, load }
