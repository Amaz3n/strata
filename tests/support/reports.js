"use strict"

/**
 * Report-tier fixtures: a small report catalog in place of the real registry
 * (which loads every report Arc ships and takes seconds), and the Arc Books
 * module switch the workspace consults for `books-*` reports.
 *
 *   const reports = require("./support/reports")      // before freshRequire
 *   reports.reset({ booksEnabled: false })
 *   await evaluateReport(reports.definitions.ops, context)
 *   reports.lastRun().params                           // what the report received
 */

const { stubModule } = require("./modules")
const { ACTOR } = require("./service")

const BASE_RESULT = {
  tables: [
    {
      key: "data",
      columns: [
        { key: "name", header: "Name" },
        { key: "amount", header: "Amount", type: "money", aggregation: "sum" },
      ],
      rows: [{ key: "1", cells: { name: "A", amount: 100 } }],
    },
  ],
}

let state = { booksEnabled: true, runs: [] }

function definition(slug, permission) {
  return {
    slug,
    scopes: ["org", "project"],
    permissions: [permission],
    params: [{ key: "period", kind: "period" }],
    run: async (context) => {
      state.runs.push(structuredClone(context))
      return structuredClone(BASE_RESULT)
    },
  }
}

/** `ops` needs report.read, `books-test` books.read, `margin` financials.margin.read. */
const definitions = {
  ops: definition("ops", "report.read"),
  "books-test": definition("books-test", "books.read"),
  margin: definition("margin", "financials.margin.read"),
  "report-packet": definition("report-packet", "report.read"),
}

stubModule("@/lib/reports/registry", {
  getReportDefinition: (slug) => definitions[slug],
  supportsFormat: () => true,
})
stubModule("@/lib/services/books/module", {
  getBooksModuleSettings: async () => ({
    enabled: state.booksEnabled,
    settings: { ledger_authority: "arc", fiscal_year_start_month: 4 },
  }),
})
stubModule("@/lib/services/books/statement-detail", {
  getStatementsForPeriod: async () => {
    throw new Error("Statement reports are not part of the report fixtures")
  },
})

module.exports = {
  ACTOR,
  definitions,
  reset({ booksEnabled = true } = {}) {
    state = { booksEnabled, runs: [] }
  },
  lastRun: () => state.runs.at(-1),
}
