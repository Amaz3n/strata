// CUTOVER-01 — a production builder's open work comes into Arc (EP12). Subcase modules:
//
//   cutover-01-resume.cjs   EP12-02/03  the Open-WIP house commit survives a crash, a retry and a race: each home is
//                                       built once with its receipt, a failed house leaves nothing behind, and the
//                                       batch completes only when its homes reconcile to the source files
//   cutover-01-records.cjs  EP12-04/05  agreements, executed documents and deposits; selections, cutoffs and inspections
//
// Expected values are in expected/CUTOVER-01.json, each subcase's derived from the inputs it names.
const fs = require("node:fs")
const path = require("node:path")
const resume = require("./cutover-01-resume.cjs")
const records = fs.existsSync(path.join(__dirname, "cutover-01-records.cjs")) ? require("./cutover-01-records.cjs") : { subcases: {} }

module.exports = {
  id: "CUTOVER-01",
  subcases: { ...resume.subcases, ...records.subcases },
}
