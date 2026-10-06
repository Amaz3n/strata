require("../../scripts/register-ts-node-test");
const fs = require("node:fs");
const {
  setup: base,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./books-native-posting-database");
async function setup(t) {
  const f = await base(t);
  await f.db.exec(
    "create table companies(id uuid primary key,org_id uuid);create table cost_codes(id uuid primary key,org_id uuid)",
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005013437_books_native_adjustment_ledger.sql",
      "utf8",
    ),
  );
  const context = await f.context();
  const request = {
    context,
    draft: {
      entryDate: context.entryDate,
      entryKind: "adjusting",
      memo: "Reviewed native accounting adjustment to project invoice",
      postingKey: "native-adjustment:" + id(200),
      projectionVersion: 1,
      policyVersion: 1,
      sourceType: context.sourceType,
      sourceId: context.sourceId,
      lines: [
        {
          accountCode: "1100",
          accountRole: "accountsReceivable",
          debitCents: 12000,
          creditCents: 0,
          projectId: id(70),
        },
        {
          accountCode: "4000",
          accountRole: "constructionRevenue",
          debitCents: 0,
          creditCents: 12000,
          projectId: id(70),
        },
      ],
    },
  };
  const prepare = (v = {}) =>
    f.rpc("prepare_books_native_adjustment", [
      v.org ?? org,
      v.entity ?? entity,
      v.project ?? id(70),
      v.actor ?? maker,
      v.id ?? id(200),
      JSON.stringify(v.request ?? request),
      v.notes ?? notes,
    ]);
  const review = (v = {}) =>
    f.rpc("review_books_native_adjustment", [
      v.org ?? org,
      v.entity ?? entity,
      v.project ?? id(70),
      v.fact ?? id(200),
      v.id ?? id(201),
      v.actor ?? reviewer,
      v.decision ?? "approve",
      v.entry === undefined ? id(202) : v.entry,
      v.notes ?? notes,
    ]);
  return { ...f, request, prepare, review };
}
module.exports = { setup, id, org, entity, maker, reviewer, notes };
