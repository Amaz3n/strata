require("../scripts/register-ts-node-test");
const fs = require("node:fs"),
  test = require("node:test"),
  assert = require("node:assert/strict");
const base = require("./fixtures/books-native-invoice-income-database");
const {
  buildNativeInvoiceCorrectionPair: build,
  verifyNativeInvoiceCorrectionPairDerivation: verify,
} = require("../lib/services/books/native-invoice-correction-pair");
const {
  buildNativeInvoicePostingPlan,
} = require("../lib/services/books/native-invoice-economics");
async function setup(t, initialize) {
  const f = await base.setup(t);
  for (const name of [
    "20261005111155_books_native_invoice_reversal_derivation.sql",
    "20261005114131_books_native_invoice_correction_pair_derivation.sql",
  ])
    await f.db.exec(fs.readFileSync("supabase/migrations/" + name, "utf8"));
  if (initialize) await initialize(f);
  const money = await f.post({ economic: await f.economic() }),
    economic = await f.economic({ date: "2026-04-16" });
  const patch = {
    totalCents: 12000,
    taxCents: 1000,
    lines: [
      {
        id: base.id(602),
        quantity: "1",
        unitPriceCents: 13000,
        incomeAccountId: null,
      },
    ],
  };
  const request = {
    id: base.id(990),
    baseEconomic: economic,
    original: {
      posting: money.posting,
      entry: money.entry,
      lines: money.lines,
    },
    patch,
    notes: base.notes,
  };
  const derive = (q = request) =>
    f.rpc("books_derive_native_invoice_correction_pair", [
      base.org,
      base.entity,
      base.id(70),
      base.maker,
      q.id,
      money.posting.id,
      JSON.stringify(q.baseEconomic),
      JSON.stringify(q.patch),
      q.notes,
    ]);
  return { ...f, money, request, derive };
}
test("actual SQL correction pair retains invoice date and reverses original money exactly while deriving revised full replacement", async (t) => {
  const f = await setup(t),
    before = (await f.db.query("select to_jsonb(i) body from invoices i")).rows;
  const r = await f.derive(),
    v = verify(f.request, r),
    p = build(f.request);
  assert.deepEqual(v.replacement.lines, p.replacement.lines);
  assert.equal(v.replacement.entryDate, "2026-04-16");
  assert.equal(v.replacementEconomic.native.source.issue_date, "2026-04-15");
  assert.deepEqual(
    v.replacement.lines.map((l) => [l.debitCents, l.creditCents]),
    [
      [12000, 0],
      [2000, 0],
      [0, 13000],
      [0, 1000],
    ],
  );
  assert.deepEqual(
    v.reversal.lines.map((l) => [l.accountId, l.debitCents, l.creditCents]),
    f.money.lines.map((l) => [l.account_id, l.credit_cents, l.debit_cents]),
  );
  assert.equal(
    v.replacementEconomic.lines[0].source.metadata
      .arc_books_entity_correction_id,
    f.request.id,
  );
  assert.equal(
    v.replacementEconomic.lines[1].source.metadata
      .arc_books_entity_correction_id,
    undefined,
  );
  assert.deepEqual(
    (await f.db.query("select to_jsonb(i) body from invoices i")).rows,
    before,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
  for (const field of [
    "posted",
    "reviewed",
    "sourceChanged",
    "ledgerActivated",
  ])
    assert.equal(v[field], false);
  // Initial posting cannot take a correction date through its ordinary API.
  assert.throws(
    () => buildNativeInvoicePostingPlan(v.replacementEconomic),
    /original issue date/,
  );
  for (const edit of [
    (x) => {
      x.replacementDraft.lines[0].accountCode = "4000";
    },
    (x) => {
      x.replacementEconomic.native.source.issue_date = "2026-04-16";
    },
    (x) => {
      x.replacementEconomic.lines[0].source.metadata.foreign = "injected";
    },
    (x) => {
      x.patch.totalCents++;
    },
  ]) {
    const copy = structuredClone(r);
    edit(copy);
    assert.throws(
      () => verify(f.request, copy),
      /draft differs|revision differs|revision request/,
    );
  }
});
test("paired correction rejects incomplete/generated/duplicate/foreign lines and unsafe or untied money", async (t) => {
  const f = await setup(t);
  for (const edit of [
    (q) => {
      q.patch.lines = [];
    },
    (q) => {
      q.patch.lines.push(q.patch.lines[0]);
    },
    (q) => {
      q.patch.lines[0].id = base.id(603);
    },
    (q) => {
      q.patch.lines[0].incomeAccountId = base.id(999);
    },
    (q) => {
      q.patch.lines[0].quantity = "1e3";
    },
    (q) => {
      q.patch.totalCents++;
    },
    (q) => {
      q.patch.lines[0].unitPriceCents = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const q = structuredClone(f.request);
    edit(q);
    assert.throws(() => build(q));
    await assert.rejects(f.derive(q));
  }
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
test("late correction evaluates contract eligibility on original invoice date rather than silently changing recognition", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `insert into contracts values('${base.id(991)}','${base.org}','${base.id(70)}','active',null,'2026-04-16','purchase_agreement')`,
  );
  const q = {
    ...f.request,
    baseEconomic: await f.economic({ date: "2026-04-16" }),
  };
  const r = verify(q, await f.derive(q));
  assert.equal(
    r.replacement.lines.some((l) => l.accountCode === "2350"),
    true,
  );
});
test("late closing income correction keeps signed settlement and date while selecting reviewed current income account", async (t) => {
  const f = await setup(t, async (f) => {
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
      contractId: base.id(601),
      agreementEvidenceDigest: "a".repeat(64),
      agreement: {
        id: base.id(601),
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
    await f.db.exec(
      `update projects set property_type='production';update contracts set contract_type='purchase_agreement';delete from retainage;delete from invoice_lines where unit_price_cents<0;update invoice_lines set unit_price_cents=12000;update invoices set total_cents=12000,tax_cents=0`,
    );
    await f.db.query(
      `update invoices set metadata=jsonb_build_object('invoice_kind','closing','source_closing_id',$1::text,'settlement',$2::jsonb)`,
      [base.id(610), JSON.stringify(settlement)],
    );
    await f.db.query(
      `insert into closings values($1,$2,$3,$4,'closed','2026-04-15',$5)`,
      [
        base.id(610),
        base.org,
        base.id(70),
        base.id(100),
        JSON.stringify(settlement),
      ],
    );
  });
  const income = f.request.baseEconomic.native.accounts.find(
    (a) => a.code === "4900",
  );
  const q = {
    ...f.request,
    patch: {
      totalCents: 12000,
      taxCents: 0,
      lines: [
        {
          id: base.id(602),
          quantity: "1",
          unitPriceCents: 12000,
          incomeAccountId: income.id,
        },
      ],
    },
  };
  const r = verify(q, await f.derive(q));
  assert.equal(r.replacement.lines[1].accountId, income.id);
  assert.equal(r.replacementEconomic.closings[0].actual_date, "2026-04-15");
  const bad = structuredClone(q);
  bad.patch.totalCents = 12001;
  bad.patch.lines[0].unitPriceCents = 12001;
  await assert.rejects(f.derive(bad), /settlement/);
  assert.throws(() => build(bad), /settlement/);
});

test("correction may use another available period while original period is held; target holds and stale snapshots reject", async (t) => {
  const f = await setup(t);
  const q = {
    ...f.request,
    baseEconomic: await f.economic({ date: "2026-05-16" }),
  };
  await f.rpc("set_books_native_period_hold", [
    base.org,
    base.entity,
    f.request.baseEconomic.native.period.id,
    base.maker,
    base.id(992),
    null,
    "hold",
    base.notes,
  ]);
  const r = verify(q, await f.derive(q));
  assert.equal(r.replacement.entryDate, "2026-05-16");
  await f.rpc("set_books_native_period_hold", [
    base.org,
    base.entity,
    q.baseEconomic.native.period.id,
    base.maker,
    base.id(993),
    null,
    "hold",
    base.notes,
  ]);
  await assert.rejects(f.derive(q), /held|snapshot/);
  const bad = structuredClone(q);
  bad.baseEconomic.native.source.total_cents++;
  await assert.rejects(f.derive(bad), /snapshot/);
});
test("paired replacement uses exact decimal rounding and retains every unpriced source dependency", async (t) => {
  const f = await setup(t, async (f) => {
    await f.db.exec(
      "delete from retainage;delete from invoice_lines where unit_price_cents<0;update invoices set total_cents=12000",
    );
  });
  const q = {
    ...f.request,
    patch: {
      totalCents: 2,
      taxCents: 0,
      lines: [
        {
          id: base.id(602),
          quantity: "0.5",
          unitPriceCents: 3,
          incomeAccountId: null,
        },
      ],
    },
  };
  const r = verify(q, await f.derive(q));
  assert.equal(r.replacement.totalCents, 2);
  assert.equal(r.replacementEconomic.lines[0].quantity, "0.5");
  assert.deepEqual(r.replacementEconomic.contracts, q.baseEconomic.contracts);
  assert.deepEqual(r.replacementEconomic.retainage, q.baseEconomic.retainage);
});
test("paired correction helpers keep private INVOKER ACL and require active current preparation access", async (t) => {
  const f = await setup(t),
    sql = fs.readFileSync(
      "supabase/tests/books_native_invoice_correction_pair_derivation.test.sql",
      "utf8",
    );
  const expressions = [
    ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(expressions.length, 4);
  for (const [, expression, label] of expressions)
    assert.equal(
      (await f.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
  await f.rpc("set_books_legal_entity_member", [
    base.org,
    base.entity,
    base.maker,
    base.reviewer,
    "manage",
    base.notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    base.org,
    base.entity,
    base.reviewer,
    base.maker,
    "revoked",
    base.notes,
  ]);
  await assert.rejects(f.derive(), /access/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
