const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function route(result, acceptance) {
  const filename = path.resolve(__dirname, '../app/api/jobs/accounting-reconciliation/route.ts')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = name => {
    if (name === 'next/server') return { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } }
    if (name.endsWith('/accounting-acceptance')) return { captureAccountingAcceptance: async () => { if (acceptance instanceof Error) throw acceptance; return acceptance } }
    if (name.endsWith('/books/reconciliation')) return { runNightlyAccountingReconciliation: async () => result }
    if (name.endsWith('/cron-auth')) return { isAuthorizedCronRequest: () => true }
    if (name.endsWith('/job-runs')) return { withCronRun: (_, handler) => handler }
    return require(name)
  }
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename)
  return mod.exports.GET({})
}
test('failed release acceptance preserves evidence without failing completed reconciliation', async () => {
  const response = await route({attempted:3, completed:3, failures:[]}, {activeCampaigns:1, failedSamples:1})
  assert.equal(response.status, 200)
  assert.equal((await response.json()).acceptance.failedSamples, 1)
})
test('partial or failed reconciliation still fails operational health', async () => {
  for (const result of [{attempted:3,completed:2,failures:[]},{attempted:3,completed:3,failures:['failed']}]) {
    assert.equal((await route(result, {activeCampaigns:1,failedSamples:1})).status,207)
  }
})
test('collector persistence errors remain operational failures', async () => {
  await assert.rejects(route({attempted:3,completed:3,failures:[]}, new Error('database unavailable')), /database unavailable/)
})
