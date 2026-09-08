require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const originalLoad = Module._load
let state
function query(table) {
  const builder = { select() {return this}, eq() {return this}, in() {return this}, maybeSingle() {return this}, then(resolve) {
    return Promise.resolve({ data: table === 'accounting_sync_records' ? state.records : { project_id: 'project', ...(state.entity ?? {}) }, error: null }).then(resolve)
  } }
  return builder
}
const client = { from: query, async rpc(name, args) {
  if (name === 'claim_accounting_delivery') {
    if (state.token) return { data: null, error: null }
    state.token = 'owned'; return { data: state.token, error: null }
  }
  if (name === 'release_accounting_delivery') { if (state.token === args.p_token) state.token = null; return {error:null} }
  if (name === 'persist_accounting_delivery') {
    if (args.p_token !== state.token) return {data:false,error:null}
    if (args.p_external_id) state.persisted.externalId = args.p_external_id
    if (args.p_external_version) state.persisted.externalVersion = args.p_external_version
    if (args.p_status) state.persisted.status = args.p_status
    state.writes++; return {data:true,error:null}
  }
  throw new Error(`Unexpected RPC ${name}`)
} }
const provider = { capabilities: {}, async pushInvoice() { state.calls++; return state.push() } }
Module._load = function(request, parent, isMain) {
  const mocks = {
    '@/lib/supabase/server': { createServiceSupabaseClient: () => client },
    '@/lib/services/accounting-target': { resolveAccountingTarget: async () => state.target },
    '@/lib/integrations/accounting/registry': { getProvider: () => provider },
    '@/lib/services/books/authority': { isExternalLedgerAuthoritative: async () => state.authority },
    '@/lib/services/accounting-sync-attempts': { recordAccountingSyncAttempt: async input => { state.attempts.push(input); return 'attempt' } },
    '@/lib/services/events': {recordEvent:async()=>{}}, '@/lib/services/audit': {recordAudit:async()=>{}},
    '@/lib/services/accounting-logger': {logAccounting:()=>{}}, '@/lib/services/outbox': {enqueueOutboxJob:async()=>{}},
  }
  if (mocks[request]) return mocks[request]
  return originalLoad.call(this, request, parent, isMain)
}
const { processAccountingPush } = require('../lib/services/accounting-sync')
Module._load = originalLoad
const input = {orgId:'org',entityType:'invoice',entityId:'invoice',connectionId:'connection'}
function reset() {
  state={ attempts:[], entity:{subtotal_cents:1000,tax_cents:0,total_cents:1000,balance_due_cents:1000}, authority:true, records:[{connection_id:'connection',external_id:'remote',pushable:true}], token:null, writes:0,calls:0,
    persisted:{externalId:'remote',externalVersion:'7'}, push:async()=>({externalId:'remote'}),
    target:{healthy:true,connection:{id:'connection',provider:'qbo',label:'Test',status:'active',settings:{}}}}
}
test('completion retains applied version when provider supplies no replacement',async()=>{reset(); await processAccountingPush(input);assert.equal(state.persisted.externalVersion,'7');assert.equal(state.persisted.status,'synced')})
test('freeze after enqueue prevents provider dispatch',async()=>{reset();state.target.connection.settings.cutover_freeze_run_id='run';await assert.rejects(processAccountingPush(input),/cutover_freeze/);assert.equal(state.calls,0);assert.equal(state.persisted.externalId,'remote')})
test('disabled sync at delivery prevents dispatch',async()=>{reset();state.target.connection.settings.auto_sync=false;await assert.rejects(processAccountingPush(input),/disabled/);assert.equal(state.calls,0)})
test('pinned connection and linked history cannot move to another book',async()=>{reset();state.target.connection.id='other';await assert.rejects(processAccountingPush(input),/connection_mismatch/);assert.equal(state.calls,0)})
test('concurrent contender cannot modify owner lease or identity',async()=>{reset();let finish;state.push=()=>new Promise(resolve=>{finish=resolve});const winner=processAccountingPush(input);while(!finish) await new Promise(resolve=>setImmediate(resolve));const loser=await processAccountingPush(input);assert.equal(loser.deferred,true);assert.equal(state.token,'owned');assert.equal(state.writes,0);finish({externalId:'remote',externalVersion:'8'});await winner;assert.equal(state.calls,1);assert.equal(state.persisted.externalVersion,'8')})
test('legitimate no-op has skipped state and does not fabricate posting',async()=>{reset();state.push=async()=>({externalId:null,skipped:true});await processAccountingPush(input);assert.equal(state.persisted.status,'skipped');assert.equal(state.persisted.externalVersion,'7')})
test('provider deferral leaves current state and identity untouched',async()=>{reset();state.push=async()=>({externalId:null,skipped:true,deferred:true});await processAccountingPush(input);assert.equal(state.writes,0);assert.equal(state.persisted.externalId,'remote')})
test('Arc authoritative org performs zero provider calls',async()=>{reset();state.authority=false;assert.equal((await processAccountingPush(input)).skippedReason,'books_authoritative');assert.equal(state.calls,0)})

test('a source edit during delivery retains remote identity and records the deferred attempt',async()=>{
  reset();state.push=async()=>{state.entity.total_cents=2000;return {externalId:'remote',externalVersion:'9'}}
  const result=await processAccountingPush(input)
  assert.equal(result.deferred,true)
  assert.equal(state.persisted.status,'pending')
  assert.equal(state.persisted.externalId,'remote')
  assert.equal(state.persisted.externalVersion,'9')
  assert.equal(state.attempts.length,1)
  assert.equal(state.attempts[0].outcome,'deferred')
  assert.match(state.attempts[0].message,/source changed during delivery/)
})
