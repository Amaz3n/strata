require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { DailyLogDayCache } = require('../lib/daily-logs/day-cache')

test('invalidating during a read refetches rather than restoring stale attachments', async () => {
  const cache = new DailyLogDayCache()
  let release
  let calls = 0
  const request = cache.load('today', async () => {
    calls++
    if (calls === 1) return new Promise((resolve) => { release = resolve })
    return ['new photo']
  })
  cache.invalidate('today')
  release([])
  assert.deepEqual(await request, ['new photo'])
  assert.equal(calls, 2)
})

test('an edit on a day left behind invalidates that cached day', async () => {
  const cache = new DailyLogDayCache('yesterday', ['old note'])
  cache.set('today', [])
  cache.invalidate('yesterday')
  assert.deepEqual(await cache.load('yesterday', async () => ['updated note']), ['updated note'])
})

test('prefetch and navigation share one request and cached revisits need no read', async () => {
  const cache = new DailyLogDayCache()
  let reads = 0
  const loader = async () => { reads++; return ['log'] }
  assert.deepEqual(await Promise.all([cache.load('today',loader), cache.load('today',loader)]), [['log'],['log']])
  await cache.load('today',loader)
  assert.equal(reads, 1)
})
