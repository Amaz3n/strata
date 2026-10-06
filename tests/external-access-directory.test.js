const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
function load(states, revokeResult) {
  const exports = {}, calls = [], updates = [], messages = []
  let index = 0
  const code = ts.transpileModule(fs.readFileSync('components/sharing/external-access-directory.tsx', 'utf8') + '\nexport { ExternalAccessDirectory, PersonRow }', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const modules = {
    react: { ...React, useState: initial => { const slot = index++; return [states[slot] ?? initial, value => updates.push({ slot, value })] }, useCallback: fn => fn, useEffect: () => {} },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'date-fns': { formatDistanceToNow: () => 'just now' },
    sonner: { toast: { success: message => messages.push(message), error: message => messages.push(message) } },
    '@/lib/utils': { cn: (...items) => items.filter(Boolean).join(' ') },
    '@/lib/action-result': { unwrapAction: result => { if (!result.success) throw Error(result.error); return result.data } },
    '@/app/(app)/sharing/actions': {
      revokeOrgExternalPersonAction: async input => { calls.push({ revoke: input }); return revokeResult },
      loadOrgExternalAccessAction: async () => { calls.push('refresh'); return { people: [], truncated: false } },
    },
  }
  new Function('exports', 'require', code)(exports, name => modules[name] ?? new Proxy({}, { get: (_, key) => String(key) }))
  return { ...exports, calls, updates, messages }
}
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  return React.isValidElement(node) ? [node, ...nodes(node.props.children)] : []
}
const person = { key: 'person', name: 'Trade partner', projects: [
  { token_id: 'active', status: 'active', project_name: 'Home A' },
  { token_id: 'paused', status: 'paused', project_name: 'Home B' },
  { token_id: 'revoked', status: 'revoked', project_name: 'Home C' },
] }
for (const status of ['active', 'paused', 'expired', 'revoked']) test(`listed ${status} access has the correct removal availability`, () => {
  const h = load([]), tree = nodes(h.PersonRow({ person: { ...person, projects: [{ token_id: 'one', status }] }, disabled: false, onRequestRevoke() {} }))
  const button = tree.find(node => node.type === 'Button')
  assert.equal(button.props.disabled, status === 'revoked')
  assert.equal(button.props.title, 'Remove listed access')
})
for (const success of [true, false]) test(`listed removal ${success ? 'success' : 'partial failure'} refreshes canonical access`, async () => {
  const h = load([[person], true, false, null, '', person, false], success ? { success: true, data: 2 } : { success: false, error: 'Second link could not be removed' })
  const tree = nodes(h.ExternalAccessDirectory()), action = tree.find(node => node.type === 'AlertDialogAction')
  const description = tree.find(node => node.type === 'AlertDialogDescription')
  const copy = React.Children.toArray(description.props.children).filter(item => typeof item === 'string').join(' ')
  assert.ok(copy.includes('Other access may remain'))
  assert.ok(!copy.includes('Arc account is cut off'))
  action.props.onClick({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls, [{ revoke: { token_ids: ['active', 'paused'] } }, 'refresh'])
  assert.ok(h.updates.some(update => update.slot === 5 && update.value === null))
  assert.equal(h.messages[0], success ? 'Removed 2 access records for Trade partner' : 'Second link could not be removed')
})
