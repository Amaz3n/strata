require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const { parseInvoiceRecipients, isInvoiceRecipientValid } = require('../lib/invoices/composer-recipients')

function numberingFixture({ authority = 'arc', providerNumber = '100', providerFailure = false, invoices = [], reservations = [], databaseError = false } = {}) {
  const tables = { invoices: invoices.map((invoice_number, index) => ({ id: `i${index}`, org_id: 'org', invoice_number })), qbo_invoice_reservations: reservations }
  let externalCalls = 0
  let routedProject
  function from(table) {
    let filters = [], inserted, updated, offset = 0, end = Infinity, single = false
    const query = {
      select() { return query }, eq(k, v) { filters.push(row => row[k] === v); return query },
      lt(k, v) { filters.push(row => row[k] < v); return query }, order() { return query },
      range(a, b) { offset = a; end = b + 1; return query }, limit(n) { end = n; return query },
      insert(row) { inserted = row; return query }, update(row) { updated = row; return query },
      single() { single = true; return query },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (databaseError) return { data: null, error: { message: 'database unavailable' } }
          if (inserted) {
            if (tables[table].some(row => row.org_id === inserted.org_id && row.reserved_number === inserted.reserved_number && row.status === 'reserved')) return { data: null, error: { code: '23505' } }
            const row = { ...inserted, id: `r${tables[table].length}`, status: 'reserved' }
            tables[table].push(row)
            return { data: single ? row : [row], error: null }
          }
          const selected = tables[table].filter(row => filters.every(filter => filter(row))).slice(offset, end)
          if (updated) selected.forEach(row => Object.assign(row, updated))
          return { data: single ? selected[0] ?? null : selected, error: null }
        }).then(resolve, reject)
      },
    }
    return query
  }
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../lib/services/invoice-numbers.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(source, { exports, console, setTimeout, clearTimeout, require(name) {
    if (name.endsWith('/invoice-number-format')) return require('../lib/invoices/invoice-number-format')
    if (name.endsWith('/supabase/server')) return { createServiceSupabaseClient: () => ({ from }) }
    if (name.endsWith('/services/context')) return { requireOrgContext: async () => ({ orgId: 'org', userId: 'user' }) }
    if (name.endsWith('/books/authority')) return { resolveLedgerAuthority: async () => authority }
    if (name.endsWith('/accounting-target')) return { resolveAccountingTarget: async ({ projectId }) => { routedProject = projectId; return { connection: { id: 'connection', provider: 'qbo', settings: {} } } } }
    if (name.endsWith('/registry')) return { getProvider: () => ({ getLastInvoiceNumber: async () => { externalCalls++; if (providerFailure) throw new Error('offline'); return providerNumber } }) }
    throw new Error(`Unexpected dependency ${name}`)
  } })
  return { ...exports, tables, externalCalls: () => externalCalls, routedProject: () => routedProject }
}

test('pasted recipients are deduplicated and display names are extracted', () => {
  assert.deepEqual(parseInvoiceRecipients('Owner <owner@example.com>; OWNER@example.com\naccounting@example.com'), ['owner@example.com', 'accounting@example.com'])
  for (const bad of ['a@', 'a@b', 'owner name@example.com', 'name@example..com']) assert.equal(isInvoiceRecipientValid(bad), false, bad)
  assert.equal(isInvoiceRecipientValid('owner+job@example.com'), true)
})

test('number formats preserve arbitrary prefixes, padding, and large sequences', () => {
  const f = numberingFixture()
  assert.equal(f.incrementInvoiceNumber('0012'), '0013')
  assert.equal(f.incrementInvoiceNumber('JOB-2026/0099'), 'JOB-2026/0100')
  assert.equal(f.incrementInvoiceNumber('other', { invoice_number_pattern: 'prefix', invoice_number_prefix: 'INV-' }), 'INV-0001')
  assert.equal(f.incrementInvoiceNumber('9007199254740993'), '9007199254740994')
  assert.equal(f.compareInvoiceNumbers('9007199254740994', '9007199254740993'), 1)
})

