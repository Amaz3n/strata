// TRADE-01 — what a trade is told and what it answers, as the coordinator and the trade see it
// (EP07-05 through EP07-09). Two subcase modules, each with the org it needs:
//
//   trade-01-notices.cjs    EP07-05 failed notices are visible and resendable; EP07-06 the look-ahead
//                           holds only live work and infers a vendor only from an approved order;
//                           EP07-07 a notice is frozen with its recipients and sent once, and digests
//                           coalesce without losing a move
//   trade-01-schedule.cjs   EP07-08 a trade accepts, declines or asks to move issued work and the
//                           coordinator resolves it; EP07-09 a bulk move recomputes dependents in one
//                           transaction and a slipped promised close is approved before it lands
//
// Expected values are in expected/TRADE-01.json, each subcase's derived from the inputs its module names.
const notices = require("./trade-01-notices.cjs")
const schedule = require("./trade-01-schedule.cjs")

module.exports = {
  id: "TRADE-01",
  subcases: { ...notices.subcases, ...schedule.subcases },
}
