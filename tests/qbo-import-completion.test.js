const test = require("node:test")
const assert = require("node:assert/strict")
const { importDatabase, id } = require("./fixtures/qbo-import-completion-database")
require("../scripts/register-ts-node-test")
const { importRuntime } = require("./fixtures/qbo-import-runtime")
const { originalCompletionSource } = require("./fixtures/qbo-original-completion")

const nativeFetch = global.fetch
// Every dependency is explicit; any accidental provider HTTP is a test failure.
test.before(() => {
  global.fetch = async () => {
    throw new Error("Native fetch forbidden")
  }
})
test.after(() => {
  global.fetch = nativeFetch
})

async function setup(t) {
  const f = await importDatabase(t)
  await f.db.query("select set_config('test.org_id',$1,false)", [f.org])
  await f.db.query("insert into app_users values($1)", [id(10)])
  await f.db.query("insert into projects(id,org_id) values($1,$2)", [id(20), f.org])
  return f
}
async function claim(f, type = "invoice", external = "remote") {
  return (await f.db.query("select accounting_claim_import($1,$2,$3,$4) token", [f.org, f.connection, type, external])).rows[0].token
}
async function owned(f, token, type = "invoice", external = "remote", values = {}) {
  const table = type === "invoice" ? "invoices" : "payments"
  const namespace = type === "invoice" ? "Invoice" : type === "payment" ? "Payment" : "BillPayment"
  return (
    await f.db.query("select accounting_persist_import_row($1,$2,$3,$4,$5,$6,$7,$8,$9) id", [
      f.org,
      f.connection,
      token,
      table,
      type,
      namespace,
      external,
      type === "invoice" ? "document" : values.provider_payment_id,
      JSON.stringify({ org_id: f.org, project_id: id(20), ...values }),
    ])
  ).rows[0].id
}
function completion(f, token, entity, extra = {}) {
  return {
    p_org_id: f.org,
    p_connection_id: f.connection,
    p_realm_id: "realm",
    p_claim_token: token,
    p_import_type: "invoice",
    p_external_id: "remote",
    p_entity_type: "invoice",
    p_entity_id: entity,
    p_sync_token: "2",
    p_pushable: false,
    p_metadata: { origin: "qbo_import", ownership: "inbound" },
    ...extra,
  }
}

test("exact completion migration is absent historically, denies app roles and merges fenced current metadata", async (t) => {
  const f = await setup(t)
  const r = importRuntime(f, {})
  assert.equal((await f.db.query("select count(*)::int n from pg_proc where proname='complete_qbo_import_identity'")).rows[0].n, 0)
  const token = await claim(f),
    entity = await owned(f, token)
  // The old authenticated completion writes fail after the exact Q02/Q03 grants.
  assert.match(
    (await r.user.from("accounting_sync_records").update({ status: "synced" }).eq("entity_id", entity)).error.message,
    /permission denied/,
  )
  assert.match(
    (await r.user.from("qbo_webhook_events").update({ process_status: "reconciled" }).eq("realm_id", "realm")).error.message,
    /permission denied/,
  )
  await f.installCompletion()
  for (const role of ["anon", "authenticated"]) {
    await f.role(role, async () =>
      assert.rejects(
        f.db.query("select complete_qbo_import_identity($1,$2,'realm',$3,'invoice','remote','invoice',$4,null,false,'{}')", [
          f.org,
          f.connection,
          token,
          entity,
        ]),
        /permission denied/,
      ),
    )
    await f.role(role, async () =>
      assert.rejects(
        f.db.query("select resolve_qbo_import_events($1,$2,'realm',$3,'invoice','remote',null)", [f.org, f.connection, token]),
        /permission denied/,
      ),
    )
  }
  assert.equal((await f.db.query("select count(*)::int n from pg_proc where proname='complete_qbo_import_identity'")).rows[0].n, 1)
  await f.db.query("update accounting_sync_records set metadata=metadata||'{\"concurrent_marker\":true}' where entity_id=$1", [entity])
  assert.equal((await r.service.rpc("complete_qbo_import_identity", completion(f, token, entity))).data, true)
  const mapping = (await f.db.query("select * from accounting_sync_records where entity_id=$1", [entity])).rows[0]
  assert.equal(mapping.metadata.concurrent_marker, true)
  assert.equal(mapping.metadata.import_complete, true)
  for (const extra of [{ p_claim_token: null }, { p_realm_id: "foreign" }, { p_org_id: f.otherOrg }, { p_entity_id: id(999) }]) {
    assert.ok((await r.service.rpc("complete_qbo_import_identity", completion(f, token, entity, extra))).error)
  }
  await f.db.query("update accounting_import_claims set claim_token=$1 where claim_token=$2", [id(777), token])
  assert.match((await r.service.rpc("complete_qbo_import_identity", completion(f, token, entity))).error.message, /no longer owned/)
})

