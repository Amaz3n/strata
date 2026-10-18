// SALE-01 — a production sale from the agreement to warranty, as the roles that own each step
// see it (EP05-03, EP05-04, EP05-05, EP05-06, EP05-07, EP05-10). Three subcase modules, each with
// the org it needs so no subcase leans on another's state or on LOT-01's lots:
//
//   sale-01-packet.cjs       EP05-03 agreement packets and their published versions; EP05-07
//                            buyer-signed change orders as the agreement's versions, and cancellation
//                            (one org: "SALE-01 agreement packets", fresh lots per subcase)
//   sale-01-milestones.cjs   EP05-04 signed contingencies, EP05-05 lender and title milestones and
//                            their signed feed, EP05-10 the certificate-of-occupancy gate and the
//                            warranty handoff (one org: "SALE-01 contingencies and milestones", lots 1-7)
//   sale-01-commissions.cjs  EP05-06 commission terms, settlement payables and reversal
//                            (a HOME-01 builder per subcase)
//
// Expected values are in expected/SALE-01.json, each subcase's derived from the inputs its module names.
const packet = require("./sale-01-packet.cjs")
const milestones = require("./sale-01-milestones.cjs")
const commissions = require("./sale-01-commissions.cjs")

module.exports = {
  id: "SALE-01",
  subcases: { ...packet.subcases, ...milestones.subcases, ...commissions.subcases },
}
