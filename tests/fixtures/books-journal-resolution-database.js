const fs = require("node:fs");
const { fixture: base, id } = require("./books-journal-database");
async function fixture(t) {
  const f = await base(t);
  await f.db.exec(
    `create function capture_books_export_snapshot(p_org_id uuid) returns jsonb language sql stable as $$select jsonb_build_object('orgId',p_org_id,'tables',jsonb_build_object('books_journal_proposals',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from books_journal_proposals p where org_id=p_org_id)))$$;`,
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004211129_books_journal_request_resolutions.sql",
      "utf8",
    ),
  );
  const prep = {
    expectedOrgId: id(1),
    expectedActorId: id(2),
    intentId: id(10),
    entryDate: "2026-10-01",
    memo: "Original accrual",
    reversingOn: null,
    lines: f.lines.map((l) => ({
      accountCode: l.account_code,
      description: l.description,
      debitCents: l.debit_cents,
      creditCents: l.credit_cents,
      dimensions: l.dimensions,
    })),
  };
  const resolve = async (kind, request, overrides = {}) => {
    const p = {
      org: id(1),
      actor: kind === "prepare" ? id(2) : id(7),
      key: id(50),
      reason: "Original request no longer needed",
      ...overrides,
    };
    return (
      await f.db.query(
        "select resolve_books_journal_request_atomic($1,$2,$3,$4,$5::jsonb,$6) result",
        [p.org, p.actor, p.key, kind, JSON.stringify(request), p.reason],
      )
    ).rows[0].result;
  };
  const req = (proposal) => ({
    expectedOrgId: id(1),
    expectedActorId: id(7),
    proposalId: proposal,
    decision: "approve",
    note: "Checked evidence",
  });
  return { ...f, prep, resolve, req };
}
module.exports = { fixture, id };
