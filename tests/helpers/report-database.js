const assert = require("node:assert/strict")
function database(tables) {
  const value = (row, key) => key.split(".").reduce((v, part) => v?.[part], row)
  return { from(table) {
    let rows = [...(tables[table] ?? [])]
    const query = {
      select() { return query },
      eq(key, v) { rows = rows.filter(row => value(row, key) === v); return query },
      gt(key, v) { rows = rows.filter(row => value(row, key) > v); return query },
      gte(key, v) { rows = rows.filter(row => value(row, key) >= v); return query },
      lt(key, v) { rows = rows.filter(row => value(row, key) < v); return query },
      lte(key, v) { rows = rows.filter(row => value(row, key) <= v); return query },
      in(key, values) { rows = rows.filter(row => values.includes(value(row, key))); return query },
      not(key, op, v) { assert.equal(op, "is"); rows = rows.filter(row => value(row, key) != v); return query },
      or() { return query },
      order(key) { rows.sort((a,b) => String(value(a,key)).localeCompare(String(value(b,key)))); return query },
      range(from, to) { rows = rows.slice(from, to + 1); return query },
      then(resolve, reject) { return Promise.resolve({ data: rows.slice(0,1000), error: null }).then(resolve, reject) },
    }
    return query
  } }
}
module.exports = { database }
