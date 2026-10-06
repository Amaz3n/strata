require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { redirect, notFound, unstable_rethrow } = require('next/navigation')
const { DynamicServerError } = require('next/dist/client/components/hooks-server-context')
const { makeDynamicHangingPromise } = require('next/dist/server/dynamic-rendering-utils')
const actionResult = require('../lib/action-result')

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function thrown(work) {
  try { work() } catch (error) { return error }
  throw new Error('Expected a framework signal')
}
function fixture(tab = 'profile') {
  const connection = deferred(), panel = deferred(), calls = []
  const exports = {}
  const source = fs.readFileSync(process.env.SETTINGS_PAGE_SOURCE ?? 'app/(app)/settings/page.tsx', 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const modules = {
    'next/server': { connection: () => { calls.push('connection'); return connection.promise } },
    'next/navigation': { unstable_rethrow },
    '@/lib/auth/context': { requireOrgMembership: async () => { calls.push('membership'); return { orgId: 'org-one', user: { id: 'actor' }, membership: { org_product_tier: 'production' } } } },
    '@/lib/services/permissions': { getCurrentUserPermissions: async () => { calls.push('permissions'); return { permissions: ['org.member'] } } },
    '@/lib/services/settings-page': { loadSettingsPanel: (tab, orgId) => { calls.push(['panel', tab, orgId]); return panel.promise } },
    '@/lib/settings/sections': { isSettingsTab: value => ['profile', 'organization', 'team'].includes(value) },
    '@/lib/action-result': actionResult,
  }
  const leaf = new Proxy({}, { get: () => () => null })
  new Function('exports', 'require', code)(exports, name => ['react', 'react/jsx-runtime'].includes(name) ? require(name) : modules[name] ?? leaf)
  const layout = exports.default({ searchParams: Promise.resolve({ tab }) })
  assert.equal(exports.instant, true)
  assert.equal(layout.props.fullBleed, true)
  const boundary = layout.props.children
  assert.equal(boundary.type, React.Suspense)
  assert.deepEqual(calls, [], 'the static shell must not start authorization or panel reads')
  return { connection, panel, calls, render: () => boundary.props.children.type(boundary.props.children.props) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('settings shell defers identity and panel reads until connection succeeds', async () => {
  const f = fixture(), result = f.render()
  await tick(); assert.deepEqual(f.calls, ['connection'])
  f.connection.resolve(); await tick()
  assert.deepEqual(f.calls, ['connection', 'membership', 'permissions', ['panel', 'profile', 'org-one']])
  const data = { tab: 'profile', user: { id: 'actor' }, roleLabel: 'Member' }
  f.panel.resolve(data)
  const window = await result
  assert.equal(window.key, 'org-one:actor')
  assert.equal(window.props.orgId, 'org-one')
  assert.equal(window.props.initialTab, 'profile')
  assert.deepEqual(window.props.permissions, ['org.member'])
  assert.deepEqual(window.props.initialPanel, { success: true, data })
})
test('an interrupted settings connection starts no identity or panel reads', async () => {
  const f = fixture(), signal = new DynamicServerError('Connection interrupted')
  const rejected = assert.rejects(f.render(), error => error === signal)
  f.connection.reject(signal); await rejected
  assert.deepEqual(f.calls, ['connection'])
})
test('ordinary panel failures remain recoverable settings results', async () => {
  for (const failure of [new Error('Panel storage unavailable'), { code: 'AUTH_FORBIDDEN' }, Object.assign(new Error('Retry later'), { code: 'RATE_LIMITED' })]) {
    const f = fixture('team'), result = f.render()
    f.connection.resolve(); f.panel.reject(failure)
    const window = await result
    assert.equal(window.props.initialTab, 'team')
    assert.deepEqual(window.props.initialPanel, actionResult.actionError(failure))
  }
})
test('invalid settings tabs fall back to the profile panel', async () => {
  const f = fixture('not-a-section'), result = f.render()
  f.connection.resolve(); f.panel.resolve({ tab: 'profile' })
  const window = await result
  assert.equal(window.props.initialTab, 'profile')
  assert.deepEqual(f.calls.at(-1), ['panel', 'profile', 'org-one'])
})
for (const [name, signal] of [
  ['redirect', thrown(() => redirect('/auth/signin'))],
  ['not found', thrown(notFound)],
  ['interrupted dynamic render', new DynamicServerError('Interrupted settings render')],
]) {
  test(`settings panel loading preserves ${name} control flow`, async () => {
    for (const failure of [signal, new Error('Wrapped panel failure', { cause: signal })]) {
      const f = fixture('organization')
      const rejected = assert.rejects(f.render(), error => error === signal)
      f.connection.resolve(); f.panel.reject(failure)
      await rejected
    }
  })
}
test('settings preserves Next.js prerender completion rather than displaying a panel error', async () => {
  const controller = new AbortController()
  const hanging = makeDynamicHangingPromise(controller.signal, '/settings', 'settings panel data')
  const failure = hanging.catch(error => error)
  controller.abort()
  const signal = await failure
  for (const error of [signal, new Error('Wrapped prerender completion', { cause: signal })]) {
    const f = fixture('team')
    const rejected = assert.rejects(f.render(), failure => failure === signal)
    f.connection.resolve(); f.panel.reject(error)
    await rejected
  }
})
