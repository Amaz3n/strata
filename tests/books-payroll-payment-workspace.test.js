const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const { setup } = require("./helpers/books-payroll-payment-fixture");
const { prepare } = require("./helpers/books-payroll-database");
const { id, org } = require("./helpers/books-payroll-register-fixture");
const {
  payrollPaymentReviewEvidence,
} = require("../lib/services/books/payroll-payment-review-rules");
const sql = migrationSql("20261004082928_books_payroll_payment_workspace");
const notes = "Verified original statement and worker allocation";
async function fixture(t) {
  const f = await setup(t);
  await prepare(f.db, f.evidence);
  await f.db.exec(
    "alter table books_payroll_postings add payroll_import_id uuid;grant select on books_payroll_postings to service_role;alter role service_role bypassrls",
  );
  await f.db.exec(sql);
  return f;
}
async function prep(f, n) {
  const p = payrollPaymentReviewEvidence(
    f.evidence,
    { ...f.request, id: id(n) },
    [f.proof],
  );
  await f.db.query(
    "select prepare_books_payroll_payment_review($1,$2,$3,$4,$5,$6,$7)",
    [
      org,
      id(50),
      p.request,
      p.evidence,
      p.evidenceDigest,
      notes,
      "history-" + n,
    ],
  );
  return p;
}
const read = (
  f,
  review = null,
  before = null,
  organization = org,
  importId = id(6),
) =>
  f.db
    .query(
      "select read_books_payroll_payment_workspace($1,$2,$3,$4,$5,50) page",
      [
        organization,
        importId,
        review,
        before?.preparedAt ?? null,
        before?.id ?? null,
      ],
    )
    .then((r) => r.rows[0].page);
