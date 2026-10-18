require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecoverableSigningToken, hashSigningToken, resolveSigningRequestToken } = require('../lib/esign/signing-tokens')
process.env.DOCUMENT_SIGNING_SECRET = 'test-only-signing-secret'
function database(row) {
  return { from() { let key, value; const q = {select(){return q},eq(k,v){key=k;value=v;return q}, async maybeSingle(){return {data:row[key]===value?row:null,error:null}}}; return q } }
}
test('recoverable reminder tokens preserve original invitations and repeat deterministically', async () => {
  const legacy = 'original-random-token'
  const row = {id:'00000000-0000-4000-8000-000000000001',token_hash:hashSigningToken(legacy)}
  const db = database(row), token = createRecoverableSigningToken(row)
  assert.equal(token, createRecoverableSigningToken(row))
  assert.equal((await resolveSigningRequestToken(db, legacy)).data.id,row.id)
  assert.equal((await resolveSigningRequestToken(db, token)).data.id,row.id)
  row.token_hash=hashSigningToken('explicit-revocation')
  assert.equal((await resolveSigningRequestToken(db,legacy)).data,null)
  assert.equal((await resolveSigningRequestToken(db,token)).data,null)
})
test('recoverable tokens reject tampering, malformed aliases, and different request ids',async()=>{
 const row={id:'00000000-0000-4000-8000-000000000001',token_hash:hashSigningToken('initial')},db=database(row),token=createRecoverableSigningToken(row)
 for(const bad of [token.slice(0,-1)+(token.endsWith('a')?'b':'a'),token+'.extra','v1.invalid.invalid',token.replace('000000000001','000000000002')]) assert.equal((await resolveSigningRequestToken(db,bad)).data,null)
})
