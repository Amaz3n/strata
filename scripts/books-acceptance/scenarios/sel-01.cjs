// SEL-01 — a buyer's selections from the design studio to the change order, as the roles that own
// each step see it (EP06-01 through EP06-05). Two subcase modules, each with the org it needs so no
// subcase leans on another's state or on LOT-01's lots:
//
//   sel-01-studio.cjs   EP06-01 design studio sessions on consultant and room capacity, in the
//                       studio's hours, with buyer notices; EP06-02 buyer approval binds the exact
//                       selections and prices sent (one org: "SEL-01 design studio", a home per subcase)
//   sel-01-supply.cjs   EP06-03 cutoffs held by the database in the community's day; EP06-04 lead
//                       times and released procurement; EP06-05 an approved selection change lands
//                       everywhere at once (one org: "SEL-01 supply", a home per subcase)
//
// Expected values are in expected/SEL-01.json, each subcase's derived from the inputs its module names.
const studio = require("./sel-01-studio.cjs")
const supply = require("./sel-01-supply.cjs")

module.exports = {
  id: "SEL-01",
  subcases: { ...studio.subcases, ...supply.subcases },
}
