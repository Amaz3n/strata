// FIELD-01 — what the field works from and records, as the superintendent, the trade and the office see
// it (EP09-03, EP09-04, EP09-06). Two subcase modules:
//
//   field-01-documents.cjs     EP09-03 a home's released drawings, options and scope, labelled by revision
//                              state for the superintendent and the trade; EP09-06 the cross-home review band
//   field-01-inspections.cjs   EP09-04 a failed inspection item becomes owned corrective work with evidence;
//                              reinspection keeps the prior result and resolves the original failure
//
// Expected values are in expected/FIELD-01.json, each subcase's derived from the inputs its module names.
const documents = require("./field-01-documents.cjs")
const inspections = require("./field-01-inspections.cjs")

module.exports = {
  id: "FIELD-01",
  subcases: { ...documents.subcases, ...inspections.subcases },
}