test("actual authorized import service executes provider, owned claim/row/children/completion and replay once", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  let providerReads = 0
  const snapshot = {
    Id: "remote",
    SyncToken: "2",
    TotalAmt: 123.45,
    Balance: 123.45,
    TxnDate: "2026-10-04",
    MetaData: { LastUpdatedTime: "2026-10-04T12:00:00.123457Z" },
    Line: [
      {
        Id: "line",
        DetailType: "SalesItemLineDetail",
        Description: "Synthetic line",
        Amount: 123.45,
        SalesItemLineDetail: { Qty: 1, UnitPrice: 123.45 },
      },
    ],
  }
  const r = importRuntime(f, {
    getInvoiceById: async () => {
      providerReads++
      return snapshot
    },
  })
  for (const [namespace, time] of [
    ["Invoice", "2026-10-04T12:00:00.123456Z"],
    ["Invoice", "2026-10-04T12:00:00.123457Z"],
    ["Invoice", "2026-10-04T12:00:00.123458Z"],
    ["Payment", "2026-10-04T12:00:00.000Z"],
  ]) {
    await f.db.query(
      "insert into qbo_webhook_events(event_id,realm_id,entity_name,entity_qbo_id,operation,last_updated,process_status,payload_hash) values($1,'realm',$2,'remote','Update',$3,'pending','synthetic')",
      [`realm:${namespace}:remote:Update:${time}`, namespace, time],
    )
  }
  const input = {
    connectionId: f.connection,
    items: [{ externalId: "remote", entityType: "invoice", projectId: id(20) }],
  }
  const result = await r.serviceApi.applyAccountingImport(input)
  assert.equal(result.failed, 0, JSON.stringify(result.errors))
  assert.equal(result.imported, 1)
  assert.equal(providerReads, 1)
  assert.equal((await f.db.query("select count(*)::int n from invoices")).rows[0].n, 1)
  assert.equal((await f.db.query("select count(*)::int n from invoice_lines")).rows[0].n, 1)
  assert.equal((await f.db.query("select total_cents from invoices")).rows[0].total_cents, 12345)
  assert.equal((await f.db.query("select status from accounting_import_claims")).rows[0].status, "completed")
  const queue = await f.queue()
  assert.equal(queue.find((row) => row.event_id.endsWith("123456Z")).process_status, "reconciled")
  for (const row of queue.filter((row) => !row.event_id.endsWith("123456Z"))) assert.equal(row.process_status, "pending")
  assert.equal((await r.serviceApi.applyAccountingImport(input)).skipped, 1)
  assert.equal(providerReads, 1)
  assert.ok(r.calls.some((call) => call.rpc === "accounting_persist_import_children"))
  assert.ok(r.permissions.some((p) => p.permission === "invoice.write" && p.projectId === id(20)))
  assert.ok(r.events.some((event) => event.eventType === "accounting_import_completed"))
})

test("missing permission or foreign destination denies before provider and financial dispatch", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  let provider = 0
  const r = importRuntime(
    f,
    {
      getInvoiceById: async () => {
        provider++
        throw new Error("Forbidden provider")
      },
    },
    { deny: (permission) => permission === "bill.write" },
  )
  await assert.rejects(
    r.serviceApi.applyAccountingImport({
      connectionId: f.connection,
      items: [{ externalId: "remote", entityType: "invoice", projectId: id(20) }],
    }),
    /Permission denied/,
  )
  const allowed = importRuntime(f, {}, {})
  await assert.rejects(
    allowed.serviceApi.applyAccountingImport({
      connectionId: f.connection,
      items: [{ externalId: "remote", entityType: "invoice", projectId: id(999) }],
    }),
    /outside this organization/,
  )
  assert.equal(provider, 0)
  assert.equal(r.calls.filter((call) => call.rpc).length, 0)
  assert.equal((await f.db.query("select count(*)::int n from invoices")).rows[0].n, 0)
})

