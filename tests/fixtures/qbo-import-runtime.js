const { load } = require("./qbo-cdc-runtime")

function importRuntime(f, client, options = {}) {
  const calls = [],
    permissions = [],
    events = []
  const identifier = (value) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error(`Invalid fixture identifier ${value}`)
    return `"${value}"`
  }
  const column = (value) => {
    const [field, json] = value.split("->>")
    return identifier(field) + (json ? `->>'${json.replace(/'/g, "")}'` : "")
  }
  function database(role) {
    return {
      from(table) {
        const filters = [],
          values = [],
          order = []
        let columns = "*",
          maximum,
          offset = 0,
          single = false,
          mutation
        const q = {
          select(text = "*") {
            columns = text
            return q
          },
          eq(key, value) {
            values.push(value)
            filters.push(`${column(key)}=$${values.length}`)
            return q
          },
          in(key, value) {
            values.push(value)
            filters.push(`${column(key)}=any($${values.length})`)
            return q
          },
          not(key, operator, value) {
            if (operator !== "is" || value !== null) throw new Error("Unstubbed operator")
            filters.push(`${column(key)} is not null`)
            return q
          },
          order(key) {
            order.push(column(key))
            return q
          },
          range(from, to) {
            offset = from
            maximum = to - from + 1
            return q
          },
          limit(n) {
            maximum = n
            return q
          },
          maybeSingle() {
            single = true
            return q
          },
          single() {
            single = true
            return q
          },
          insert(value) {
            mutation = { kind: "insert", value }
            return q
          },
          upsert(value) {
            mutation = { kind: "insert", value }
            return q
          },
          update(value) {
            mutation = { kind: "update", value }
            return q
          },
          delete() {
            mutation = { kind: "delete" }
            return q
          },
          then(resolve, reject) {
            const run = async () => {
              calls.push({ role, table, columns, mutation: mutation?.kind })
              if (options.queryError?.(table))
                return {
                  data: null,
                  error: { message: "synthetic lookup failure" },
                }
              try {
                const data = await f.role(role, async () => {
                  const where = filters.length ? ` where ${filters.join(" and ")}` : ""
                  let sql
                  if (mutation?.kind === "insert") {
                    const keys = Object.keys(mutation.value)
                    sql = `insert into ${identifier(table)}(${keys.map(identifier)}) values(${keys.map((key) => {
                      values.push(mutation.value[key])
                      return `$${values.length}`
                    })}) returning *`
                  } else if (mutation?.kind === "update") {
                    const assignments = Object.entries(mutation.value).map(([key, value]) => {
                      values.push(value)
                      return `${identifier(key)}=$${values.length}`
                    })
                    sql = `update ${identifier(table)} set ${assignments}${where} returning *`
                  } else if (mutation?.kind === "delete") sql = `delete from ${identifier(table)}${where} returning *`
                  else
                    sql = `select ${columns === "*" ? "*" : columns.split(",").map((value) => column(value.trim()))} from ${identifier(table)}${where}${order.length ? ` order by ${order}` : ""}${maximum ? ` limit ${maximum}` : ""}${offset ? ` offset ${offset}` : ""}`
                  return JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows))
                })
                return { data: single ? (data[0] ?? null) : data, error: null }
              } catch (error) {
                return { data: null, error: { message: error.message } }
              }
            }
            return run().then(resolve, reject)
          },
        }
        return q
      },
      async rpc(name, args) {
        calls.push({ role, rpc: name, args })
        try {
          await options.beforeRpc?.(name, args)
          const data = await f.role(role, async () => {
            const entries = Object.entries(args)
            const parameters = entries.map(([key], index) => `${identifier(key)} => $${index + 1}`)
            return (
              await f.db.query(
                `select ${identifier(name)}(${parameters}) result`,
                entries.map(([, value]) => (value && typeof value === "object" ? JSON.stringify(value) : value)),
              )
            ).rows[0].result
          })
          return { data, error: null }
        } catch (error) {
          return { data: null, error: { message: error.message } }
        }
      },
    }
  }
  const user = database("authenticated"),
    service = database("service_role")
  const ctx = { supabase: user, orgId: f.org, userId: f.id(10) }
  const authorize = async (input) => {
    permissions.push(input)
    if (options.deny?.(input.permission, input.projectId)) throw new Error("Permission denied")
  }
  const connection = async (connectionId, orgId) => {
    if (connectionId !== f.connection || orgId !== f.org || options.inactive) throw new Error("Connection scope denied")
    return {
      id: f.connection,
      org_id: f.org,
      provider: "qbo",
      status: "active",
      external_account_id: "realm",
    }
  }
  const stubs = {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => service },
    "@/lib/services/context": {
      requireOrgContext: async (org) => {
        if (org && org !== f.org) throw new Error("Organization denied")
        return ctx
      },
    },
    "@/lib/services/permissions": {
      requirePermission: async (permission) => authorize({ permission }),
    },
    "@/lib/services/authorization": {
      requireAuthorization: authorize,
      getProjectReadScopeForUser: async () => ({
        projectMembershipRequired: false,
        divisionIds: null,
      }),
    },
    "@/lib/services/accounting-connections": {
      requireAccountingConnectionForOrg: connection,
    },
    "@/lib/services/accounting-delivery": {
      withAccountingDeliveryGroup: async (_keys, _deadline, work) => work(),
    },
    "@/lib/services/accounting-target": {
      upsertAccountingEntityMap: async (input) => {
        calls.push({ routing: input })
        return options.upsertMap?.(input)
      },
    },
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: { forConnection: async () => client },
    },
    "@/lib/services/accounting-coding": { buildAccountingCoding: () => ({}) },
    "@/lib/financials/cost-codes-enabled": {
      getOrgCostCodesEnabled: async () => false,
      resolveCostCodesEnabled: () => false,
    },
    "@/lib/financials/ledger-status": {
      isPayableVendorBillStatus: (status) => ["approved", "paid", "partial"].includes(status),
    },
    "@/lib/services/events": {
      recordEvent: async (event) => events.push(event),
    },
    "@/lib/services/audit": {
      recordAudit: async (event) => events.push(event),
    },
    "@/lib/services/invoice-balance": {
      recalcInvoiceBalanceAndStatus: async () => {},
    },
    "@/lib/services/accounting-logger": { logQBO: () => {} },
    "@/lib/services/books/coding-rules": {
      suggestCodingForService: async () => null,
    },
    "@/lib/services/job-cost-actuals": {
      postJobCostActualsForVendorBill: async () => {},
      postJobCostEntriesForProjectExpense: async () => {},
    },
    "@/lib/services/accounting-invoice-line-links": {
      persistAccountingInvoiceLineLinks: async () => {},
    },
  }
  if (options.realRouting) {
    const target = load("lib/services/accounting-target.ts", {
      ...stubs,
      "@/lib/services/accounting-rules": {},
      "@/lib/integrations/accounting/registry": {
        getProvider: () => ({
          capabilities: {
            dimensions: ["customer", "class", "location", "item"],
          },
        }),
      },
    })
    stubs["@/lib/services/accounting-target"] = target
  }
  const api = load(
    "lib/integrations/accounting/qbo/import.ts",
    stubs,
    options.source
      ? "\nexport const completionTest = {linkSyncRecord,markEventsResolved};"
      : "\nexport const completionTest = {linkSyncRecord,markEventsResolved,preflightImportRouting};",
    options.source,
  )
  const provider = {
    capabilities: { supportsImport: true },
    previewImport: async () => ({}),
    applyImport: (input) =>
      api.importQboRecords({
        ...input,
        items: input.items.map((item) => ({ ...item, qboId: item.externalId })),
      }),
  }
  const serviceApi = load("lib/services/accounting-import.ts", {
    ...stubs,
    "@/lib/integrations/accounting/registry": { getProvider: () => provider },
  })
  return {
    api,
    serviceApi,
    user,
    service,
    calls,
    permissions,
    events,
    ctx,
    stubs,
  }
}
module.exports = { importRuntime }
