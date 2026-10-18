"use strict"

/**
 * A PostgREST client that records every query it is given and answers from a
 * function, for tests that must prove which filters a service applied (a scope
 * wall, a page range) rather than what a fake database returns for them.
 *
 *   const { client, calls } = createQueryRecorder((call) => ({ data: [], count: 0, error: null }))
 *
 * Each call is `{ table, columns, options, filters: [[op, ...args]], range }`.
 * The answer function receives the finished call and returns the response.
 */
function createQueryRecorder(answer) {
  const calls = []
  const client = {
    from(table) {
      const call = { table, filters: [], range: null, columns: null, options: null }
      calls.push(call)
      const filter = (op) => (...args) => {
        call.filters.push([op, ...args])
        return query
      }
      const query = {
        select(columns, options) {
          call.columns = columns
          call.options = options
          return query
        },
        eq: filter("eq"),
        neq: filter("neq"),
        not: filter("not"),
        ilike: filter("ilike"),
        in: filter("in"),
        or: filter("or"),
        order: filter("order"),
        maybeSingle() {
          return Promise.resolve(answer(call))
        },
        range(from, to) {
          call.range = [from, to]
          return query
        },
        then(resolve, reject) {
          return Promise.resolve(answer(call)).then(resolve, reject)
        },
      }
      return query
    },
  }
  return { client, calls }
}

module.exports = { createQueryRecorder }
