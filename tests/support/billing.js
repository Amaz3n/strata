"use strict"

/**
 * PostgREST filters the shared fake does not speak yet, added to a service
 * harness for the billing and payables suites:
 *
 *   - `.ilike(column, pattern)` — case-insensitive LIKE (`%`, `_`);
 *   - `.or(...)` terms using `ilike`, `like` and negation (`project_id.not.in.(a,b)`);
 *   - range filters on an embedded row (`.gte("payment.received_at", start)`).
 *
 * Candidates to fold into tests/support/fake-supabase.js.
 */

const { readPath } = require("./fake-supabase")

function likeExpression(pattern, flags) {
  const source = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".")
  return new RegExp(`^${source}$`, flags)
}

const list = (value) =>
  String(value)
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((entry) => entry.trim())

function compare(actual, operator, value) {
  const missing = actual === null || actual === undefined
  switch (operator) {
    case "eq":
      return !missing && String(actual) === String(value)
    case "neq":
      return missing || String(actual) !== String(value)
    case "is":
      return value === "null" || value === null ? missing : String(actual) === String(value)
    case "in":
      return !missing && list(value).includes(String(actual))
    case "lt":
      return !missing && actual < value
    case "lte":
      return !missing && actual <= value
    case "gt":
      return !missing && actual > value
    case "gte":
      return !missing && actual >= value
    case "like":
      return !missing && likeExpression(value, "").test(String(actual))
    case "ilike":
      return !missing && likeExpression(value, "i").test(String(actual))
    default:
      throw new Error(`support/billing: unsupported operator "${operator}"`)
  }
}

/** Splits on commas that are not inside parentheses. */
function topLevel(expression) {
  const parts = []
  let depth = 0
  let current = ""
  for (const character of expression) {
    if (character === "(") depth += 1
    if (character === ")") depth -= 1
    if (character === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (current) parts.push(current)
  return parts
}

function matches(row, term) {
  const text = term.trim()
  if (text.startsWith("and(")) return topLevel(text.slice(4, -1)).every((inner) => matches(row, inner))
  if (text.startsWith("or(")) return topLevel(text.slice(3, -1)).some((inner) => matches(row, inner))
  const [column, operator, ...rest] = text.split(".")
  if (operator === "not") {
    const [negated, ...value] = rest
    return !compare(readPath(row, column), negated, value.join("."))
  }
  return compare(readPath(row, column), operator, rest.join("."))
}

function supportPostgrestFilters(service) {
  const from = service.client.from.bind(service.client)
  service.client.from = (table) => {
    const query = from(table)
    query.ilike = (column, pattern) => query.addFilter((row) => compare(readPath(row, column), "ilike", pattern))
    query.or = (expression) => query.addFilter((row) => topLevel(expression).some((term) => matches(row, term)))
    for (const operator of ["gt", "gte", "lt", "lte"]) {
      const original = query[operator].bind(query)
      query[operator] = (column, value) => {
        if (!column.includes(".") || column.includes("->")) return original(column, value)
        const [relation, field] = column.split(".")
        return query.addFilter((row) => {
          const related = Array.isArray(row[relation]) ? row[relation] : [row[relation]]
          return related.some((entry) => entry && compare(entry[field], operator, value))
        })
      }
    }
    return query
  }
  return service
}

module.exports = { supportPostgrestFilters }
