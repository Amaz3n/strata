require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const {
  setup,
  catalog,
  id,
  org,
  actor,
  reviewer,
  reader,
  entity,
  profile,
  notes,
} = require("./fixtures/books-legacy-entity-database");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const { booksDigest } = require("../lib/services/books/hash"),
  {
    historicalDocumentInventory,
  } = require("../lib/services/books/tax-attachment-archive");
const {
  verifyLegacyEntityOwnershipArchive,
  LEGACY_ENTITY_OWNERSHIP_TABLES,
} = require("../lib/services/books/legacy-entity-ownership");
const baseTables = EXPORT_TABLES.filter(
  (table) =>
    table !== "books_journal_request_resolutions" &&
    table !== "books_project_owner_request_resolutions" &&
    ![
      "books_native_invoice_request_resolutions",
      "books_native_invoice_income_selections",
      "books_native_invoice_income_resolutions",
      "books_native_invoice_correction_proposals",
      "books_native_invoice_correction_reviews",
      "books_native_invoice_postings",
      "books_native_adjustment_facts",
      "books_native_adjustment_reviews",
      "books_native_journal_entries",
      "books_native_journal_lines",
      "books_native_period_holds",
      "books_entity_calendar_years",
      "books_entity_fiscal_periods",
      "books_entity_calendar_reviews",
      "books_project_entity_proposals",
      "books_project_entity_reviews",
      "books_entity_chart_versions",
      "books_entity_accounts",
      "books_entity_account_definitions",
      "books_entity_control_accounts",
      "books_entity_chart_reviews",
    ].includes(table) &&
    !LEGACY_ENTITY_OWNERSHIP_TABLES.includes(table),
);
function archive(f, tables, version = BOOKS_EXPORT_SCHEMA_VERSION) {
  return {
    tables,
    manifest: {
      schemaVersion: version,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((row) => row.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [
          table,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((row) => ({
        id: row.id,
        storagePath: row.storage_path,
        sizeBytes: Number(row.size_bytes),
        checksum: row.checksum,
      })),
      supportingHistoricalFiles: historicalDocumentInventory(tables, org),
    },
    supportingObjects: [
      { fileId: id(90), dataBase64: f.bytes.toString("base64") },
    ],
    supportingHistoricalObjects: [],
  };
}
test("actual proposals capture every retained source, require independent review and never assign/activate a ledger", async (t) => {
  const f = await setup(t);
  await f.db.query("insert into invoices values($1,$2,$3)", [
    id(80),
    org,
    "Future or undated original retained source",
  ]);
  const p = await f.prepare(),
    source = JSON.parse(p.source_population_text);
  assert.deepEqual(
    Object.keys(source).sort(),
    [
      ...baseTables,
      "books_project_entity_proposals",
      "books_project_entity_reviews",
    ].sort(),
  );
  assert.equal(source.invoices[0].id, id(80));
  assert.equal(
    createHash("sha256").update(p.source_population_text).digest("hex"),
    p.source_population_sha256,
  );
  assert.equal(p.assignment_kind, "single_entity_legacy");
  assert.deepEqual(p.decision_evidence, f.evidence);
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review(id(30), id(40), actor), /separate/);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    actor,
    actor,
    "manage",
    notes,
  ]);
  await assert.rejects(
    f.db.query(
      "insert into books_legacy_entity_reviews(id,org_id,legal_entity_id,proposal_id,reviewed_by,review_notes) values($1,$2,$3,$4,$5,$6)",
      [id(40), org, entity, id(30), actor, notes],
    ),
    /separate/,
  );
  const r = await f.review();
  assert.deepEqual(await f.review(), r);
  const detail = await f.read();
  assert.equal(detail.approvedForLedgerActivation, false);
  assert.equal(detail.sourcePopulationCurrent, true);
  assert.deepEqual(detail.review, r);
  assert.equal(
    (await f.db.query("select ledger_state from books_legal_entities")).rows[0]
      .ledger_state,
    "setup",
  );
  assert.deepEqual((await f.db.query("select * from invoices")).rows, [
    {
      id: id(80),
      org_id: org,
      payload: "Future or undated original retained source",
    },
  ]);
  assert.equal(
    (await f.db.query("select count(*)::int n from accounting_facts")).rows[0]
      .n,
    0,
  );
});
test("source changes, document drift, identity revision and a competing reviewed predecessor invalidate approval", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.db.query("insert into invoices values($1,$2,$3)", [
    id(80),
    org,
    "Late original",
  ]);
  await assert.rejects(f.review(), /population changed/);
  assert.equal((await f.read()).sourcePopulationCurrent, false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_legacy_entity_reviews",
      )
    ).rows[0].n,
    0,
  );
  await f.prepare(id(31));
  await f.prepare(id(32));
  await f.review(id(31), id(41));
  await assert.rejects(f.review(id(32), id(42)), /predecessor changed/);
  await f.prepare(id(33), id(31));
  await f.db.query("update doc_versions set storage_path=$1 where id=$2", [
    org + "/books/ownership/changed.pdf",
    id(91),
  ]);
  await assert.rejects(f.review(id(33), id(43)), /population changed/);
  await f.db.query("update doc_versions set storage_path=$1 where id=$2", [
    org + "/books/ownership/original.pdf",
    id(91),
  ]);
  const details = {
    legal_name: "Builder Renamed LLC",
    legal_form: "llc",
    functional_currency: "USD",
    fiscal_start_month: 1,
    fiscal_start_day: 1,
    effective_on: "2026-10-01",
    identity_evidence: { source: "Original new identity review" },
  };
  await f.rpc("prepare_books_legal_entity_profile", [
    org,
    entity,
    id(21),
    actor,
    profile,
    JSON.stringify(details),
    notes,
  ]);
  await f.rpc("review_books_legal_entity_profile", [
    org,
    entity,
    id(21),
    reviewer,
    notes,
  ]);
  await assert.rejects(f.review(id(33), id(43)), /identity changed/);
});
test("private roles, active membership, whole-organization entity access and immutable evidence are enforced", async (t) => {
  const f = await setup(t),
    p = await f.prepare();
  for (const table of LEGACY_ENTITY_OWNERSHIP_TABLES) {
    const acl = (
      await f.db.query(
        "select has_table_privilege('authenticated',$1,'select') browser,has_table_privilege('anon',$1,'insert') anon",
        [table],
      )
    ).rows[0];
    assert.deepEqual(acl, { browser: false, anon: false });
    if (table === "books_legacy_entity_proposals")
      await assert.rejects(f.db.query(`delete from ${table}`), /immutable/);
  }
  await assert.rejects(
    f.db.query(
      "update books_legacy_entity_proposals set preparation_notes='Changed original preparation'",
    ),
    /immutable/,
  );
  await f.db.exec("set role authenticated");
  await assert.rejects(f.read(), /permission denied/);
  await f.db.exec("reset role");
  await assert.rejects(
    f.prepare(id(31), null, f.evidence, reader),
    /preparation access/,
  );
  await f.rpc("create_books_legal_entity", [
    org,
    id(11),
    "OTHER",
    actor,
    notes,
  ]);
  await assert.rejects(f.review(), /every included legal entity/);
  await f.rpc("set_books_legal_entity_member", [
    org,
    id(11),
    actor,
    reviewer,
    "read",
    notes,
  ]);
  await assert.rejects(f.review(), /population changed/);
  await f.db.query(
    "update memberships set status='suspended' where org_id=$1 and user_id=$2",
    [org, actor],
  );
  await assert.rejects(f.prepare(), /preparation access/);
  await assert.rejects(f.read(), /read access/);
  assert.equal(
    (
      await f.db.query(
        "select source_population_text from books_legacy_entity_proposals where id=$1",
        [id(30)],
      )
    ).rows[0].source_population_text,
    p.source_population_text,
  );
});
test("decision evidence requires explicit single-entity confirmation, original scoped versions and frozen retry identities", async (t) => {
  const f = await setup(t);
  for (const change of [
    (e) => {
      e.single_entity_history_confirmed = false;
    },
    (e) => {
      e.rationale = "short";
    },
    (e) => {
      e.document_version_ids = [];
    },
    (e) => {
      e.document_version_ids = [id(91), id(91)];
    },
    (e) => {
      e.document_version_ids = [id(999)];
    },
    (e) => {
      e.extra = "guessed ownership";
    },
  ]) {
    const e = structuredClone(f.evidence);
    change(e);
    await assert.rejects(f.prepare(id(30), null, e));
  }
  const p = await f.prepare();
  const changed = {
    ...f.evidence,
    rationale: "A different legacy owner claim with original document retained",
  };
  await assert.rejects(f.prepare(id(30), null, changed), /retry differs/);
  await f.review();
  await f.db.query("insert into invoices values($1,$2,$3)", [
    id(80),
    org,
    "Changed later source",
  ]);
  assert.deepEqual(await f.prepare(), p);
  assert.equal((await f.read()).sourcePopulationCurrent, false);
  await f.prepare(id(31), id(30));
  await f.review(id(31), id(41));
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review(id(30), id(42)), /retry differs/);
});
test("schema19 archives verify retained proposal/review/document/access closure and reject recomputed corruption", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  const tables = await f.capture(),
    bundle = archive(f, tables);
  assert.equal(BOOKS_EXPORT_SCHEMA_VERSION, 32);
  assert.equal(
    verifyBooksExportBundle(bundle).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle)),
  );
  assert.ok(
    verifyLegacyEntityOwnershipArchive(tables, org, 18, baseTables).length,
  );
  for (const change of [
    (rows) => {
      rows.books_legacy_entity_reviews[0].reviewed_by = actor;
    },
    (rows) => {
      rows.books_legacy_entity_reviews[0].legal_entity_id = id(99);
    },
    (rows) => {
      rows.books_legacy_entity_reviews[0].reviewed_access_event_id =
        rows.books_legacy_entity_proposals[0].prepared_access_event_id;
    },
    (rows) => {
      rows.books_legacy_entity_proposals[0].previous_reviewed_proposal_id =
        id(30);
    },
    (rows) => {
      rows.books_legacy_entity_proposals[0].source_population_sha256 =
        "0".repeat(64);
    },
    (rows) => {
      rows.books_legacy_entity_proposals[0].decision_evidence.document_version_ids =
        [id(999)];
    },
    (rows) => {
      rows.books_legacy_entity_reviews = [];
      rows.books_legacy_entity_proposals[0].previous_reviewed_proposal_id =
        id(999);
    },
    (rows) => {
      const p = rows.books_legacy_entity_proposals[0],
        source = JSON.parse(p.source_population_text);
      delete source.invoices;
      p.source_population_text = JSON.stringify(source);
      p.source_population_sha256 = createHash("sha256")
        .update(p.source_population_text)
        .digest("hex");
    },
    (rows) => {
      const p = rows.books_legacy_entity_proposals[0],
        source = JSON.parse(p.source_population_text);
      source.doc_versions[0].storage_path = "different";
      p.source_population_text = JSON.stringify(source);
      p.source_population_sha256 = createHash("sha256")
        .update(p.source_population_text)
        .digest("hex");
    },
  ]) {
    const bad = structuredClone(tables);
    change(bad);
    const b = archive(f, bad);
    assert.equal(verifyBooksExportBundle(b).valid, false);
  }
});
test("normal retries and subsequent reviewed proposals work after scoped schema19 restoration", async (t) => {
  const f = await setup(t),
    p = await f.prepare(),
    r = await f.review();
  await f.db.query("insert into invoices values($1,$2,$3)", [
    id(80),
    org,
    "After original approval",
  ]);
  const tables = await f.capture(),
    bundle = archive(f, tables),
    original = structuredClone(bundle);
  assert.equal(verifyBooksExportBundle(bundle).valid, true);
  const target = await setup(t),
    targetCatalog = await catalog(target.db);
  const {
    prepareBooksRestorePlan,
  } = require("../lib/services/books/restore-plan");
  const missing = prepareBooksRestorePlan({
    bundle,
    catalog: targetCatalog,
    dependencies: [],
    fundingActors: {},
  });
  assert.equal(missing.preflight.readyForRestoreAttempt, false);
  const plan = prepareBooksRestorePlan({
    bundle,
    catalog: targetCatalog,
    dependencies: [
      { schema: "public", table: "orgs", rows: [{ id: org }] },
      {
        schema: "public",
        table: "app_users",
        rows: [actor, reviewer, reader].map((id) => ({ id })),
      },
    ],
    fundingActors: {},
  });
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  await target.db.exec("set session_replication_role=replica");
  try {
    for (const table of EXPORT_TABLES)
      await target.db.exec(`delete from ${table}`);
    for (const table of EXPORT_TABLES)
      if (plan.tables[table].length)
        await target.db.query(
          `insert into ${table} select * from jsonb_populate_recordset(null::${table},$1::jsonb)`,
          [JSON.stringify(plan.tables[table])],
        );
  } finally {
    await target.db.exec("set session_replication_role=origin");
  }
  assert.deepEqual(bundle, original);
  assert.deepEqual(await target.prepare(), p);
  assert.deepEqual(await target.review(), r);
  assert.equal((await target.read()).sourcePopulationCurrent, false);
  await assert.rejects(
    target.db.query(
      "update books_legacy_entity_proposals set preparation_notes='Changed restored evidence'",
    ),
    /immutable/,
  );
  await target.prepare(id(31), id(30));
  await target.review(id(31), id(41));
  const restored = archive(target, await target.capture());
  assert.equal(
    verifyBooksExportBundle(restored).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(restored)),
  );
  assert.equal((await target.read(id(31))).sourcePopulationCurrent, true);
});

