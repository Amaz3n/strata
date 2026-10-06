const fs = require("node:fs");
const base = require("./books-native-invoice-posting-database");
async function setup(t) {
  const f = await base.setup(t);
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005031613_books_native_invoice_request_resolutions.sql",
      "utf8",
    ),
  );
  const request = {
    expectedOrgId: base.org,
    expectedActorId: base.maker,
    id: base.id(700),
    entryId: base.id(701),
    economic: f.original,
    notes: base.notes,
  };
  const resolve = (v = {}) =>
    f.rpc("resolve_books_native_invoice_request", [
      v.org ?? base.org,
      v.entity ?? base.entity,
      v.project ?? base.id(70),
      v.actor ?? base.maker,
      v.id ?? base.id(740),
      JSON.stringify(v.request ?? request),
      v.reason ?? base.notes,
    ]);
  return { ...f, resolutionRequest: request, resolve };
}
module.exports = { ...base, setup };
