const fs = require("node:fs"),
  base = require("./books-native-invoice-income-database");
async function setup(t, initialize) {
  const f = await base.setup(t);
  for (const name of [
    "20261005111155_books_native_invoice_reversal_derivation.sql",
    "20261005112034_books_native_invoice_correction_proposals.sql",
    "20261005114131_books_native_invoice_correction_pair_derivation.sql",
    "20261005115400_books_native_invoice_replacement_proposals.sql",
    "20261005121818_books_invoice_quantity_export_text.sql",
    "20261005123119_books_native_invoice_correction_reviews.sql",
  ])
    await f.db.exec(fs.readFileSync("supabase/migrations/" + name, "utf8"));
  if (initialize) await initialize(f);
  const original = initialize ? await f.economic() : f.original;
  const money = await f.post({ economic: original });
  const request = {
    id: base.id(980),
    expectedOrgId: base.org,
    expectedActorId: base.maker,
    context: (await f.economic({ date: "2026-04-16" })).native,
    originalPostingId: money.posting.id,
    notes: base.notes,
  };
  const prepare = (q = request) =>
    f.rpc("prepare_books_native_invoice_correction", [
      base.org,
      base.entity,
      base.id(70),
      base.maker,
      JSON.stringify(q),
    ]);
  return { ...f, original, money, request, prepare };
}
module.exports = { ...base, setup };
