const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { createClient } = require('@supabase/supabase-js')

function load(file, imports) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(code, { exports, Error, console, require: (name) => imports[name] ?? {} })
  return exports
}

const { preserveQueryError } = load('lib/supabase/query-error.ts', {
  'next/navigation': require('next/dist/client/components/unstable-rethrow'),
})

test('PostgREST preserves the original Next prerender cancellation', async () => {
  const cancellation = Object.assign(new Error('Prerender complete'), { digest: 'HANGING_PROMISE_REJECTION' })
  const client = createClient('https://example.supabase.co', 'test-key', {
    global: { fetch: async () => { throw cancellation } },
  })
  await assert.rejects(
    Promise.resolve(client.from('memberships').select('id').maybeSingle().throwOnError().then(undefined, preserveQueryError)),
    (error) => error === cancellation,
  )
})

test('real database failures still return an error for fail-closed handling', async () => {
  const client = createClient('https://example.supabase.co', 'test-key', {
    global: { fetch: async () => new Response(JSON.stringify({ message: 'permission denied', code: '42501' }), { status: 403 }) },
  })
  const result = await client.from('memberships').select('id').maybeSingle().throwOnError().then(undefined, preserveQueryError)
  assert.equal(result.data, null)
  assert.match(result.error.message, /permission denied/)
})

function recipientService(data, error, retrieveRecipient) {
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: async () => ({ data, error }),
  }
  return load('lib/services/payment-rail-setup.ts', {
    zod: require('zod'),
    '@/lib/supabase/server': { createServiceSupabaseClient: () => ({ from: () => query }) },
    '@/lib/integrations/payments/payment-rail-registry': { getPaymentRailProvider: () => ({ retrieveRecipient }) },
  })
}

test('unrelated Stripe accounts never request vendor bank details', async () => {
  let calls = 0
  const service = recipientService(null, null, async () => { calls++; throw new Error('restricted endpoint') })
  assert.equal(await service.syncVendorRecipient('acct_platform'), null)
  assert.equal(calls, 0)
})

test('recipient lookup failures remain retryable and do not become ignored events', async () => {
  const service = recipientService(null, { message: 'database unavailable' }, async () => assert.fail('provider called'))
  await assert.rejects(service.syncVendorRecipient('acct_vendor'), /database unavailable/)
})

test('known vendor accounts still refresh and propagate provider failures', async () => {
  const service = recipientService({ id: 'recipient' }, null, async () => { throw new Error('provider unavailable') })
  await assert.rejects(service.syncVendorRecipient('acct_vendor'), /provider unavailable/)
})
