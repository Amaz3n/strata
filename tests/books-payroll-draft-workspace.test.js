const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const {
  fixture: databaseFixture,
} = require("./helpers/books-private-payroll-documents-fixture");
const {
  fixture: registerFixture,
  id,
  org,
} = require("./helpers/books-payroll-register-fixture");
const {
  reconcilePayrollImport,
} = require("../lib/services/books/payroll-import-rules");
const {
  payrollDraftEvidence,
} = require("../lib/services/books/payroll-draft-evidence");
const migration = migrationSql("20261004073018_books_payroll_draft_workspace");
async function setup(t) {
  const f = await databaseFixture(t);
  await f.db.exec(migration);
  // Minimal SQL fixture models existing service table grants from the app schema.
  await f.db.exec(
    "grant select on projects,cost_codes,books_payroll_postings to service_role",
  );
  return f;
}
async function seed(f, n, project = id(4), status = "withdrawn") {
  const r = registerFixture();
  r.run.id = id(n);
  r.run.provider_run_id = "RUN-" + n;
  r.run.source_checksum = require("node:crypto")
    .createHash("sha256")
    .update("source-" + n)
    .digest("hex");
  r.sourceProof.checksum = r.run.source_checksum;
  r.run.employees[0].allocations[0].project_id = project;
  if (!project) r.run.employees[0].allocations[0].cost_code_id = null;
  const result = {
    ...r.result,
    ...reconcilePayrollImport(r.run, [], r.postingAccounts),
    run: r.run,
    sourceProof: r.sourceProof,
    sourceMappingDigest: require("../lib/services/books/hash").booksDigest({
      source: r.sourceProof,
      columns: r.columnMapping,
      workers: r.run.employees.map((w) => ({
        worker_id: w.worker_id,
        employee_reference: w.employee_reference,
        allocations: w.allocations,
      })),
    }),
  };
  const evidence = payrollDraftEvidence(result, "b".repeat(64));
  // Read fixtures seed retained history directly; this is not prepare/review acceptance.
  await f.db.exec("set session_replication_role=replica");
  try {
    await f.db.query(
      `insert into books_payroll_imports(id,org_id,provider,provider_run_id,period_start,period_end,status,source_checksum,source_proof,column_mapping,run,reconciliation,labor_evidence,evidence_digest,mapping_digest,reconciliation_digest,source_revision,prepared_by,preparation_notes,idempotency_key,prepared_at,withdrawn_by,withdrawn_at,withdrawal_reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'Original payroll allocation review notes',$19,'2026-10-04T00:00:00Z',$20,$21,$22)`,
      [
        id(n),
        org,
        evidence.run.provider,
        evidence.run.provider_run_id,
        evidence.run.period_start,
        evidence.run.period_end,
        status,
        evidence.run.source_checksum,
        JSON.stringify(evidence.source_proof),
        JSON.stringify(evidence.column_mapping),
        JSON.stringify(evidence.run),
        JSON.stringify(evidence.reconciliation),
        JSON.stringify(evidence.labor_evidence),
        evidence.evidence_digest,
        evidence.mapping_digest,
        evidence.reconciliation_digest,
        evidence.source_revision,
        id(50),
        "draft-workspace-" + n,
        status === "withdrawn" ? id(50) : null,
        status === "withdrawn" ? "2026-10-04T01:00:00Z" : null,
        status === "withdrawn" ? "Withdraw original payroll fixture" : null,
      ],
    );
  } finally {
    await f.db.exec("set session_replication_role=origin");
  }
  return evidence;
}
async function read(f, args = [org, id(4), null, null, null, 50]) {
  return (
    await f.db.query(
      "select read_books_project_payroll_drafts($1,$2,$3,$4,$5,$6) result",
      args,
    )
  ).rows[0].result;
}
test("private draft pages scope project and shared overhead, retain history, exclude actual postings and page tied timestamps exactly", async (t) => {
  const f = await setup(t);
  for (let n = 9000; n < 9055; n++) await seed(f, n);
  await seed(f, 9100, null);
  await seed(f, 9101, id(40));
  await f.db.exec("set role service_role");
  const first = await read(f),
    next = await read(f, [
      org,
      id(4),
      null,
      first.nextCursor.preparedAt,
      first.nextCursor.id,
      50,
    ]);
  assert.equal(first.imports.length, 50);
  assert.equal(next.imports.length, 6);
  assert.equal(next.nextCursor, null);
  const ids = [...first.imports, ...next.imports].map((x) => x.id);
  assert.equal(new Set(ids).size, 56);
  assert.ok(ids.includes(id(9100)));
  assert.ok(!ids.includes(id(9101)));
  assert.ok(!ids.includes(id(6)));
  assert.equal(
    (await read(f, [org, id(4), id(9100), null, null, 50])).imports[0].id,
    id(9100),
  );
  await assert.rejects(
    read(f, [org, id(4), id(9101), null, null, 50]),
    /unavailable/,
  );
  await assert.rejects(
    read(f, [org, id(4), id(6), null, null, 50]),
    /unavailable/,
  );
  await assert.rejects(
    read(f, [id(99), id(4), null, null, null, 50]),
    /unavailable/,
  );
});
test("draft read RPC has service-only invoker permissions and rejects malformed cursors/scopes", async (t) => {
  const f = await setup(t);
  const acl = (
    await f.db.query(
      "select prosecdef,provolatile,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='read_books_project_payroll_drafts'",
    )
  ).rows[0];
  assert.deepEqual(acl, {
    prosecdef: false,
    provolatile: "s",
    anon: false,
    browser: false,
    service: true,
  });
  for (const args of [
    [null, id(4), null, null, null, 50],
    [org, id(4), null, null, null, 51],
    [org, id(4), null, "2026-10-04", null, 50],
    [org, id(4), id(6), "2026-10-04", id(6), 50],
  ])
    await assert.rejects(read(f, args), /Invalid/);
  await f.db.exec("set role authenticated");
  await assert.rejects(read(f), /permission denied/);
});
test("actual draft services authorize before SQL, validate frozen evidence, retain original review/withdraw paths and reject foreign project detail", async (t) => {
  const f = await setup(t);
  await seed(f, 9200, id(4), "draft");
  await seed(f, 9201, id(40), "draft");
  let denied = false,
    disabled = false,
    actor = id(50),
    calls = [],
    reviewed,
    withdrawn;
  const client = {
    from(table) {
      const filters = [];
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        async single() {
          const r = await f.db.query(
            `select to_jsonb(t) row from ${table} t where ${filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ")}`,
            filters.map(([, v]) => v),
          );
          return { data: r.rows[0]?.row, error: null };
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push(name);
      try {
        return {
          data: await read(f, [
            args.p_org_id,
            args.p_project_id,
            args.p_import_id,
            args.p_before_time,
            args.p_before_id,
            args.p_limit,
          ]),
          error: null,
        };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({ orgId: org, userId: actor }),
        };
      if (name === "@/lib/storage/payroll-private-storage")
        return {
          requirePrivatePayrollRead: async () => {
            calls.push("authorize");
            if (denied) throw Error("Denied");
            if (disabled) throw Error("Books disabled");
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => client };
      if (name === "./payroll-imports")
        return {
          reviewPayrollImport: async (input) => {
            reviewed = input;
            return input.id;
          },
          withdrawPayrollImport: async (input) => {
            withdrawn = input;
            return input.id;
          },
        };
      return original.call(this, name, ...args);
    };
    api = require("../lib/services/books/payroll-draft-workspace");
  } finally {
    Module._load = original;
  }
  for (const flag of ["denied", "disabled"]) {
    denied = flag === "denied";
    disabled = flag === "disabled";
    calls = [];
    await assert.rejects(api.getProjectPayrollDrafts(id(4)), /Denied|disabled/);
    assert.deepEqual(calls, ["authorize"]);
  }
  denied = false;
  disabled = false;
  const page = await api.getProjectPayrollDrafts(id(4));
  assert.equal(page.drafts.length, 1);
  assert.equal(page.drafts[0].id, id(9200));
  assert.ok(!("employees" in page.drafts[0]));
  let detail = await api.getProjectPayrollDraftDetail({
    projectId: id(4),
    importId: id(9200),
  });
  assert.equal(detail.canReview, false);
  assert.equal(detail.canWithdraw, true);
  assert.equal(detail.controls.gross_cents, 24000);
  actor = id(51);
  detail = await api.getProjectPayrollDraftDetail({
    projectId: id(4),
    importId: id(9200),
  });
  assert.equal(detail.canReview, true);
  await api.reviewProjectPayrollDraft({
    projectId: id(4),
    importId: id(9200),
    notes: "Independent original allocation review",
  });
  assert.deepEqual(reviewed, {
    id: id(9200),
    notes: "Independent original allocation review",
  });
  await api.withdrawProjectPayrollDraft({
    projectId: id(4),
    importId: id(9200),
    reason: "Replace changed provider payroll source",
  });
  assert.deepEqual(withdrawn, {
    id: id(9200),
    reason: "Replace changed provider payroll source",
  });
  assert.equal(
    await api.requireProjectPayrollImportScope(id(4), id(6)),
    id(6),
    "Original posted parent scope remains available for exact retry recovery",
  );
  await assert.rejects(
    api.requireProjectPayrollImportScope(id(4), id(9201)),
    /does not affect/,
  );
  reviewed = null;
  await assert.rejects(
    api.reviewProjectPayrollDraft({
      projectId: id(4),
      importId: id(9201),
      notes: "Foreign project attempt",
    }),
    /unavailable/,
  );
  assert.equal(reviewed, null);
  await f.db.exec("set session_replication_role=replica");
  await f.db.query(
    "update books_payroll_imports set reconciliation=jsonb_set(reconciliation,'{costVarianceCents}','1') where id=$1",
    [id(9200)],
  );
  await f.db.exec("set session_replication_role=origin");
  await assert.rejects(
    api.getProjectPayrollDraftDetail({ projectId: id(4), importId: id(9200) }),
    /digest/,
  );
});