test("original import completion helpers reproduce authenticated denial without broad grant restoration", async (t) => {
  const f = await setup(t)
  const r = importRuntime(f, {}, { source: originalCompletionSource })
  const token = await claim(f),
    entity = await owned(f, token)
  await assert.rejects(
    r.api.completionTest.linkSyncRecord({
      supabase: r.user,
      orgId: f.org,
      connectionId: f.connection,
      entityType: "invoice",
      entityId: entity,
      qboId: "remote",
    }),
    /permission denied/,
  )
  await f.db.query(
    "insert into qbo_webhook_events(event_id,realm_id,entity_name,entity_qbo_id,operation,last_updated,process_status,payload_hash) values('historical-denial','realm','Invoice','remote','Update','2026-10-04T12:00:00Z','pending','synthetic')",
  )
  await assert.rejects(r.api.completionTest.markEventsResolved(r.user, "remote", "realm", ["Invoice"]), /permission denied/)
  assert.equal((await f.db.query("select status from accounting_sync_records")).rows[0].status, "pending")
  assert.equal((await f.queue()).find((row) => row.event_id === "historical-denial").process_status, "pending")
  assert.deepEqual(
    r.calls.filter((call) => call.role === "authenticated" && call.mutation).map((call) => [call.table, call.mutation]),
    [["accounting_sync_records", "insert"], ["qbo_webhook_events", "update"]],
  )
})

test("event completion requires every owned sibling, keeps equal/newer precision and missing snapshot eligible", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  const r = importRuntime(f, {})
  const token = await claim(f),
    entity = await owned(f, token)
  await r.service.rpc("complete_qbo_import_identity", completion(f, token, entity))
  const ctx = {
    ...r.ctx,
    connectionId: f.connection,
    externalAccountId: "realm",
    importClaimToken: token,
    importClaimType: "invoice",
    importClaimExternalId: "remote",
  }
  await f.db.query("insert into invoices(id,org_id,project_id) values($1,$2,$3)", [id(21), f.org, id(20)])
  await f.db.query(
    "insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status,metadata) values($1,$2,'qbo','invoice',$3,'remote','pending','{\"external_entity_type\":\"Invoice\",\"import_complete\":false}')",
    [f.org, f.connection, id(21)],
  )
  await assert.rejects(
    r.api.completionTest.markEventsResolved(ctx, "remote", ["Invoice"], {
      MetaData: { LastUpdatedTime: "2026-10-04T12:00:00.000Z" },
    }),
    /incomplete/,
  )
  await f.db.query("delete from accounting_sync_records where entity_id=$1", [id(21)])
  await f.db.query(
    "insert into qbo_webhook_events(event_id,realm_id,entity_name,entity_qbo_id,operation,last_updated,process_status,payload_hash) values('realm:Invoice:remote:Update:2026-10-03T12:00:00.000Z','realm','Invoice','remote','Update','2026-10-03','pending','synthetic')",
  )
  await r.api.completionTest.markEventsResolved(ctx, "remote", ["Invoice"])
  assert.equal((await f.queue())[0].process_status, "pending")
  await r.api.completionTest.markEventsResolved(ctx, "remote", ["Invoice"], {
    MetaData: { LastUpdatedTime: "invalid" },
  })
  assert.equal((await f.queue())[0].process_status, "pending")
})

async function seedCashTarget(f, type) {
  const table = type === "payment" ? "invoices" : "vendor_bills"
  const namespace = type === "payment" ? "Invoice" : "Bill"
  const localType = type === "payment" ? "invoice" : "bill"
  await f.db.query(`insert into ${table}(id,org_id,project_id,status) values($1,$2,$3,'approved')`, [id(30), f.org, id(20)])
  await f.db.query(
    "insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status,metadata) values($1,$2,'qbo',$3,$4,'doc','synced',$5)",
    [
      f.org,
      f.connection,
      localType,
      id(30),
      JSON.stringify({
        external_entity_type: namespace,
        import_complete: true,
      }),
    ],
  )
  return {
    table,
    namespace,
    target: type === "payment" ? "invoice_id" : "bill_id",
  }
}

