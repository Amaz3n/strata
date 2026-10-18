require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { readAllRowsById } = require('../lib/land/paging')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
test('ID keyset exhausts short pages and proves an exact-cap set through an empty page', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: id(i + 1) })), calls = []
  const result = await readAllRowsById(async (cursor, take) => {
    calls.push({ cursor, take }); return { data: rows.filter(row => !cursor || row.id > cursor).slice(0, Math.min(take, 7)), error: null }
  }, { cap: 51, pageSize: 20, label: 'Configuration' })
  assert.deepEqual(result, rows); assert.equal(calls.at(-1).take, 1); assert.equal(calls.at(-1).cursor, id(51))
})
test('ID keyset rejects excess data, missing pages, duplicate/regressed IDs and provider errors', async () => {
  for (const response of [{ data: null, error: null }, { data: [{ id: id(2) }, { id: id(1) }], error: null }, { data: [{ id: id(1) }, { id: id(1) }], error: null }, { data: [{ id: '' }], error: null }, { data: [], error: { message: 'Offline' } }]) {
    await assert.rejects(readAllRowsById(async () => response, { cap: 10, pageSize: 2, label: 'Configuration' }))
  }
  await assert.rejects(readAllRowsById(async cursor => ({ data: [{ id: cursor ? id(2) : id(1) }], error: null }), { cap: 1, pageSize: 1, label: 'Configuration' }), /Validation limit exceeded/)
  await assert.rejects(readAllRowsById(async () => ({ data: [{ id: id(1) }, { id: id(2) }, { id: id(3) }], error: null }), { cap: 5, pageSize: 2, label: 'Configuration' }), /Invalid page/)
  for (const cap of [0, -1, 1.5, NaN]) await assert.rejects(readAllRowsById(async () => { throw Error('Must not read') }, { cap, label: 'Configuration' }), /Invalid paging/)
})