test("private attribution history pages tied dates exactly, finds an older selected revision, reports active/posted state, and enforces ACL and scope", async (t) => {
  const f = await fixture(t);
  await f.db.exec("begin");
  for (let n = 9000; n < 9055; n++) {
    await prep(f, n);
    if (n !== 9054)
      await f.db.query(
        "select withdraw_books_payroll_payment_review($1,$2,$3,$4)",
        [org, id(n), id(50), "Replaced with reviewed original attribution"],
      );
  }
  await f.db.exec("commit;set role service_role");
  const first = await read(f),
    second = await read(f, null, first.nextCursor);
  assert.equal(first.reviews.length, 50);
  assert.equal(second.reviews.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.reviews, ...second.reviews].map((r) => r.id)).size,
    55,
  );
  assert.equal(first.activeReviewId, id(9054));
  assert.equal(first.posted, false);
  const oldest = await read(f, id(9000));
  assert.equal(oldest.reviews[0].status, "withdrawn");
  assert.equal(oldest.reviews[0].id, id(9000));
  await assert.rejects(read(f, id(9999)), /unavailable for this import/);
  await assert.rejects(
    read(f, null, null, id(99)),
    /unavailable in organization/,
  );
  await assert.rejects(
    read(f, null, null, org, id(99)),
    /unavailable in organization/,
  );
  await assert.rejects(
    f.db.query(
      "select read_books_payroll_payment_workspace($1,$2,null,now(),null,50)",
      [org, id(6)],
    ),
    /Invalid/,
  );
  const acl = (
    await f.db.query(
      "select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') browser from pg_proc where proname='read_books_payroll_payment_workspace'",
    )
  ).rows[0];
  assert.deepEqual(acl, { prosecdef: false, anon: false, browser: false });
  await f.db.exec("reset role");
  await f.db.query("insert into books_payroll_postings values($1,$2,$3)", [
    id(9100),
    org,
    id(6),
  ]);
  assert.equal((await read(f)).posted, true);
  await f.db.exec("set role authenticated");
  await assert.rejects(read(f), /permission denied/);
});
test("history service gates private scope, verifies frozen proof without current blobs, denies wrong parent/review identity and retains withdrawn approval", async (t) => {
  const f = await fixture(t),
    p = await prep(f, 9000);
  await f.db.query(
    "select review_books_payroll_payment_review($1,$2,$3,$4,$5,$6)",
    [org, p.request.id, id(51), p.evidence, p.evidenceDigest, notes],
  );
  await f.db.query(
    "select withdraw_books_payroll_payment_review($1,$2,$3,$4)",
    [org, p.request.id, id(51), "Retain historical approved attribution"],
  );
  let actor = id(51),
    denied = false,
    tamper = false,
    foreign = false,
    calls = [];
  const service = {
    from() {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        async single() {
          return {
            data: (
              await f.db.query(
                "select * from books_payroll_imports where id=$1",
                [id(6)],
              )
            ).rows[0],
            error: null,
          };
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push("rpc");
      const r = await read(
        f,
        args.p_review_id,
        args.p_before_time
          ? { preparedAt: args.p_before_time, id: args.p_before_id }
          : null,
      );
      if (tamper) r.reviews[0].evidence_digest = "a".repeat(64);
      if (foreign) r.reviews[0].payroll_import_id = id(99);
      return { data: r, error: null };
    },
  };
  const original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "./payroll-draft-workspace")
        return {
          payrollDraftCursorSchema: require("zod")
            .z.object({
              preparedAt: require("zod").z.string().datetime({ offset: true }),
              id: require("zod").z.string().uuid(),
            })
            .strict(),
          requireProjectPayrollImportScope: async () => {
            calls.push("scope");
            if (denied) throw Error("Denied project payroll");
          },
        };
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({ orgId: org, userId: actor }),
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "./payroll-payment-reviews")
        return {
          reviewPayrollPaymentReview: async () => {
            calls.push("review");
          },
          withdrawPayrollPaymentReview: async () => {
            calls.push("withdraw");
          },
        };
      return original.call(this, name, ...args);
    };
    api = require("../lib/services/books/payroll-payment-workspace");
  } finally {
    Module._load = original;
  }
  const input = { projectId: id(4), importId: id(6), reviewId: id(9000) };
  denied = true;
  await assert.rejects(api.readProjectPayrollPaymentWorkspace(input), /Denied/);
  assert.deepEqual(calls, ["scope"]);
  denied = false;
  calls = [];
  const result = await api.readProjectPayrollPaymentWorkspace(input),
    row = result.reviews[0];
  assert.equal(row.status, "withdrawn");
  assert.equal(row.reviewedBy, id(51));
  assert.equal(row.canReview, false);
  assert.equal(row.canWithdraw, false);
  assert.equal(row.documents[0].versionId, id(71));
  assert.ok(!JSON.stringify(result).includes("storage_path"));
  assert.deepEqual(calls, ["scope", "rpc"]);
  tamper = true;
  await assert.rejects(
    api.readProjectPayrollPaymentWorkspace(input),
    /integrity/,
  );
  tamper = false;
  foreign = true;
  await assert.rejects(
    api.withdrawProjectPayrollPaymentAttribution({ ...input, notes }),
    /identity/,
  );
  assert.ok(!calls.includes("withdraw"));
  foreign = false;
  await f.db.query(
    "select withdraw_books_payroll_payment_review($1,$2,$3,$4)",
    [org, id(9000), id(51), "Retain historical approved attribution"],
  );
  const next = await prep(f, 9001);
  actor = id(50);
  const blocked = await api.readProjectPayrollPaymentWorkspace({
    ...input,
    reviewId: next.request.id,
  });
  assert.equal(blocked.reviews[0].canReview, false);
  actor = id(51);
  const eligible = await api.readProjectPayrollPaymentWorkspace({
    ...input,
    reviewId: next.request.id,
  });
  assert.equal(eligible.reviews[0].canReview, true);
  await f.db.query("insert into books_payroll_postings values($1,$2,$3)", [
    id(9100),
    org,
    id(6),
  ]);
  const posted = await api.readProjectPayrollPaymentWorkspace({
    ...input,
    reviewId: next.request.id,
  });
  assert.equal(posted.reviews[0].canWithdraw, false);
  assert.equal(posted.reviews[0].canReview, false);
});
