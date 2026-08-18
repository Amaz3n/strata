"use strict"

/**
 * An in-memory stand-in for the PostgREST client, big enough to run the start
 * release orchestrator end to end.
 *
 * It is deliberately literal about the things the orchestrator depends on for
 * correctness: filters (including json paths like `metadata->>release_lease_token`)
 * narrow an UPDATE the way the server does, `.select()` after an update returns
 * only the rows that actually matched, and every operation yields to the
 * microtask queue so two concurrent workers interleave the way they do in
 * production. A conditional update that silently matched everything would make
 * the lease and claim tests pass for the wrong reason.
 */

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** `metadata->>token`, `data->a->>b`, or a plain column. */
function readPath(row, key) {
  if (!key.includes("->")) return row[key]
  const segments = key.split("->")
  let current = row[segments[0].trim()]
  for (const raw of segments.slice(1)) {
    const name = raw.startsWith(">") ? raw.slice(1) : raw
    if (current === null || current === undefined || typeof current !== "object") return null
    current = current[name]
  }
  return current === undefined ? null : current
}

function looseEqual(actual, expected) {
  if (actual === expected) return true
  if (actual === null || actual === undefined || expected === null || expected === undefined) return false
  return String(actual) === String(expected)
}

function applyOperator(actual, operator, value) {
  switch (operator) {
    case "eq": return looseEqual(actual, value)
    case "neq": return !looseEqual(actual, value)
    case "is": return value === null || value === "null" ? actual === null || actual === undefined : actual === value
    case "in": return (Array.isArray(value) ? value : parseList(value)).some((entry) => looseEqual(actual, entry))
    case "lt": return actual !== null && actual !== undefined && actual < value
    case "lte": return actual !== null && actual !== undefined && actual <= value
    case "gt": return actual !== null && actual !== undefined && actual > value
    case "gte": return actual !== null && actual !== undefined && actual >= value
    default: throw new Error(`fake-supabase: unsupported operator "${operator}"`)
  }
}

function parseList(value) {
  return String(value).replace(/^\(|\)$/g, "").split(",").map((entry) => entry.trim())
}