test("actual Payment and BillPayment adopt existing cash once, reject source changes and preserve project authority", async (t) => {
  for (const type of ["payment", "bill_payment"])
    await t.test(type, async (t) => {
      const f = await setup(t)
      await f.installCompletion()
      const { target, namespace } = await seedCashTarget(f, type)
      const { qboImportProviderPaymentId } = require("../lib/integrations/accounting/qbo/import-rules")
      const key = qboImportProviderPaymentId({
        connectionId: f.connection,
        kind: type === "payment" ? "payment" : "billpayment",
        qboId: "cash",
        split: false,
        lineId: "doc",
      })
      await f.db.query(
        `insert into payments(id,org_id,project_id,${target},amount_cents,provider,provider_payment_id,status) values($1,$2,$3,$4,100,'qbo',$5,'succeeded')`,
        [id(31), f.org, id(20), id(30), key],
      )
      const snapshot = {
        Id: "cash",
        SyncToken: "1",
        TxnDate: "2026-10-04",
        MetaData: { LastUpdatedTime: "2026-10-04T12:00:00.000Z" },
        Line: [
          {
            Id: "1",
            Amount: 1,
            LinkedTxn: [{ TxnId: "doc", TxnType: namespace }],
          },
        ],
      }
      const client = {
        [type === "payment" ? "getPaymentById" : "getBillPaymentById"]: async () => snapshot,
      }
      const r = importRuntime(f, client)
      const input = {
        connectionId: f.connection,
        items: [{ externalId: "cash", entityType: type }],
      }
      const result = await r.serviceApi.applyAccountingImport(input)
      assert.equal(result.failed, 0, JSON.stringify(result.errors))
      assert.equal((await f.db.query("select count(*)::int n from payments")).rows[0].n, 1)
      assert.equal(
        (await f.db.query("select entity_id,status,metadata from accounting_sync_records where external_id='cash'")).rows[0].entity_id,
        id(31),
      )
      assert.equal((await r.serviceApi.applyAccountingImport(input)).skipped, 1)
      assert.ok(r.permissions.some((p) => p.projectId === id(20)))
      // Re-open a synthetic failed claim, then reject different amount/target.
      await f.db.query(
        "update accounting_import_claims set status='error',lease_expires_at=now()-interval '1 second' where external_id='cash'",
      )
      await f.db.query("update payments set amount_cents=999 where id=$1", [id(31)])
      const changed = await r.serviceApi.applyAccountingImport(input)
      assert.equal(changed.failed, 1)
      assert.match(changed.errors[0].message, /amount or allocation changed/)
      const denied = importRuntime(f, client, {
        deny: (_permission, project) => project === id(20),
      })
      await f.db.query(
        "update accounting_import_claims set status='error',lease_expires_at=now()-interval '1 second' where external_id='cash'",
      )
      assert.equal((await denied.serviceApi.applyAccountingImport(input)).failed, 1)
      assert.equal(denied.calls.filter((call) => call.rpc === "accounting_persist_import_row").length, 0)
    })
})

