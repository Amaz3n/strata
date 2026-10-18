// MONEY-01 — production money (EP10): land and house cost corrections in the ledger, and the cash forecast and
// margin reports read from it. Two subcase modules:
//
//   money-01-ledger.cjs    EP10-02 a reversed land acquisition or start transfer is corrected and keeps its receipts;
//                          spec homes carry no placeholder contract; the superintendent reads scope and options
//   money-01-reports.cjs   EP10-03/04/05 the cash forecast and the home and community margin reports
//
// Expected values are in expected/MONEY-01.json, each subcase's derived from the inputs its module names.
const ledger = require("./money-01-ledger.cjs")
const reports = require("./money-01-reports.cjs")

module.exports = {
  id: "MONEY-01",
  subcases: { ...ledger.subcases, ...reports.subcases },
}
