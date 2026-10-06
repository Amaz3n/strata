const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const { redirect, notFound, unstable_rethrow } = require('next/navigation')
const { DynamicServerError } = require('next/dist/client/components/hooks-server-context')
const { makeDynamicHangingPromise } = require('next/dist/server/dynamic-rendering-utils')

function thrown(work) {
  try { work() } catch (error) { return error }
  throw new Error('Expected a framework signal')
}
function fixture({ failingRead, failure, live } = {}) {
  const calls = [], exports = {}
  const modules = {
    'next/server': { connection: () => { calls.push('connection'); return live ?? Promise.resolve() } },
    'next/navigation': { unstable_rethrow },
    '@/lib/services/release-notes': { getReleaseNotesSummary: async () => { calls.push('release'); if (failingRead === 'release') throw failure; return { unreadCount: 2, announcement: { title: 'Fixture release' } } } },
    '@/lib/services/navigation-badges': { getNavigationBadgeCounts: async () => { calls.push('badges'); if (failingRead === 'badges') throw failure; return { pipelineBadgeCount: 3, myWorkBadgeCount: 4, readyToBillBadgeCount: 5, projectReviewBadgeCounts: { project: 6 }, projectCorrespondenceBadgeCounts: { project: 7 } } } },
  }
  const leaf = new Proxy({}, { get: () => () => null })
  const source = fs.readFileSync(process.env.APP_CHROME_LAYOUT_SOURCE ?? 'app/(app)/layout.tsx', 'utf8') + '\nexport { loadNavigationBadges, ReleaseNotesAnnouncementSlot }\n'
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function('exports', 'require', code)(exports, name => ['react', 'react/jsx-runtime'].includes(name) ? require(name) : modules[name] ?? leaf)
  return { calls, load: exports.loadNavigationBadges, announcement: exports.ReleaseNotesAnnouncementSlot }
}

test('navigation decoration waits for a live connection before starting reads', async () => {
  let resolve
  const live = new Promise(done => { resolve = done })
  const f = fixture({ live }), result = f.load()
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.calls, ['connection'])
  resolve()
  assert.deepEqual(await result, { pipelineBadgeCount: 3, myWorkBadgeCount: 4, readyToBillBadgeCount: 5, projectReviewBadgeCounts: { project: 6 }, projectCorrespondenceBadgeCounts: { project: 7 }, whatsNewUnreadCount: 2 })
})
test('ordinary badge failures keep the other navigation counts available', async () => {
  const badges = await fixture({ failingRead: 'badges', failure: new Error('Badge store unavailable') }).load()
  assert.deepEqual(badges, { pipelineBadgeCount: 0, myWorkBadgeCount: 0, readyToBillBadgeCount: 0, projectReviewBadgeCounts: {}, projectCorrespondenceBadgeCounts: {}, whatsNewUnreadCount: 2 })
  const release = await fixture({ failingRead: 'release', failure: new Error('Release store unavailable') }).load()
  assert.equal(release.whatsNewUnreadCount, 0)
  assert.equal(release.myWorkBadgeCount, 4)
  const announcement = await fixture({ failingRead: 'release', failure: new Error('Release store unavailable') }).announcement()
  assert.equal(announcement.props.announcement, null)
})
for (const reader of ['release', 'badges', 'announcement']) {
  test(`${reader} decoration preserves Next.js redirects and render interruption`, async () => {
    const controller = new AbortController()
    const hanging = makeDynamicHangingPromise(controller.signal, '/', 'navigation badges').catch(error => error)
    controller.abort()
    const signals = [thrown(() => redirect('/auth/signin')), thrown(notFound), new DynamicServerError('Interrupted chrome read'), await hanging]
    for (const signal of signals) {
      for (const failure of [signal, new Error('Wrapped decoration failure', { cause: signal })]) {
        const f = fixture({ failingRead: reader === 'announcement' ? 'release' : reader, failure })
        await assert.rejects(reader === 'announcement' ? f.announcement() : f.load(), error => error === signal)
      }
    }
  })
}