test("cash completion requires captured expectations and revalidates concurrent edits atomically", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  const r = importRuntime(f, {})
  const token = await claim(f, "payment", "cash")
  await seedCashTarget(f, "payment")
  const key = "synthetic-cash-key"
  const entity = await owned(f, token, "payment", "cash", {
    invoice_id: id(30),
    amount_cents: 100,
    provider: "qbo",
    provider_payment_id: key,
  })
  const args = completion(f, token, entity, {
    p_import_type: "payment",
    p_external_id: "cash",
    p_entity_type: "payment",
    p_expected_payment: {
      provider_payment_id: key,
      amount_cents: 100,
      invoice_id: id(30),
    },
  })
  for (const expected of [
    undefined,
    null,
    { provider_payment_id: key, amount_cents: 100 },
    { provider_payment_id: key, amount_cents: 100, invoice_id: null },
    {
      provider_payment_id: key,
      amount_cents: 100,
      invoice_id: id(30),
      bill_id: id(30),
    },
    { provider_payment_id: key, amount_cents: 99, invoice_id: id(30) },
  ]) {
    const probe = { ...args }
    if (expected === undefined) delete probe.p_expected_payment
    else probe.p_expected_payment = expected
    assert.ok((await r.service.rpc("complete_qbo_import_identity", probe)).error)
  }
  await f.db.query("update payments set amount_cents=999 where id=$1", [entity])
  assert.match((await r.service.rpc("complete_qbo_import_identity", args)).error.message, /changed/)
  assert.equal(
    (await f.db.query("select status,metadata from accounting_sync_records where entity_id=$1", [entity])).rows[0].metadata.import_complete,
    false,
  )
  await f.db.query("update payments set amount_cents=100,project_id=$1 where id=$2", [id(99), entity])
  assert.match((await r.service.rpc("complete_qbo_import_identity", args)).error.message, /project scope/)
})

test("allocation preflight rejects conflicting proposed routes, lookup/permission failures before all effects", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  const snapshot = {
    Id: "remote",
    Line: ["a", "b"].map((Id, index) => ({
      Id,
      AccountBasedExpenseLineDetail: {
        CustomerRef: { value: `customer${index}` },
      },
    })),
  }
  for (const options of [
    {},
    { queryError: (table) => table === "accounting_entity_map" },
    { deny: (permission) => permission === "accounting.entity_map.manage" },
  ]) {
    const r = importRuntime(f, { getBillById: async () => snapshot }, options)
    const operation = r.serviceApi.applyAccountingImport({
      connectionId: f.connection,
      items: [
        {
          externalId: "remote",
          entityType: "bill",
          projectId: id(20),
          allocations: {
            a: id(20),
            ...(options.deny || options.queryError ? {} : { b: id(20) }),
          },
        },
      ],
    })
    if (options.queryError) await assert.rejects(operation, /lookup failure/)
    else assert.equal((await operation).failed, 1)
    assert.equal(r.calls.filter((call) => call.routing || call.rpc === "accounting_persist_import_row").length, 0)
    if (!options.queryError)
      assert.equal(
        r.calls.filter((call) => call.table === "accounting_entity_map" && call.columns === "id,connection_id,dimensions").length,
        1,
        "repeated project routing read is item-local cached",
      )
  }
})

test("allowed allocation uses actual authorized routing service, retains dimensions and caches source read", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  await f.db.query(
    'insert into accounting_entity_map(id,org_id,connection_id,project_id,dimensions) values($1,$2,$3,$4,\'{"class":{"id":"class","name":"Class"}}\')',
    [id(40), f.org, f.connection, id(20)],
  )
  let reads = 0
  const snapshot = {
    Id: "remote",
    Line: [
      {
        Id: "a",
        AccountBasedExpenseLineDetail: {
          CustomerRef: { value: "customer", name: "Customer" },
        },
      },
    ],
  }
  const client = {
    getBillById: async () => {
      reads++
      return snapshot
    },
  }
  const r = importRuntime(f, client, { realRouting: true })
  const ctx = {
    ...r.ctx,
    connectionId: f.connection,
    externalAccountId: "realm",
    batch: { projectByCustomer: new Map() },
  }
  const cached = await r.api.completionTest.preflightImportRouting(ctx, client, {
    entityType: "bill",
    qboId: "remote",
    allocations: { a: id(20) },
  })
  assert.equal(await cached.getBillById("remote"), snapshot)
  assert.equal(reads, 1)
  const mapping = (await f.db.query("select dimensions from accounting_entity_map")).rows[0].dimensions
  assert.equal(mapping.class.id, "class")
  assert.equal(mapping.customer.id, "customer")
  assert.ok(r.events.some((event) => event.eventType === "accounting_entity_map_updated"))
  assert.ok(r.permissions.some((p) => p.permission === "accounting.entity_map.manage" && p.projectId === id(20)))
  // A pre-existing customer binding allows an explicit one-off allocation,
  // without changing that stable routing or requiring a new route permission.
  ctx.batch.projectByCustomer.set("customer", id(20))
  const oneOff = importRuntime(f, client, {
    deny: (permission) => permission === "accounting.entity_map.manage",
  })
  await oneOff.api.completionTest.preflightImportRouting(ctx, client, {
    entityType: "bill",
    qboId: "remote",
    allocations: { a: id(20) },
  })
})

