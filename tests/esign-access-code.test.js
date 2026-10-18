const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
function harness() {
  const exports = {}, jar = new Map(), attempts = []
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/esign/access-code.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: name => name === 'server-only' ? {} : name === 'node:crypto' ? require(name) : name === 'next/headers' ? { cookies: async () => ({ get: key => jar.get(key), set: (key, value, options) => jar.set(key, { value, options }) }) } : { createServiceSupabaseClient: () => ({ rpc: async (...args) => { attempts.push(args); return { error: null } } }) },
    process: { env: { DOCUMENT_SIGNING_SECRET: 'test-only-secret', NODE_ENV: 'production' } }, Buffer, Date, Number, Error,
  })
  return { ...exports, jar, attempts }
}
test('access codes require correct secret, secure proof cookie, and revoke on recipient correction', async () => {
  const h = harness(), request = { id: 'request', org_id: 'org', token_hash: 'first', access_code_hash: h.hashSigningAccessCode('correct-code') }
  assert.equal(await h.hasSigningAccess(request), false)
  await assert.rejects(h.unlockSigningAccess(request, 'incorrect-code'), /incorrect/)
  assert.equal(h.jar.size, 0)
  await h.unlockSigningAccess(request, 'correct-code')
  assert.equal(h.attempts.length, 2)
  assert.equal(await h.hasSigningAccess(request), true)
  assert.equal(await h.hasSigningAccess({ ...request, token_hash: 'corrected' }), false)
  const cookie = h.jar.get('esign-access-request')
  assert.equal(cookie.options.httpOnly, true)
  assert.equal(cookie.options.secure, true)
  cookie.value = `1.${cookie.value.split('.')[1]}`
  assert.equal(await h.hasSigningAccess(request), false)
})
