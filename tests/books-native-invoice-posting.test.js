require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  entity,
  maker,
  notes,
} = require("./fixtures/books-native-invoice-posting-database");
test("actual native invoice source commits to the shared native journal with complete canonical balanced money and exact receipt retry", async (t) => {
  const f = await setup(t),
    r = await f.post();
  assert.equal(r.posted, true);
  assert.equal(r.entry.fact_id, null);
  assert.equal(r.entry.source_posting_id, id(700));
  assert.equal(r.entry.total_cents, 12000);
  assert.deepEqual(
    r.lines.map((l) => [l.debit_cents, l.credit_cents]),
    [
      [10000, 0],
      [2000, 0],
      [0, 11000],
      [0, 1000],
    ],
  );
  assert.deepEqual(await f.post(), { ...r, created: false });
  await assert.rejects(f.post({ notes: notes + " changed" }), /retry differs/);
  await assert.rejects(f.post({ id: id(702), entry: id(703) }), /unique/);
  for (const table of [
    "books_native_invoice_postings",
    "books_native_journal_entries",
    "books_native_journal_lines",
  ])
    await assert.rejects(f.db.exec(`delete from ${table}`), /immutable/);
});
test("native source posting failure on a later leg rolls back receipt header and all money; exact uncommitted request can retry", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    "create function fail_invoice_leg() returns trigger language plpgsql as $$begin if new.position=2 then raise exception 'Injected invoice leg failure';end if;return new;end $$;create trigger zz_fail_invoice_leg before insert on books_native_journal_lines for each row execute function fail_invoice_leg()",
  );
  await assert.rejects(f.post(), /Injected/);
  for (const table of [
    "books_native_invoice_postings",
    "books_native_journal_entries",
    "books_native_journal_lines",
  ])
    assert.equal(
      (await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,
      0,
    );
  await f.db.exec(
    "drop trigger zz_fail_invoice_leg on books_native_journal_lines",
  );
  assert.equal((await f.post()).created, true);
});
test("changed source lines, scoped economics and holds fail before native invoice money", async (t) => {
  const f = await setup(t);
  const before =
    (await f.db.query("select generation from books_native_entity_fences"))
      .rows[0]?.generation ?? 0;
  await f.db.exec(
    "update invoice_lines set unit_price_cents=11001 where unit_price_cents=11000",
  );
  assert.ok(
    Number(
      (await f.db.query("select generation from books_native_entity_fences"))
        .rows[0]?.generation ?? 0,
    ) > Number(before),
  );
  await assert.rejects(f.post(), /snapshot changed/);
  await f.db.exec(
    "update invoice_lines set unit_price_cents=11000 where unit_price_cents=11001",
  );
  await f.rpc("set_books_native_period_hold", [
    org,
    entity,
    f.original.native.period.id,
    maker,
    id(720),
    null,
    "hold",
    notes,
  ]);
  await assert.rejects(f.post(), /snapshot changed|held/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    0,
  );
});

test("posted source economics stay immutable while payment status, labels and subsequent retainage release remain usable", async (t) => {
  const f = await setup(t),
    original = await f.post();
  for (const sql of [
    "update invoices set total_cents=10001",
    "update invoices set tax_cents=1001",
    "update invoices set issue_date='2026-04-16'",
    "update invoices set project_id='" + id(71) + "'",
    "update invoices set status='voided'",
    "delete from invoices",
    "update invoice_lines set quantity=2 where unit_price_cents=11000",
    "update invoice_lines set unit_price_cents=11001 where unit_price_cents=11000",
    "delete from invoice_lines",
    "update retainage set amount_cents=2001",
    "delete from retainage",
    "update accounting_policies set policy='{\"changed\":true}'",
    "update accounting_policies set approved_by='" + maker + "'",
    "delete from accounting_policies",
  ])
    await assert.rejects(f.db.exec(sql), /governed|immutable/);
  await f.db.exec(
    "update invoices set status='paid',metadata=metadata || '{\"label\":\"Paid and reviewed\"}'::jsonb;update invoice_lines set metadata=metadata || '{\"label\":\"Reviewed line\"}'::jsonb;update accounting_policies set status='superseded'",
  );
  assert.deepEqual(await f.post(), { ...original, created: false });
  await f.db.exec("update accounting_policies set status='approved'");
  await f.db.exec(
    `insert into invoices(id,org_id,project_id,issue_date,total_cents,tax_cents) values('${id(103)}','${org}','${id(70)}','2026-04-16',2000,0);update retainage set release_invoice_id='${id(103)}'`,
  );
  const release = await f.economic({ source: id(103), date: "2026-04-16" });
  const r = await f.post({ id: id(702), entry: id(703), economic: release });
  assert.deepEqual(
    r.lines.map((l) => [l.debit_cents, l.credit_cents]),
    [
      [2000, 0],
      [0, 2000],
    ],
  );
  await assert.rejects(
    f.db.exec("update retainage set release_invoice_id=null"),
    /governed/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    2,
  );
});

