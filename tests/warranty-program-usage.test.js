const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
// Execute the actual reader and its actual program mapper without unrelated module
// initialization. Context/permission/default-seed seams are intentionally substituted.
function harness({ allowed = true, result } = {}) {
  const calls = [], orgId = 'org-a'
  const db = createFakeSupabase({
    warranty_programs: [
      { id: 'used', org_id: orgId, name: 'Used', terms: [] },
      { id: 'empty', org_id: orgId, name: 'Unused', terms: [] },
      { id: 'foreign', org_id: 'org-b', name: 'Other organization', terms: [] },
    ],
    project_warranty_coverage: [
      { id: 'one', org_id: orgId, program_id: 'used' },
      { id: 'two', org_id: orgId, program_id: 'used' },
      { id: 'foreign-same-program', org_id: 'org-b', program_id: 'used' },
    ],
  })
  const client = { from(table) {
    calls.push(table)
    const query = db.from(table)
    if (table === 'project_warranty_coverage') {
      const select = query.select.bind(query)
      query.select = (...args) => { assert.deepEqual(args, ['id', { count: 'exact', head: true }]); return select(...args) }
      if (result) query.then = async resolve => resolve(result)
    }
    return query
  } }
  const source = fs.readFileSync('lib/services/warranty-operations.ts', 'utf8')
  const ast = ts.createSourceFile('reader.ts', source, ts.ScriptTarget.Latest, true)
  const chosen = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['listWarrantyPrograms', 'loadPrograms'].includes(node.name?.text))
  assert.equal(chosen.length, 2)
  const code = ts.transpileModule(chosen.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'ensureWarrantyDefaults', code)(exports,
    async requested => { calls.push({ requested }); return { orgId, userId: 'actor', supabase: client } },
    async (permission, context) => { calls.push({ permission, orgId: context.orgId }); if (!allowed) throw Error('Forbidden') },
    async (_, org) => { calls.push({ defaults: org }) },
  )
  return { read: exports.listWarrantyPrograms, calls }
}

test('program usage distinguishes real zero from positive usage and excludes another org', async () => {
  const h = harness(), programs = await h.read('org-a')
  assert.equal(programs.length, 2)
  assert.equal(programs.find(program => program.id === 'used').enrolled_count, 2)
  assert.equal(programs.find(program => program.id === 'empty').enrolled_count, 0)
  assert.ok(h.calls.some(call => call.permission === 'warranty.manage' && call.orgId === 'org-a'))
})
test('denied program reads do not seed defaults or query program/coverage data', async () => {
  const h = harness({ allowed: false })
  await assert.rejects(h.read(), /Forbidden/)
  assert.ok(!h.calls.some(call => typeof call === 'string' || call.defaults))
})
test('failed exact usage queries reject the library rather than displaying unused programs', async () => {
  const h = harness({ result: { data: null, count: null, error: { message: 'Usage query unavailable' } } })
  await assert.rejects(h.read(), /Failed to load warranty program usage: Usage query unavailable/)
})
for (const count of [null, undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) test(`invalid or missing count ${String(count)} is unavailable rather than zero`, async () => {
  await assert.rejects(harness({ result: { data: null, count, error: null } }).read(), /usage is unavailable/)
})
test('a large exact count uses the aggregate response without requesting coverage bodies', async () => {
  const programs = await harness({ result: { data: null, count: 50000, error: null } }).read()
  assert.ok(programs.every(program => program.enrolled_count === 50000))
})

test('warranty settings failure retries its server read without rendering private query details', () => {
  const React = require('react'), exports = {}
  const code = ts.transpileModule(fs.readFileSync('app/(app)/settings/warranty/error.tsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function('exports', 'require', code)(exports, name => name === 'react/jsx-runtime' ? require(name) : { Button: 'button' })
  let called = false
  const tree = exports.default({ error: Error('Private coverage query details'), retry: () => { called = true } })
  const button = React.Children.toArray(tree.props.children.props.children).find(node => node.type === 'button')
  assert.equal(button.props.children, 'Try again')
  button.props.onClick()
  assert.equal(called, true)
  assert.ok(!JSON.stringify(tree).includes('Private coverage query details'))
})

function prepareHarness(targetResponse, punchResponse) {
  const source = fs.readFileSync('lib/services/warranty-operations.ts', 'utf8'), ast = ts.createSourceFile('reader.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareRequestData')
  const code = ts.transpileModule(fn.getText(ast) + '\nexport { prepareRequestData }', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const calls = [], exports = {}, queries = []
  const db = { from(table) {
    const query = { select(...args) { queries.push({ table, select: args }); return this }, eq(...args) { queries.push({ table, eq: args }); return this }, not() { return this }, maybeSingle() { return this }, then(resolve) { return Promise.resolve(table === 'warranty_sla_targets' ? targetResponse : punchResponse).then(resolve) } }
    return query
  } }
  new Function('exports', 'ensureWarrantyDefaults', 'loadCoverage', 'stampWarrantySla', 'shouldFlagWarrantyCostDump', 'classifyCoverage', 'DEFAULT_SLAS', code)(exports,
    async () => {}, async () => ({ effective_date: '2026-10-01' }),
    (_, target) => { calls.push({ sla: target }); return {} },
    evidence => { calls.push({ evidence }); return evidence.openPunchCount > 0 },
    () => 'covered', [{ severity: 'routine_30', first_response_hours: 72, resolution_days: 30 }],
  )
  return { prepare: () => exports.prepareRequestData(db, 'org-a', 'home-a', { title: 'Request' }, 'office'), calls, queries }
}
for (const [label, target, punch] of [
  ['SLA read failure', { data: null, error: { message: 'Policy unavailable' } }, { count: 0, error: null }],
  ['punch read failure', { data: null, error: null }, { count: null, error: { message: 'Punch unavailable' } }],
  ['missing punch count', { data: null, error: null }, { count: null, error: null }],
]) test(`${label} prevents constructing a request with fabricated default evidence`, async () => {
  const h = prepareHarness(target, punch)
  await assert.rejects(h.prepare(), /Failed to load warranty|evidence is unavailable/)
  assert.deepEqual(h.calls, [])
})
test('confirmed punch evidence and SLA policy are bound to the original org and home', async () => {
  const target = { first_response_hours: 12, resolution_days: 5 }
  const h = prepareHarness({ data: target, error: null }, { count: 7, error: null }), result = await h.prepare()
  assert.equal(result.cost_dump_flag, true)
  assert.ok(result.metadata.cost_dump_reason.includes('7 open punch items'))
  assert.deepEqual(h.calls[0], { sla: target })
  assert.equal(h.calls[1].evidence.openPunchCount, 7)
  assert.ok(h.queries.some(query => query.table === 'punch_items' && query.eq?.[0] === 'org_id' && query.eq[1] === 'org-a'))
  assert.ok(h.queries.some(query => query.table === 'punch_items' && query.eq?.[0] === 'project_id' && query.eq[1] === 'home-a'))
})
