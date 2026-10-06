require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { warrantyDeskPage, warrantyDeskUrlPage, warrantyDispatchWeek } = require('../lib/warranty/desk-query')
test('warranty pagination rejects fractional, infinite, unsafe and malformed URL offsets', () => {
  for (const page of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) assert.equal(warrantyDeskPage(page).page, 1)
  for (const size of [NaN, Infinity, -1, 0, 1.5]) assert.equal(warrantyDeskPage(2, size).pageSize, 100)
  for (const page of ['2junk', '1.5', '-1', '0', 'Infinity', '99999999999999999999']) assert.equal(warrantyDeskUrlPage(page), 1)
  assert.equal(warrantyDeskUrlPage('13'), 13)
  assert.deepEqual(warrantyDeskPage(3, 500), { page: 3, pageSize: 200, from: 400, to: 599 })
})
test('dispatch weeks round trip as UTC calendar dates across year and daylight-saving boundaries', () => {
  assert.deepEqual(warrantyDispatchWeek('2026-10-08'), { from: '2026-10-04T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', week: '2026-10-04', previous: '2026-09-27', next: '2026-10-11' })
  assert.equal(warrantyDispatchWeek('2026-01-01').week, '2025-12-28')
  const dst = warrantyDispatchWeek('2026-11-01')
  assert.equal(Date.parse(dst.to) - Date.parse(dst.from), 7 * 86400000)
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-2', 'invalid', '9999-12-31']) assert.equal(warrantyDispatchWeek(bad, new Date('2026-10-08T23:59:00Z')).week, '2026-10-04')
})

test('warranty filters reset page and preserve unrelated scope and week query parameters', () => {
  const { warrantyQueueFilterHref, warrantyQueueSlaFilter } = require('../lib/warranty/desk-query')
  const url = new URL(warrantyQueueFilterHref('tab=dispatch&page=9&division=d&community=c&week=2026-10-04', '  Home (A), "west"  ', 'breached'), 'https://local.invalid')
  assert.equal(url.searchParams.get('search'), 'Home (A), "west"')
  assert.equal(url.searchParams.get('sla'), 'breached');assert.equal(url.searchParams.has('page'), false)
  assert.equal(url.searchParams.get('division'), 'd');assert.equal(url.searchParams.get('community'), 'c');assert.equal(url.searchParams.get('week'), '2026-10-04')
  const cleared = new URL(warrantyQueueFilterHref(url.search, '', 'all'), 'https://local.invalid')
  assert.equal(cleared.searchParams.has('search'), false);assert.equal(cleared.searchParams.has('sla'), false)
  assert.equal(warrantyQueueSlaFilter('unknown'), 'all')
})
test('warranty search terms retain punctuation as literal PostgreSQL regex values', async t => {
  const { PGlite } = require('@electric-sql/pglite')
  const { warrantyDeskSearchPattern, quoteWarrantySearchPattern, normalizeWarrantyDeskSearch } = require('../lib/warranty/desk-query')
  const db = new PGlite();t.after(() => db.close())
  for (const text of ['Home (A), "west"', '50%_off*', 'A.B+$[x]?^', 'C:\\Homes', 'house),status.eq.closed,or(']) {
    const pattern = warrantyDeskSearchPattern(text)
    assert.equal((await db.query('select $1::text ~* $2::text as found', [`prefix ${text.toUpperCase()} suffix`, pattern])).rows[0].found, true)
    assert.equal((await db.query('select $1::text ~* $2::text as found', ['unrelated house', pattern])).rows[0].found, false)
    // The quoted PostgREST value round trips through backslash/quote escaping.
    const quoted = quoteWarrantySearchPattern(pattern)
    const decoded = quoted.slice(1, -1).replace(/\\([\\"])/g, '$1')
    assert.equal(decoded, pattern)
  }
  assert.equal(normalizeWarrantyDeskSearch('  Home\n  12\tWest  '), 'Home 12 West')
  assert.throws(() => normalizeWarrantyDeskSearch('x'.repeat(201)), /200 characters/)
  assert.throws(() => normalizeWarrantyDeskSearch('null\u0000text'), /control characters/)
})

test('repeated Next.js URL keys have a deterministic first value', () => {
  const { warrantyDeskUrlValue } = require('../lib/warranty/desk-query')
  assert.equal(warrantyDeskUrlValue(['west', 'east']), 'west')
  assert.equal(warrantyDeskUrlValue([]), undefined)
  assert.equal(warrantyDeskUrlValue('west'), 'west')
})
