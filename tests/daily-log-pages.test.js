require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { readDailyLogPages } = require('../lib/services/daily-log-pages')

test('daily read crosses the API page boundary without dropping historical records', async () => {
  const source = Array.from({ length: 425 }, (_, id) => ({ id }))
  const requests = []
  const result = await readDailyLogPages(async (from, to) => {
    requests.push([from, to])
    return { data: source.slice(from, to + 1), error: null }
  })
  assert.deepEqual(result.data, source)
  assert.deepEqual(requests, [[0,199], [200,399], [400,599]])
})

test('failed child page cannot masquerade as a complete or empty day', async () => {
  await assert.rejects(readDailyLogPages(async (from) => from === 0
    ? { data: Array.from({length:200}, (_,id) => ({id})), error: null }
    : { data:null, error: {message:'unavailable'} }), /unavailable/)
})

test('oversized ranges fail explicitly instead of silently truncating', async () => {
  await assert.rejects(readDailyLogPages(async () => ({ data:Array.from({length:200}, (_,id) => ({id})), error:null })), /shorter range/)
})
