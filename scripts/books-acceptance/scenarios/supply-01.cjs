// SUPPLY-01 — what a vendor is bound to and what actually arrives, as purchasing, the field and the
// vendor see it (EP08-08, EP08-10). Two subcase modules:
//
//   supply-01-ack.cjs        EP08-08 an approved purchase order is locked and issued as a numbered
//                            version; the vendor accepts or disputes it in the portal; a VPO asks again
//   supply-01-delivery.cjs   EP08-10 partial receipts and shortages by home and line, written only through
//                            the service; late deliveries become shortages and schedule advisories;
//                            purchasing resolves them with a back-order or a VPO
//
// Expected values are in expected/SUPPLY-01.json, each subcase's derived from the inputs its module names.
const ack = require("./supply-01-ack.cjs")
const delivery = require("./supply-01-delivery.cjs")

module.exports = {
  id: "SUPPLY-01",
  subcases: { ...ack.subcases, ...delivery.subcases },
}