test("SQL revenue routing agrees with shared project policy across current models, unknown snapshots and contract eligibility", async (t) => {
  const f = await setup(t);
  const {
    resolveProjectRevenueBasis,
  } = require("../lib/financials/project-revenue-basis");
  const models = [
    null,
    "fixed_price",
    "cost_plus_fixed_fee",
    "cost_plus_gmp",
    "cost_plus_percent",
    "time_and_materials",
    "unknown_old_model",
  ];
  for (const explicit of models)
    for (const snapshot of models)
      for (const contractType of [
        "fixed_price",
        "purchase_agreement",
        "time_materials",
        "cost_plus",
      ]) {
        const e = structuredClone(f.original);
        e.financialSettings.billing_model = explicit;
        e.contracts[0].snapshot = { billing_model: snapshot };
        e.contracts[0].contract_type = contractType;
        const basis = resolveProjectRevenueBasis(
          { ...e.project, financial_settings: e.financialSettings },
          e.contracts,
          e.native.entryDate,
        );
        const derive = () =>
          f.rpc("books_derive_native_invoice_draft", [JSON.stringify(e)]);
        if (basis === "closing")
          await assert.rejects(derive(), /completed native closing/);
        else assert.match((await derive()).memo, /progress_billing$/);
      }
  for (const [status, date, parent] of [
    ["draft", "2026-01-01", null],
    ["active", "2026-05-01", null],
    ["active", "2026-01-01", id(601)],
  ]) {
    const e = structuredClone(f.original);
    Object.assign(e.contracts[0], {
      status,
      effective_date: date,
      parent_contract_id: parent,
      contract_type: "purchase_agreement",
    });
    assert.match(
      (await f.rpc("books_derive_native_invoice_draft", [JSON.stringify(e)]))
        .memo,
      /progress_billing$/,
    );
  }
  const e = structuredClone(f.original);
  e.contracts[0].status = "superseded";
  await assert.rejects(
    f.rpc("books_derive_native_invoice_draft", [JSON.stringify(e)]),
    /Historical/,
  );
});

test("SQL original closing settlement rejects fractional cancellation, missing components and unsafe cents", async (t) => {
  const f = await setup(t);
  const settlement = {
    ...require("../lib/financials/purchase-agreement-pricing").buildPurchaseAgreementSettlement(
      {
        agreementTotalCents: 12000,
        approvedChangeOrders: [],
        adjustments: [],
        deposits: [],
        builtAt: new Date().toISOString(),
      },
    ),
    contractId: id(601),
    agreementEvidenceDigest: "a".repeat(64),
    agreement: {
      id: id(601),
      number: "PA-1",
      signed_at: "2026-01-01T00:00:00Z",
    },
    pricing: {
      basePriceCents: 12000,
      lotPremiumCents: 0,
      structuralOptions: [],
      designSelections: [],
      incentives: [],
      structuralOptionsCents: 0,
      designSelectionsCents: 0,
      incentivesCents: 0,
      totalCents: 12000,
    },
    changeOrders: [],
  };
  await f.rpc("books_assert_native_closing_settlement", [
    JSON.stringify(settlement),
  ]);
  for (const mutate of [
    (s) => {
      s.adjustments = [{ amountCents: 0.5 }, { amountCents: -0.5 }];
    },
    (s) => {
      s.pricing.basePriceCents = 11999.5;
      s.pricing.lotPremiumCents = 0.5;
    },
    (s) => {
      delete s.pricing.structuralOptionsCents;
    },
    (s) => {
      s.pricing.structuralOptions = [
        { priceCents: 9007199254740992 },
        { priceCents: -9007199254740992 },
      ];
    },
    (s) => {
      s.pricing.structuralOptionsCents = 1;
    },
  ]) {
    const s = structuredClone(settlement);
    mutate(s);
    await assert.rejects(
      f.rpc("books_assert_native_closing_settlement", [JSON.stringify(s)]),
      /exact integer|safe cents|subtotals/,
    );
  }
});

test("typed native invoice receipt independently rebuilds original source money and rejects rehashed balanced wrong-account drafts", async (t) => {
  const f = await setup(t),
    r = await f.post();
  const {
    verifyNativeInvoicePostingReceipt: verify,
  } = require("../lib/services/books/native-invoice-posting-receipt");
  const { createHash } = require("node:crypto");
  assert.equal(verify(r.posting, r.entry, r.lines).plan.totalCents, 12000);
  for (const corrupt of [
    (x) => {
      x.entry.total_cents++;
    },
    (x) => {
      x.entry.fact_id = id(999);
    },
    (x) => {
      x.entry.source_posting_id = id(999);
    },
    (x) => {
      x.lines.pop();
    },
    (x) => {
      x.lines[1].id = x.lines[0].id;
    },
    (x) => {
      x.lines[0].project_id = id(71);
    },
    (x) => {
      x.posting.posted_by = id(999);
    },
    (x) => {
      x.posting.request_sha256 = "a".repeat(64);
    },
    (x) => {
      const d = JSON.parse(x.posting.draft_text);
      d.lines[2].accountCode = "4900";
      delete d.lines[2].accountRole;
      x.posting.draft_text = JSON.stringify(d);
      x.posting.draft_sha256 = createHash("sha256")
        .update(x.posting.draft_text)
        .digest("hex");
    },
  ]) {
    const bad = structuredClone(r);
    corrupt(bad);
    assert.throws(() => verify(bad.posting, bad.entry, bad.lines));
  }
});

test("operational invoice and independently reviewed manual adjustment share one native journal without mixing origins", async (t) => {
  const f = await setup(t);
  const source = await f.post();
  const request = { ...f.request, context: await f.context() };
  await f.prepare({ request });
  const adjustment = await f.review();
  assert.equal(adjustment.entry.source_posting_id, null);
  const {
    verifyNativeAdjustmentReview,
  } = require("../lib/services/books/native-adjustment-contract");
  const fact = (
    await f.db.query(
      "select to_jsonb(f) body from books_native_adjustment_facts f",
    )
  ).rows[0].body;
  assert.equal(
    verifyNativeAdjustmentReview(
      fact,
      adjustment.review,
      adjustment.entry,
      adjustment.lines,
    ).plan.totalCents,
    12000,
  );
  assert.equal(source.entry.fact_id, null);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
});
