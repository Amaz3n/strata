"use strict"

/**
 * The sample production community: its original open-WIP house import (six
 * created receipts, their homes and lots) as the importer leaves it, for the
 * sample-home provenance and demo-community seed suites.
 *
 *   const { sampleTables, supportIlike, ids } = require("./support/sample-community")
 *   const service = createServiceHarness({ tables: sampleTables() })
 *   supportIlike(service)
 */

const { id, ORG, ACTOR } = require("./service")

const ids = {
  COMMUNITY: id(3),
  BATCH: id(4),
  OTHER: id(5),
  /** A WIP home from another import that must never be touched. */
  UNRELATED_HOME: id(99),
}

const LOTS = ["12", "13", "14", "15", "16", "17"]

/** The importer's receipts, homes and lots for the committed sample house batch. */
function sampleTables() {
  const { COMMUNITY, BATCH, OTHER, UNRELATED_HOME } = ids
  const receipts = LOTS.map((lot, i) => ({
    id: id(20 + i),
    org_id: ORG,
    batch_id: BATCH,
    row_number: i + 1,
    status: "committed",
    action: "created",
    target_entity_type: "open_wip",
    target_entity_id: id(40 + i),
    parsed: { community_id: COMMUNITY, lot_number: lot },
  }))
  const homes = receipts.map((row) => ({
    id: row.target_entity_id,
    org_id: ORG,
    metadata: {
      imported_open_wip: true,
      wip_cutover: { batch_id: BATCH, row_id: row.id, as_of_date: "2026-10-04" },
      untouched: { customer: "Original metadata" },
    },
  }))
  homes.push({
    id: UNRELATED_HOME,
    org_id: ORG,
    metadata: { imported_open_wip: true, wip_cutover: { batch_id: OTHER, row_id: OTHER }, production: true },
  })
  return {
    import_batches: [
      {
        id: BATCH,
        org_id: ORG,
        created_by: ACTOR,
        importer: "open_wip",
        status: "committed",
        context: { is_sample: true, file_kind: "houses" },
        row_count: 6,
        committed_count: 6,
        skipped_count: 0,
        error_count: 0,
      },
    ],
    import_rows: receipts,
    projects: homes,
    communities: [{ id: COMMUNITY, org_id: ORG, metadata: { is_sample: true } }],
    lots: receipts.map((row, i) => ({
      id: id(60 + i),
      org_id: ORG,
      community_id: COMMUNITY,
      project_id: row.target_entity_id,
      lot_number: LOTS[i],
    })),
  }
}

/**
 * The fake database has no `ilike`; this adds it to `.or()` for one harness,
 * as a case-insensitive whole-value match (the probes it serves use no `%`).
 * A candidate for tests/support/fake-supabase.js's operator table.
 */
function supportIlike(service) {
  const from = service.client.from.bind(service.client)
  service.client.from = (table) => {
    const query = from(table)
    const or = query.or.bind(query)
    query.or = (expression) => {
      if (!expression.includes(".ilike.")) return or(expression)
      const terms = expression.split(",").map((term) => {
        const [column, , ...value] = term.split(".")
        return { column, value: value.join(".").toLowerCase() }
      })
      return query.addFilter((row) => terms.some(({ column, value }) => String(row[column] ?? "").toLowerCase() === value))
    }
    return query
  }
  return service
}

module.exports = { ids, sampleTables, supportIlike }
