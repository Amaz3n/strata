require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), React = require('react')
const { costCodeHierarchyIssues: issues, costCodeHierarchyRows: rows, costCodeParentOptions: options } = require('../lib/cost-code-hierarchy')
const code = (id, parent = null, extra = {}) => ({ id, code: id, name: `Code ${id}`, org_id: 'original-org', parent_id: parent, is_active: true, ...extra })
test('normal hierarchy preserves deterministic preorder, depth and financial fields without mutating input', () => {
  const source = [code('b', 'a', { default_unit_cost_cents: 12345 }), code('c', 'b'), code('a'), code('d')], original = JSON.stringify(source)
  const result = rows(source); assert.deepEqual(result.map(r => [r.id, r.depth]), [['a', 0], ['b', 1], ['c', 2], ['d', 0]])
  assert.equal(result[1].default_unit_cost_cents, 12345); assert.equal(JSON.stringify(source), original)
})
test('legacy closed cycles, self-parent and dependent branches all remain visible exactly once with original ancestry', () => {
  const source = [code('a', 'b'), code('b', 'a'), code('c', 'b'), code('d', 'd'), code('e')]
  const result = rows(source); assert.equal(result.length, 5); assert.equal(new Set(result.map(r => r.id)).size, 5)
  assert.deepEqual(result.slice(0, 4).map(r => [r.hierarchyIssue, r.depth]), Array(4).fill(['cycle', 0]))
  assert.equal(result[0].parent_id, 'b'); assert.equal(result[1].parent_id, 'a'); assert.equal(result[4].hierarchyIssue, null)
})
test('missing ancestry is disclosed but filtering a valid parent does not invent corruption', () => {
  const source = [code('a'), code('b', 'a'), code('c', 'missing'), code('d', 'c')], analysis = issues(source)
  assert.equal(analysis.has('b'), false); assert.equal(analysis.get('c'), 'missing_parent'); assert.equal(analysis.get('d'), 'missing_parent')
  const result = rows([source[1], source[3]], analysis)
  assert.deepEqual(result.map(r => [r.id, r.depth, r.hierarchyIssue]), [['b', 0, null], ['d', 0, 'missing_parent']])
})
test('parent options exclude self and all descendants including archived links, cycles and incomplete branches', () => {
  const source = [code('a'), code('b', 'a', { is_active: false }), code('c', 'b'), code('d'), code('e', 'e'), code('f', 'missing')]
  assert.deepEqual(options(source, 'a').map(r => r.id), ['d'])
  assert.deepEqual(options(source).map(r => r.id), ['a', 'c', 'd'])
})
test('10000-deep legacy ancestry traverses and renders without recursion overflow or missing rows', () => {
  const source = Array.from({ length: 10000 }, (_, i) => code(String(i).padStart(5, '0'), i ? String(i - 1).padStart(5, '0') : null))
  const result = rows(source); assert.equal(result.length, 10000); assert.equal(result[9999].depth, 9999); assert.equal(issues(source).size, 0)
  assert.deepEqual(options(source, source[0].id), [])
  const selectable = options(source); assert.equal(selectable.length, 1000); assert.equal(selectable.at(-1).id, source[999].id)
})
function render(source, { canManage = true, query = '', edit = null } = {}) {
  let index = 0
  const setters = [], states = [query, 'active', 1, source, edit ? { mode: 'edit', code: edit } : { mode: 'closed' }, edit ? { ...edit, parent_id: edit.parent_id ?? '', default_markup_percent: '', cost_type: '', unit: '', division: '', category: '' } : undefined]
  const modules = {
    react: { ...React, useState: init => { const slot = index++; return [states[slot] ?? init, value => setters.push([slot, value])] }, useMemo: fn => fn(), useEffect: () => {}, useTransition: () => [false, fn => fn()] },
    'react/jsx-runtime': require('react/jsx-runtime'),
    '@/lib/types': {},
    '@/lib/cost-code-hierarchy': require('../lib/cost-code-hierarchy'),
    '@/lib/cost-types': require('../lib/cost-types'),
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/lib/action-result': { unwrapAction: result => result.data },
    '@/app/(app)/settings/cost-codes/actions': {},
    sonner: { toast: {} },
  }
  const leaves = new Proxy({}, { get: (_, key) => String(key) }), exports = {}, compiled = ts.transpileModule(fs.readFileSync('components/cost-codes/cost-code-manager.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function('exports', 'require', compiled)(exports, name => modules[name] ?? leaves)
  return { tree: exports.CostCodeManager({ costCodes: source, canManage }), setters }
}
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [] }
function copy(node) { return Array.isArray(node) ? node.map(copy).join('') : React.isValidElement(node) ? copy(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '' }
test('actual manager displays cyclic rows with repair labels and retains read-only mutation controls', () => {
  const source = [code('a', 'b'), code('b', 'a'), code('c')], h = render(source, { canManage: false }), tree = nodes(h.tree)
  assert.equal(tree.filter(n => n.type === 'tr' && n.props.onClick).length, 3)
  assert.equal(tree.filter(n => copy(n) === 'Parent hierarchy contains a cycle' && n.type === 'span').length, 2)
  const newCode = tree.find(n => n.type === 'Button' && copy(n).includes('New code')); assert.equal(newCode.props.disabled, true)
  const save = tree.find(n => n.type === 'Button' && copy(n) === 'Create'); assert.equal(save.props.disabled, true)
})
test('actual edit picker preserves invalid current parent, offers explicit repair and excludes invalid candidates', () => {
  const source = [code('a', 'b'), code('b', 'a'), code('c')], h = render(source, { edit: source[0] }), tree = nodes(h.tree)
  const parent = tree.find(n => n.type === 'Select' && n.props.value === 'b')
  assert.ok(parent); assert.ok(copy(parent).includes('Current parent unavailable'))
  assert.deepEqual(nodes(parent).filter(n => n.type === 'SelectItem').map(n => n.props.value), ['__none__', 'c'])
  assert.ok(copy(h.tree).includes('The saved parent stays unchanged until you save'))
  parent.props.onValueChange('__none__'); assert.equal(h.setters.at(-1)[0], 5)
  assert.equal(h.setters.at(-1)[1]({ parent_id: 'b' }).parent_id, '')
})
test('actual search preserves selected cycle row and filtered valid descendants without false corruption', () => {
  const source = [code('a', 'b'), code('b', 'a'), code('c'), code('d', 'c')]
  for (const [query, warning] of [['Code a', true], ['Code d', false]]) {
    const tree = nodes(render(source, { query }).tree), displayed = tree.filter(n => n.type === 'tr' && n.props.onClick)
    assert.equal(displayed.length, 1); assert.equal(copy(displayed[0]).includes('Parent hierarchy contains a cycle'), warning)
  }
})