test("remaining import families execute actual caller completion under owned namespaces", async (t) => {
  for (const type of ["expense", "expense_credit", "bill", "vendor_credit", "journal_entry", "client_deposit"])
    await t.test(type, async (t) => {
      const f = await setup(t)
      await f.installCompletion()
      const names = {
        expense: "Purchase",
        expense_credit: "Purchase",
        bill: "Bill",
        vendor_credit: "VendorCredit",
        journal_entry: "JournalEntry",
        client_deposit: "JournalEntry",
      }
      const getters = {
        expense: "getPurchaseById",
        expense_credit: "getPurchaseById",
        bill: "getBillById",
        vendor_credit: "getVendorCreditById",
        journal_entry: "getJournalEntryById",
        client_deposit: "getJournalEntryById",
      }
      const expenseLine = {
        Id: "a",
        Amount: 1,
        Description: "Synthetic cost",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "expense" } },
      }
      const journalLines = [
        {
          Id: "a",
          Amount: 1,
          Description: "Synthetic cost",
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: "expense" },
          },
        },
        {
          Id: "b",
          Amount: 1,
          Description: "Synthetic deposit",
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: "income" },
          },
        },
      ]
      const snapshot = {
        Id: "remote",
        SyncToken: "1",
        TotalAmt: 1,
        Balance: 1,
        TxnDate: "2026-10-04",
        VendorRef: { value: "vendor" },
        Credit: type === "expense_credit",
        MetaData: { LastUpdatedTime: "2026-10-04T12:00:00.000Z" },
        Line: type.includes("journal") || type === "client_deposit" ? journalLines : [expenseLine],
      }
      const r = importRuntime(f, {
        [getters[type]]: async () => snapshot,
        listExpenseAccounts: async () => [{ id: "expense" }],
        listIncomeAccounts: async () => [{ id: "income" }],
      })
      await f.db.query(
        "insert into qbo_webhook_events(event_id,realm_id,entity_name,entity_qbo_id,operation,last_updated,process_status,payload_hash) values($1,'realm',$2,'remote','Update','2026-10-03','pending','synthetic')",
        [`realm:${names[type]}:remote:Update:2026-10-03T12:00:00.000Z`, names[type]],
      )
      const input = {
        connectionId: f.connection,
        items: [{ externalId: "remote", entityType: type, projectId: id(20) }],
      }
      const result = await r.serviceApi.applyAccountingImport(input)
      assert.equal(result.failed, 0, JSON.stringify(result.errors))
      assert.equal(result.imported, 1)
      const mappings = (await f.db.query("select * from accounting_sync_records where external_id='remote'")).rows
      assert.ok(mappings.length > 0)
      assert.ok(
        mappings.every(
          (mapping) =>
            mapping.status === "synced" && mapping.metadata.import_complete && mapping.metadata.external_entity_type === names[type],
        ),
      )
      if (type === "client_deposit") assert.deepEqual(mappings.map((mapping) => mapping.entity_type).sort(), ["invoice", "payment"])
      assert.equal((await f.queue())[0].process_status, "reconciled")
      assert.equal((await r.serviceApi.applyAccountingImport(input)).skipped, 1)
      // Posting and opening-payment collaborators are explicit inert seams here;
      // this verifies import/identity/claim compatibility, not financial projection.
    })
})