test("service checks Books and entity access before documents, streams original bytes, and rejects forged receipts", async (t) => {
  const f = await setup(t),
    Module = require("node:module");
  let user = actor,
    denied = false,
    changed = false,
    forged = false,
    streams = 0;
  const permissions = [];
  const service = {
    rpc: async (name, args) => {
      try {
        let data = await f.rpc(name, Object.values(args));
        if (forged && name === "prepare_books_legacy_entity_proposal")
          data = { ...data, org_id: id(999) };
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
    from(table) {
      assert.equal(table, "doc_versions");
      let filterOrg, filterIds;
      const q = {
        select() {
          return q;
        },
        eq(key, value) {
          assert.equal(key, "org_id");
          filterOrg = value;
          return q;
        },
        in(key, value) {
          assert.equal(key, "id");
          filterIds = value;
          return q;
        },
        then(resolve, reject) {
          return f.db
            .query(
              "select * from doc_versions where org_id=$1 and id=any($2::uuid[])",
              [filterOrg, filterIds],
            )
            .then((result) => ({ data: result.rows, error: null }))
            .then(resolve, reject);
        },
      };
      return q;
    },
  };
  const original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: org,
            userId: user,
            supabase: service,
          }),
        };
      if (
        name === "./access" &&
        args[0]?.filename.endsWith("legacy-entity-ownership-service.ts")
      )
        return {
          requireBooksAuthorization: async (input) => {
            permissions.push(input.permission);
            if (denied) throw new Error("Books permission denied");
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/storage/files-storage")
        return {
          getFilesObjectStream: async (input) => {
            assert.equal(input.orgId, org);
            assert.equal(input.path, org + "/books/ownership/original.pdf");
            streams++;
            return {
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    changed
                      ? Buffer.from("Corrupted original object")
                      : f.bytes,
                  );
                  controller.close();
                },
              }),
            };
          },
        };
      return original.call(this, name, ...args);
    };
    delete require.cache[
      require.resolve("../lib/services/books/legacy-entity-ownership-service")
    ];
    delete require.cache[
      require.resolve("../lib/services/books/tax-attachments")
    ];
    api = require("../lib/services/books/legacy-entity-ownership-service");
  } finally {
    Module._load = original;
  }
  const request = {
    id: id(30),
    entityId: entity,
    profileId: profile,
    previousReviewedProposalId: null,
    accountingCutoff: "2026-09-30",
    evidence: f.evidence,
    notes,
  };
  denied = true;
  await assert.rejects(
    api.prepareBooksLegacyEntityProposal(request),
    /permission denied/,
  );
  assert.equal(streams, 0);
  denied = false;
  user = reader;
  await assert.rejects(
    api.prepareBooksLegacyEntityProposal(request),
    /operation access/,
  );
  assert.equal(streams, 0);
  user = actor;
  changed = true;
  await assert.rejects(
    api.prepareBooksLegacyEntityProposal(request),
    /bytes differ|size differs/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_legacy_entity_proposals",
      )
    ).rows[0].n,
    0,
  );
  changed = false;
  const p = await api.prepareBooksLegacyEntityProposal(request);
  assert.equal(p.id, id(30));
  assert.ok(permissions.includes("books.manage"));
  assert.ok(permissions.includes("books.export"));
  forged = true;
  await assert.rejects(
    api.prepareBooksLegacyEntityProposal(request),
    /receipt differs/,
  );
  forged = false;
  user = reviewer;
  changed = true;
  await assert.rejects(
    api.reviewBooksLegacyEntityProposal({
      id: id(40),
      entityId: entity,
      proposalId: id(30),
      notes,
    }),
    /bytes differ|size differs/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_legacy_entity_reviews",
      )
    ).rows[0].n,
    0,
  );
  changed = false;
  const r = await api.reviewBooksLegacyEntityProposal({
    id: id(40),
    entityId: entity,
    proposalId: id(30),
    notes,
  });
  assert.equal(r.reviewed_by, reviewer);
  changed = true;
  const before = streams;
  assert.deepEqual(
    await api.reviewBooksLegacyEntityProposal({
      id: id(40),
      entityId: entity,
      proposalId: id(30),
      notes,
    }),
    r,
  );
  assert.equal(streams, before);
  const detail = await api.readBooksLegacyEntityProposal({
    entityId: entity,
    proposalId: id(30),
  });
  assert.equal(detail.approvedForLedgerActivation, false);
  assert.equal(detail.sourcePopulationCurrent, true);
  assert.ok(permissions.includes("books.read"));
});

