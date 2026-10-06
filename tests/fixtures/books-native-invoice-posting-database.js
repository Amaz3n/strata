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
} = require("./books-native-invoice-economic-database");
async function setup(t) {
  const f = await base(t);
  await f.db.exec(
    `alter table books_settings add column id uuid default '${id(605)}';alter table project_financial_settings add column id uuid default '${id(606)}'`,
  );
  await f.db.exec(
    "create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$",
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005023412_books_native_invoice_atomic_posting.sql",
      "utf8",
    ),
  );
  const economic = await f.economic();
  const post = (v = {}) =>
    f.rpc("post_books_native_invoice", [
      v.org ?? org,
      v.entity ?? entity,
      v.project ?? id(70),
      v.actor ?? maker,
      v.id ?? id(700),
      v.entry ?? id(701),
      JSON.stringify(v.economic ?? economic),
      v.notes ?? notes,
    ]);
  return { ...f, original: economic, post };
}
module.exports = { setup, id, org, entity, maker, reviewer, notes };
