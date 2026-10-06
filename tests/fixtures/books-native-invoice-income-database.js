const fs = require("node:fs");
const base = require("./books-native-invoice-resolution-database");
async function setup(t) {
  const f = await base.setup(t);
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005040543_books_native_invoice_income_selection.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005042334_books_native_invoice_income_archive.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005044458_books_native_invoice_income_resolutions.sql",
      "utf8",
    ),
  );
  const incomeRequest = {
    id: base.id(900),
    expectedOrgId: base.org,
    expectedActorId: base.maker,
    economic: await f.economic(),
    assignments: [{ lineId: base.id(602), accountId: null }],
    notes: base.notes,
  };
  const selectIncome = (q = incomeRequest) =>
    f.rpc("select_books_native_invoice_income", [
      base.org,
      base.entity,
      base.id(70),
      base.maker,
      JSON.stringify(q),
    ]);
  const resolveIncome = (
    q = incomeRequest,
    decision = base.id(950),
    reason = base.notes,
  ) =>
    f.rpc("resolve_books_native_invoice_income", [
      base.org,
      base.entity,
      base.id(70),
      base.maker,
      decision,
      JSON.stringify(q),
      reason,
    ]);
  return { ...f, incomeRequest, selectIncome, resolveIncome };
}
module.exports = { ...base, setup };