test("private service-role execution preserves typed redactions inside retained population text", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    "alter table companies add column tax_id text,add column ein text,add column ssn text;alter table org_funding_sources add column provider_customer_id text,add column provider_payment_method_id text,add column bank_name text,add column books_gl_account_id uuid;",
  );
  await f.db.query("insert into companies values($1,$2,$3,$4,$5)", [
    id(70),
    org,
    "PRIVATE-TIN",
    "PRIVATE-EIN",
    "PRIVATE-SSN",
  ]);
  await f.db.query(
    "insert into org_funding_sources values($1,$2,$3,$4,$5,$6)",
    [id(71), org, "PRIVATE-CUSTOMER", "PRIVATE-METHOD", "Builder bank", null],
  );
  // Supabase service_role has underlying source grants and bypasses table RLS;
  // private RPCs must still enforce their actor/entity predicates themselves.
  await f.db.exec(
    "grant all on all tables in schema public to service_role;grant usage,select on all sequences in schema public to service_role;set role service_role",
  );
  let p;
  try {
    p = await f.prepare();
    await f.review();
    await assert.rejects(
      f.prepare(id(31), null, f.evidence, reader),
      /preparation access/,
    );
  } finally {
    await f.db.exec("reset role");
  }
  assert.ok(!p.source_population_text.includes("PRIVATE-"));
  const population = JSON.parse(p.source_population_text);
  assert.deepEqual(population.companies, [{ id: id(70), org_id: org }]);
  assert.deepEqual(population.org_funding_sources, [
    {
      id: id(71),
      org_id: org,
      bank_name: "Builder bank",
      books_gl_account_id: null,
    },
  ]);
  assert.equal((await f.read()).sourcePopulationCurrent, true);
  await f.db.query(
    "update org_funding_sources set bank_name='Different reviewed bank' where id=$1",
    [id(71)],
  );
  assert.equal((await f.read()).sourcePopulationCurrent, false);
});
test("legacy population contract2 includes native project authority and rejects later ownership changes or mixed owners", async (t) => {
  const f = await setup(t),
    p = await f.prepare();
  assert.equal(p.population_contract_version, 2);
  const population = JSON.parse(p.source_population_text);
  assert.deepEqual(population.books_project_entity_proposals, []);
  assert.deepEqual(population.books_project_entity_reviews, []);
  await f.db.query(
    "insert into books_project_entity_proposals(id,org_id,legal_entity_id) values($1,$2,$3)",
    [id(500), org, entity],
  );
  await assert.rejects(f.review(), /population changed/);
  const other = await setup(t);
  await other.db.query(
    "insert into books_project_entity_reviews(id,org_id,legal_entity_id) values($1,$2,$3)",
    [id(501), org, id(999)],
  );
  await assert.rejects(other.prepare(), /Mixed native project owners/);
});
test("retained contract1 preparations can be reviewed after upgrade only while native project ownership remains absent", async (t) => {
  const fs = require("node:fs");
  const original = fs.readFileSync(
      "supabase/migrations/20261004181652_books_legacy_entity_ownership_review.sql",
      "utf8",
    ),
    chart = fs.readFileSync(
      "supabase/migrations/20261004222659_books_entity_chart_versions.sql",
      "utf8",
    ),
    current = fs.readFileSync(
      "supabase/migrations/20261004233548_books_project_owner_archive.sql",
      "utf8",
    );
  const f = await setup(t);
  const oldPrep = original
    .slice(
      original.indexOf(
        "create function public.books_legacy_entity_proposal_guard()",
      ),
      original.indexOf(
        "create function public.books_legacy_entity_review_guard()",
      ),
    )
    .replace("create function", "create or replace function");
  await f.db.exec(oldPrep);
  await f.db.exec(
    chart
      .slice(
        chart.indexOf(
          "create or replace function public.capture_books_legacy_ownership_evidence",
        ),
        chart.lastIndexOf("commit;"),
      )
      .replaceAll(
        "capture_books_export_snapshot(p_org_id)",
        "capture_books_export_snapshot_before_project_owners(p_org_id)",
      )
      .replace(
        "-'books_legacy_entity_reviews'",
        "-'books_legacy_entity_reviews'-'books_project_entity_proposals'-'books_project_entity_reviews'",
      ),
  );
  const p = await f.prepare();
  assert.equal(p.population_contract_version, 1);
  assert.equal(
    JSON.parse(p.source_population_text).books_project_entity_reviews,
    undefined,
  );
  await f.db.exec(
    current.slice(
      current.indexOf(
        "create or replace function public.capture_books_legacy_ownership_evidence",
      ),
      current.indexOf("alter table public.books_legacy_entity_proposals"),
    ),
  );
  assert.equal((await f.read()).sourcePopulationCurrent, true);
  await f.review();
  assert.equal((await f.read()).proposal.population_contract_version, 1);
  await f.db.query(
    "insert into books_project_entity_proposals(id,org_id,legal_entity_id) values($1,$2,$3)",
    [id(502), org, entity],
  );
  assert.equal((await f.read()).sourcePopulationCurrent, false);
  // An exact reviewed retry still returns its original committed receipt.
  assert.equal((await f.review()).proposal_id, p.id);
});
test("legacy archive rejects native ownership omitted at capture or review and permits later retained history", async (t) => {
  const f = await setup(t);
  const p = await f.prepare();
  const r = await f.review();
  const tables = await f.capture();
  assert.deepEqual(
    verifyLegacyEntityOwnershipArchive(tables, org, 23, baseTables),
    [],
  );
  assert.match(
    verifyLegacyEntityOwnershipArchive(tables, org, 22, baseTables).join(";"),
    /requires archive schema23/,
  );
  const bad = structuredClone(tables);
  bad.books_project_entity_proposals = [
    {
      id: id(503),
      org_id: org,
      legal_entity_id: entity,
      prepared_at: p.source_captured_at,
    },
  ];
  assert.match(
    verifyLegacyEntityOwnershipArchive(bad, org, 23, baseTables).join(";"),
    /omitted retained project ownership/,
  );
  bad.books_project_entity_proposals[0].prepared_at = r.source_rechecked_at;
  assert.match(
    verifyLegacyEntityOwnershipArchive(bad, org, 23, baseTables).join(";"),
    /omitted retained project ownership/,
  );
  bad.books_project_entity_proposals[0].prepared_at = new Date(
    Date.parse(r.reviewed_at) + 1000,
  ).toISOString();
  assert.deepEqual(
    verifyLegacyEntityOwnershipArchive(bad, org, 23, baseTables),
    [],
  );
});

test("retained legacy population contract excludes cancellation provenance and preserves original source evidence", async (t) => {
  const f = await setup(t),
    p = await f.prepare();
  await f.db.query(
    "insert into books_project_owner_request_resolutions(id,org_id) values($1,$2)",
    [id(95), org],
  );
  // This fixture isolates the actual capture body from cancellation validation;
  // real cancellation guards and receipts have their own populated SQL scenarios.
  const evidence = await f.rpc("capture_books_legacy_ownership_evidence", [
    org,
    actor,
  ]);
  assert.deepEqual(
    JSON.parse(evidence.populationText),
    JSON.parse(p.source_population_text),
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(evidence.populationText),
      "books_project_owner_request_resolutions",
    ),
    false,
  );
  assert.equal(
    (await f.review()).source_population_sha256,
    p.source_population_sha256,
  );
});
