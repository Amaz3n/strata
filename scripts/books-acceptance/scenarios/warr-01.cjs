// WARR-01 — warranty (EP11). Subcase modules:
//
//   warr-01-import.cjs  EP11-01/07  homes that closed before Arc come in with their dates and terms and reconcile; warranty
//                                   reserve, approved cost, vendor credit and recovery reconcile to accepted work
//   warr-01-ops.cjs     EP11-03..06 routing, scheduling, buyer confirmation, verification and backcharge settlement
//
// Expected values are in expected/WARR-01.json, each subcase's derived from the inputs it names.
const fs = require("node:fs")
const path = require("node:path")
const imports = require("./warr-01-import.cjs")
const ops = fs.existsSync(path.join(__dirname, "warr-01-ops.cjs")) ? require("./warr-01-ops.cjs") : { subcases: {} }

module.exports = {
  id: "WARR-01",
  subcases: { ...ops.subcases, ...imports.subcases },
}
