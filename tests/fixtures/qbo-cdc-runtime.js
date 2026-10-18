const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
function load(relative, stubs = {}, extra = "", source) {
  const filename = path.resolve(relative)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (["crypto", "zod", "node:async_hooks", "next/server"].includes(name)) return require(name)
    if (name === "server-only") return {}
    if (name === "@/lib/supabase/worker-request-context") return load("lib/supabase/worker-request-context.ts", stubs)
    const real = ["cdc", "cdc-recovery", "webhook", "import-rules", "error-rules", "query", "account-utils"]
    if (real.some((file) => name === `@/lib/integrations/accounting/qbo/${file}`)) return load(`${name.slice(2)}.ts`, stubs)
    throw new Error(`Unstubbed dependency: ${name}`)
  }
  mod._compile(
    ts.transpileModule((source ?? fs.readFileSync(filename, "utf8")) + extra, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  )
  return mod.exports
}
function runtime(f, client, options = {}) {
  const calls = [],
    logs = []
  function query(table) {
    if (!["accounting_connections", "accounting_sync_records", "qbo_cdc_candidates", "qbo_webhook_events"].includes(table))
      throw new Error(`Unstubbed table ${table}`)
    const filters = [],
      values = [],
      orders = []
    let columns = "*",
      maximum,
      single = false
    const identifier = (text) => {
      assertIdentifier(text)
      return `"${text}"`
    }
    const q = {
      select(value) {
        columns = value
        return q
      },
      eq(key, value) {
        values.push(value)
        filters.push(`${identifier(key)}=$${values.length}`)
        return q
      },
      neq(key, value) {
        values.push(value)
        filters.push(`${identifier(key)}<>$${values.length}`)
        return q
      },
      gt(key, value) {
        values.push(value)
        filters.push(`${identifier(key)}>$${values.length}`)
        return q
      },
      in(key, value) {
        values.push(value)
        filters.push(`${identifier(key)}=any($${values.length})`)
        return q
      },
      order(key) {
        orders.push(identifier(key))
        return q
      },
      limit(value) {
        maximum = value
        return q
      },
      maybeSingle() {
        single = true
        return q
      },
      then(resolve, reject) {
        calls.push({ table, columns, values: [...values], maximum })
        const work = async () => {
          const failure = options.failure?.({ table, columns })
          if (failure) return { data: null, error: { message: failure } }
          const projected =
            columns === "*"
              ? "*"
              : columns
                  .split(",")
                  .map((column) => identifier(column.trim()))
                  .join(",")
          const result = await f.db.query(
            `select ${projected} from ${identifier(table)}${filters.length ? ` where ${filters.join(" and ")}` : ""}${orders.length ? ` order by ${orders.join(",")}` : ""}${maximum ? ` limit ${maximum}` : ""}`,
            values,
          )
          return {
            data: single ? (JSON.parse(JSON.stringify(result.rows))[0] ?? null) : JSON.parse(JSON.stringify(result.rows)),
            error: null,
          }
        }
        return work().then(resolve, reject)
      },
    }
    return q
  }
  const db = {
    from: query,
    async rpc(name, args) {
      calls.push({ rpc: name, args })
      const failure = options.failure?.({ rpc: name, args })
      if (failure) return { data: null, error: { message: failure } }
      try {
        let data
        if (name === "claim_qbo_cdc_run")
          data = (
            await f.db.query("select claim_qbo_cdc_run($1,$2,$3,$4,$5,$6,$7) result", [
              args.p_org_id,
              args.p_connection_id,
              args.p_realm_id,
              args.p_original_boundary,
              args.p_changed_since,
              args.p_checkpoint,
              args.p_reasons,
            ])
          ).rows[0].result
        else if (name === "persist_qbo_cdc_progress")
          data = (
            await f.db.query("select persist_qbo_cdc_progress($1,$2,$3,$4,$5,$6,$7,$8) result", [
              args.p_org_id,
              args.p_connection_id,
              args.p_realm_id,
              args.p_run_id,
              args.p_lease_token,
              args.p_expected_version,
              args.p_receipt_id,
              JSON.stringify(args.p_change),
            ])
          ).rows[0].result
        else if (name === "intake_qbo_webhook_events")
          data = (await f.db.query("select intake_qbo_webhook_events($1,$2) result", [JSON.stringify(args.p_events), args.p_payload_hash]))
            .rows[0].result
        else throw new Error(`Unstubbed RPC ${name}`)
        return { data, error: null }
      } catch (error) {
        return { data: null, error: { message: error.message } }
      }
    },
  }
  const stubs = {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-delivery": {
      accountingDeliveryDeadline: () => options.deadline?.(),
      withAccountingDeliveryGroup: async (_keys, _deadline, work) => work(),
    },
    "@/lib/supabase/worker-request-context": {
      workerPersistenceDeadline: () => Date.now() + 5000,
      withWorkerDatabasePersistence: (_deadline, work) => work(),
    },
    "@/lib/services/books/authority": {
      resolveLedgerAuthority: async () => "qbo",
    },
    "@/lib/services/accounting-logger": {
      logQBO: (...args) => logs.push(args),
    },
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: { forConnection: async () => client },
    },
    "@/lib/integrations/accounting/local-change": {},
    "@/lib/financials/ledger-status": {},
    "@/lib/services/events": { recordEvent: async () => {} },
    "@/lib/services/invoice-balance": {},
    "@/lib/services/accounting-sync-attempts": {},
    "@/lib/services/invoice-numbers": {},
  }
  return {
    db,
    stubs,
    calls,
    logs,
    api: load("lib/integrations/accounting/qbo/reconcile.ts", stubs),
  }
}
function assertIdentifier(text) {
  if (!/^[a-z_]+$/.test(text)) throw new Error(`Invalid fixture identifier ${text}`)
}
module.exports = { load, runtime }