test("actual cash adoption captures source facts before concurrent amount/target edits", async (t) => {
  for (const type of ["payment", "bill_payment"])
    await t.test(type, async (t) => {
      const f = await setup(t)
      await f.installCompletion()
      const { target, namespace } = await seedCashTarget(f, type)
      const { qboImportProviderPaymentId } = require("../lib/integrations/accounting/qbo/import-rules")
      const key = qboImportProviderPaymentId({
        connectionId: f.connection,
        kind: type === "payment" ? "payment" : "billpayment",
        qboId: "race",
        split: false,
        lineId: "doc",
      })
      await f.db.query(
        `insert into payments(id,org_id,project_id,${target},amount_cents,provider,provider_payment_id,status) values($1,$2,$3,$4,100,'qbo',$5,'succeeded')`,
        [id(31), f.org, id(20), id(30), key],
      )
      const snapshot = {
        Id: "race",
        SyncToken: "1",
        TxnDate: "2026-10-04",
        Line: [
          {
            Id: "1",
            Amount: 1,
            LinkedTxn: [{ TxnId: "doc", TxnType: namespace }],
          },
        ],
      }
      const r = importRuntime(
        f,
        {
          [type === "payment" ? "getPaymentById" : "getBillPaymentById"]: async () => snapshot,
        },
        {
          beforeRpc: async (name) => {
            if (name === "complete_qbo_import_identity") await f.db.query("update payments set amount_cents=999 where id=$1", [id(31)])
          },
        },
      )
      const result = await r.serviceApi.applyAccountingImport({
        connectionId: f.connection,
        items: [{ externalId: "race", entityType: type }],
      })
      assert.equal(result.failed, 1)
      assert.match(result.errors[0].message, /changed/)
      assert.equal((await f.db.query("select count(*)::int n from payments")).rows[0].n, 1)
      const mapping = (await f.db.query("select metadata,status from accounting_sync_records where external_id='race'")).rows[0]
      assert.equal(mapping.metadata.import_complete, false)
      assert.equal(mapping.status, "pending")
    })
})

test("durable recovery candidate flows through authorized review/import while historic gap stays open", async (t) => {
  const f = await setup(t)
  await f.install()
  await f.installCompletion()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
    [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
  )
  const snapshot = {
    Id: "candidate",
    SyncToken: "1",
    TotalAmt: 1,
    Balance: 1,
    TxnDate: "2026-10-04",
    MetaData: { LastUpdatedTime: "2026-10-04T12:00:00.000Z" },
    Line: [],
  }
  const { runtime } = require("./fixtures/qbo-cdc-runtime")
  const cdc = runtime(f, {
    changeDataCapture: async () => ({ CDCResponse: [{}] }),
    queryRecoveryPage: async (entity) => ({
      rows: entity === "Invoice" ? [snapshot] : [],
      done: true,
      total: entity === "Invoice" ? 1 : 0,
    }),
    readRecoveryEntity: async () => {
      throw new Error("Unexpected unmapped read")
    },
  })
  for (let n = 0; n < 3; n++) await cdc.api.ingestQboCdcChanges({ connectionId: f.connection })
  const r = importRuntime(f, { getInvoiceById: async () => snapshot })
  const { candidates } = await r.serviceApi.listAccountingRecoveryCandidates({
    connectionId: f.connection,
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].external_id, "candidate")
  assert.deepEqual(candidates[0].import_types, ["invoice"])
  const result = await r.serviceApi.applyAccountingImport({
    connectionId: f.connection,
    items: [
      {
        externalId: candidates[0].external_id,
        entityType: "invoice",
        projectId: id(20),
      },
    ],
  })
  assert.equal(result.imported, 1)
  assert.equal((await f.db.query("select count(*)::int n from invoices")).rows[0].n, 1)
  const gap = (await f.settings()).qbo_cdc_recovery
  assert.equal(gap.status, "required")
  assert.ok(gap.reasons.includes("lost_window"))
  assert.equal((await f.candidates())[0].review_status, "pending", "identity completion cannot falsely heal an unresolved historic gap")
})

test("existing document adoption preserves local identity and authorizes project before owned effects", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  await f.db.query("insert into invoices(id,org_id,project_id) values($1,$2,$3)", [id(30), f.org, id(20)])
  const denied = importRuntime(f, {}, { deny: (_permission, project) => project === id(20) })
  await assert.rejects(
    denied.api.linkExistingQboImportRecord({
      orgId: f.org,
      connectionId: f.connection,
      qboId: "adopt",
      entityType: "invoice",
      existingEntityId: id(30),
    }),
    /Permission denied/,
  )
  assert.equal(denied.calls.filter((call) => call.rpc).length, 0)
  const r = importRuntime(f, {})
  assert.deepEqual(
    await r.api.linkExistingQboImportRecord({
      orgId: f.org,
      connectionId: f.connection,
      qboId: "adopt",
      entityType: "invoice",
      existingEntityId: id(30),
    }),
    { linked: true },
  )
  assert.equal((await f.db.query("select count(*)::int n from invoices")).rows[0].n, 1)
  assert.equal((await f.db.query("select entity_id,metadata from accounting_sync_records")).rows[0].entity_id, id(30))
})