test('Arc Books reserves unique numbers for simultaneous composers by the same user', async () => {
  const f = numberingFixture({ invoices: ['99', '12', '15'] })
  const results = await Promise.all(Array.from({ length: 12 }, () => f.getNextInvoiceNumber('org', 'project')))
  assert.equal(new Set(results.map(result => result.number)).size, 12)
  assert.ok(results.every(result => result.reservation_id && result.source === 'local'))
  assert.equal(f.externalCalls(), 0)
  assert.equal(f.routedProject(), undefined)
})

test('number cursor includes older and paginated invoices, plus used reservations', async () => {
  const f = numberingFixture({ invoices: [...Array.from({ length: 1000 }, (_, i) => String(i + 1)), '5000'], reservations: [{ id: 'old', org_id: 'org', status: 'used', reserved_number: '6000' }] })
  assert.equal((await f.getNextInvoiceNumber()).number, '6001')
})

test('external numbering is project-routed and coalesces reads without sharing reservations', async () => {
  const f = numberingFixture({ authority: 'external', providerNumber: 'INV-0100' })
  const results = await Promise.all([f.getNextInvoiceNumber('org', 'job'), f.getNextInvoiceNumber('org', 'job')])
  assert.equal(f.externalCalls(), 1)
  assert.equal(f.routedProject(), 'job')
  assert.equal(new Set(results.map(result => result.number)).size, 2)
  assert.ok(results.every(result => result.source === 'accounting'))
})

test('provider outage keeps a real local reservation and an explicit warning', async () => {
  const f = numberingFixture({ authority: 'external', providerFailure: true, invoices: ['INV-0200'] })
  const result = await f.getNextInvoiceNumber()
  assert.equal(result.number, 'INV-0201')
  assert.equal(result.source, 'local')
  assert.ok(result.reservation_id)
  assert.match(result.warning, /couldn't confirm/)
})

test('database errors fail closed instead of inventing an unreserved number', async () => {
  const f = numberingFixture({ databaseError: true })
  await assert.rejects(f.getNextInvoiceNumber(), /database unavailable/)
})

test('QBO number discovery reads beyond the newest page and compares numeric suffixes', async () => {
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../lib/integrations/accounting/qbo/client.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(source, { exports, console, require(name) {
    if (name.endsWith('/invoice-number-format')) return require('../lib/invoices/invoice-number-format')
    return {}
  } })
  const queries = []
  const result = await exports.QBOClient.prototype.getLastInvoiceNumber.call({ async request(method, path) {
    const query = decodeURIComponent(path)
    queries.push(query)
    return { QueryResponse: { Invoice: queries.length === 1 ? Array.from({ length: 1000 }, (_, i) => ({ DocNumber: `INV-${i + 1}` })) : [{ DocNumber: 'INV-9000' }] } }
  } })
  assert.equal(result, 'INV-9000')
  assert.equal(queries.length, 2)
  assert.match(queries[1], /STARTPOSITION 1001 MAXRESULTS 1000/)
  assert.equal(exports.pickHighestDocNumber(['INV-100', 'INV-99']), 'INV-100')
})

test('invoice preview preserves date-only fields in a US timezone', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { ArcInvoiceDocument } = require('../components/invoices/arc-invoice-document')
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const html = renderToStaticMarkup(React.createElement(ArcInvoiceDocument, { width: 816, height: 1056, lines: [], data: { invoiceNumber: 'INV-1', issueDate: '2026-09-06', dueDate: '2026-09-21', fromLines: [], billToLines: [], subtotalCents: 0, taxCents: 0, totalCents: 0 } }))
    assert.match(html, /September 6, 2026/)
    assert.match(html, /September 21, 2026/)
    assert.doesNotMatch(html, /September 5, 2026/)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
