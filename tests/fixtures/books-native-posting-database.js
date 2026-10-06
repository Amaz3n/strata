require("../../scripts/register-ts-node-test");
const fs = require("node:fs");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./books-project-owner-database");
async function fixture(t) {
  const f = await setup(t);
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004215338_books_entity_fiscal_calendars.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005012051_books_native_project_posting_context.sql",
      "utf8",
    ),
  );
  await f.rpc("prepare_books_entity_chart", [
    org,
    entity,
    id(30),
    id(20),
    null,
    maker,
    "2026-01-01",
    JSON.stringify(
      require("../../lib/services/books/entity-chart").constructionEntityChart(),
    ),
    notes,
  ]);
  await f.rpc("review_books_entity_chart", [
    org,
    entity,
    id(30),
    id(40),
    reviewer,
    notes,
  ]);
  await f.rpc("prepare_books_entity_calendar", [
    org,
    entity,
    id(50),
    id(20),
    maker,
    2026,
    notes,
  ]);
  await f.rpc("review_books_entity_calendar", [
    org,
    entity,
    id(50),
    id(51),
    reviewer,
    notes,
  ]);
  await f.prepare();
  await f.review();
  await f.db.exec(
    `insert into invoices values('${id(100)}','${org}','${id(70)}');insert into vendor_bills values('${id(101)}','${org}','${id(70)}');insert into project_expenses values('${id(102)}','${org}','${id(70)}')`,
  );
  const context = (v = {}) =>
    f.rpc("read_books_native_project_posting_context", [
      v.org ?? org,
      v.project ?? id(70),
      v.type ?? "invoice",
      v.source ?? id(100),
      v.actor ?? maker,
      v.date ?? "2026-04-15",
    ]);
  return { ...f, context };
}

module.exports = { setup: fixture, id, org, entity, maker, reviewer, notes };