test("auto-mapped cost destinations are authorized before any financial/routing write, and allowed sources are cached", async (t) => {
  const f = await setup(t)
  await f.installCompletion()
  await f.db.query("insert into projects(id,org_id) values($1,$2)", [id(21), f.org])
  await f.db.query(
    'insert into accounting_entity_map(org_id,connection_id,project_id,dimensions) values($1,$2,$3,\'{"customer":{"id":"customer","name":"Customer"}}\')',
    [f.org, f.connection, id(21)],
  )
  let reads = 0
  const snapshot = {
    Id: "mapped",
    SyncToken: "1",
    TotalAmt: 1,
    Balance: 1,
    TxnDate: "2026-10-04",
    Line: [
      {
        Id: "a",
        Description: "Cost",
        Amount: 1,
        AccountBasedExpenseLineDetail: { AccountRef: { value: "expense" }, CustomerRef: { value: "customer" } },
      },
    ],
  }
  const client = {
    getBillById: async () => {
      reads++
      return snapshot
    },
  }
  const denied = importRuntime(f, client, { deny: (_permission, project) => project === id(21) })
  const input = { connectionId: f.connection, items: [{ externalId: "mapped", entityType: "bill", projectId: id(20) }] }
  assert.equal((await denied.serviceApi.applyAccountingImport(input)).failed, 1)
  assert.equal(denied.calls.filter((call) => call.routing || call.rpc === "accounting_persist_import_row").length, 0)
  assert.equal((await f.db.query("select count(*)::int n from vendor_bills")).rows[0].n, 0)
  const r = importRuntime(f, client)
  const result = await r.serviceApi.applyAccountingImport(input)
  assert.equal(result.failed, 0, JSON.stringify(result.errors))
  assert.equal(reads, 2, "each invocation fetches once; actual bill helper uses its inspected cached source")
  assert.ok(r.permissions.some((permission) => permission.projectId === id(21)))
  assert.equal((await f.db.query("select project_id from bill_lines")).rows[0].project_id, id(21))
})

test("irrelevant allocation lines reject before project routing or owned financial effects", async (t) => {
  for (const type of ["journal_entry", "client_deposit", "expense"])
    await t.test(type, async (t) => {
      const f = await setup(t)
      await f.installCompletion()
      const line =
        type === "expense"
          ? { Id: "irrelevant", Amount: 1, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { CustomerRef: { value: "customer" } } }
          : {
              Id: "irrelevant",
              Amount: 1,
              DetailType: "JournalEntryLineDetail",
              JournalEntryLineDetail: {
                PostingType: type === "journal_entry" ? "Credit" : "Debit",
                AccountRef: { value: type === "journal_entry" ? "income" : "expense" },
                Entity: { Type: "Customer", EntityRef: { value: "customer" } },
              },
            }
      const snapshot = { Id: "remote", TotalAmt: 1, Line: [line] }
      const r = importRuntime(
        f,
        {
          getJournalEntryById: async () => snapshot,
          getPurchaseById: async () => snapshot,
          listExpenseAccounts: async () => [{ id: "expense" }],
          listIncomeAccounts: async () => [{ id: "income" }],
        },
        { realRouting: true },
      )
      const result = await r.serviceApi.applyAccountingImport({
        connectionId: f.connection,
        items: [{ externalId: "remote", entityType: type, projectId: id(20), allocations: { irrelevant: id(20) } }],
      })
      assert.equal(result.failed, 1)
      assert.match(result.errors[0].message, /not applicable/)
      assert.equal(
        r.calls.filter((call) => call.rpc === "accounting_persist_import_row" || (call.table === "accounting_entity_map" && call.mutation))
          .length,
        0,
      )
      assert.equal((await f.db.query("select count(*)::int n from accounting_entity_map")).rows[0].n, 0)
    })
})