/** Splits on commas that are not inside `and(...)` / `or(...)`. */
function splitTopLevel(expression) {
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

function matchesExpression(row, expression) {
  const term = expression.trim()
  if (term.startsWith("and(")) {
    return splitTopLevel(term.slice(4, -1)).every((inner) => matchesExpression(row, inner))
  }
  if (term.startsWith("or(")) {
    return splitTopLevel(term.slice(3, -1)).some((inner) => matchesExpression(row, inner))
  }
  const firstDot = term.indexOf(".")
  const secondDot = term.indexOf(".", firstDot + 1)
  const column = term.slice(0, firstDot)
  const operator = term.slice(firstDot + 1, secondDot)
  const raw = term.slice(secondDot + 1)
  return applyOperator(readPath(row, column), operator, raw === "null" ? null : raw)
}

class Query {
  constructor(store, table) {
    this.store = store
    this.table = table
    this.filters = []
    this.action = null
    this.returning = false
    this.payload = null
    this.upsertOptions = null
    this.countMode = null
    this.head = false
    this.orderings = []
    this.limitValue = null
    this.rangeValue = null
    this.cardinality = null
  }

  rows() {
    if (!this.store[this.table]) this.store[this.table] = []
    return this.store[this.table]
  }

  addFilter(predicate) {
    this.filters.push(predicate)
    return this
  }

  select(_columns, options = {}) {
    if (this.action === null) this.action = "select"
    this.returning = true
    if (options.count) this.countMode = options.count
    if (options.head) this.head = true
    return this
  }

  insert(payload) { this.action = "insert"; this.payload = payload; return this }
  update(payload) { this.action = "update"; this.payload = payload; return this }
  delete() { this.action = "delete"; return this }
  upsert(payload, options = {}) { this.action = "upsert"; this.payload = payload; this.upsertOptions = options; return this }

  eq(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "eq", value)) }
  neq(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "neq", value)) }
  is(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "is", value)) }
  in(column, values) { return this.addFilter((row) => applyOperator(readPath(row, column), "in", values)) }
  lt(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "lt", value)) }
  lte(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "lte", value)) }
  gt(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "gt", value)) }
  gte(column, value) { return this.addFilter((row) => applyOperator(readPath(row, column), "gte", value)) }
  not(column, operator, value) {
    return this.addFilter((row) => !applyOperator(readPath(row, column), operator, value))
  }
  or(expression) {
    return this.addFilter((row) => splitTopLevel(expression).some((term) => matchesExpression(row, term)))
  }
  contains(column, value) {
    return this.addFilter((row) => {
      const actual = readPath(row, column)
      if (!actual || typeof actual !== "object") return false
      return Object.entries(value).every(([key, entry]) => looseEqual(actual[key], entry))
    })
  }

  order(column, options = {}) { this.orderings.push({ column, ascending: options.ascending !== false }); return this }
  limit(value) { this.limitValue = value; return this }
  range(from, to) { this.rangeValue = [from, to]; return this }
  single() { this.cardinality = "single"; return this }
  maybeSingle() { this.cardinality = "maybe"; return this }

  matched() {
    return this.rows().filter((row) => this.filters.every((predicate) => predicate(row)))
  }

  run() {
    const rows = this.rows()
    if (this.action === "insert" || this.action === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload]
      const conflict = this.upsertOptions?.onConflict?.split(",").map((column) => column.trim()) ?? []
      const written = []
      for (const entry of incoming) {
        const existing = conflict.length
          ? rows.find((row) => conflict.every((column) => looseEqual(row[column], entry[column])))
          : undefined
        if (existing && this.upsertOptions?.ignoreDuplicates) { written.push(existing); continue }
        if (existing) { Object.assign(existing, clone(entry)); written.push(existing); continue }
        const created = { id: entry.id ?? `${this.table}-${rows.length + 1}`, ...clone(entry) }
        rows.push(created)
        written.push(created)
      }
      return { data: this.returning ? clone(written) : null, error: null }
    }
    const matched = this.matched()
    if (this.action === "update") {
      for (const row of matched) Object.assign(row, clone(this.payload))
      return { data: this.returning ? clone(matched) : null, error: null }
    }
    if (this.action === "delete") {
      for (const row of matched) rows.splice(rows.indexOf(row), 1)
      return { data: this.returning ? clone(matched) : null, error: null }
    }
    const count = matched.length
    if (this.head) return { data: null, count, error: null }
    let result = clone(matched)
    for (const ordering of [...this.orderings].reverse()) {
      result.sort((a, b) => {
        const left = readPath(a, ordering.column)
        const right = readPath(b, ordering.column)
        if (left === right) return 0
        const direction = left === null ? 1 : right === null ? -1 : left < right ? -1 : 1
        return ordering.ascending ? direction : -direction
      })
    }
    if (this.rangeValue) result = result.slice(this.rangeValue[0], this.rangeValue[1] + 1)
    if (this.limitValue !== null) result = result.slice(0, this.limitValue)
    if (this.cardinality === "single") {
      if (result.length !== 1) return { data: null, error: { message: "expected exactly one row" }, count }
      return { data: result[0], error: null, count }
    }
    if (this.cardinality === "maybe") {
      if (result.length > 1) return { data: null, error: { message: "expected at most one row" }, count }
      return { data: result[0] ?? null, error: null, count }
    }
    return { data: result, error: null, count }
  }

  then(resolve, reject) {
    // Every operation yields first, so two workers driving the same store
    // interleave exactly where real awaits would let them.
    return Promise.resolve().then(() => this.run()).then(resolve, reject)
  }
}

function createFakeSupabase(tables = {}, rpcHandlers = {}) {
  const store = clone(tables)
  return {
    store,
    from(table) { return new Query(store, table) },
    async rpc(name, args) {
      await Promise.resolve()
      const handler = rpcHandlers[name]
      if (!handler) throw new Error(`fake-supabase: no handler for rpc "${name}"`)
      return handler(args, store)
    },
  }
}

module.exports = { createFakeSupabase, readPath }
