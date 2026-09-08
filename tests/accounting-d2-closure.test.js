require('../scripts/register-ts-node-test')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateAcceptanceStreak } = require('../lib/services/accounting-acceptance-rules')
const { buildDecisionRegister, codingDifferences } = require('../scripts/lib/accounting-d2-decisions')
const { inspectRemoteTransaction, classifyRemoteAccounts } = require('../scripts/lib/accounting-d2-remote-evidence')
const candidate = { candidate_sha: 'a'.repeat(40), schema_fingerprint: 'schema', checker_version: 'accounting-d2-v1', started_at: '2026-08-01T00:00:00Z' }
const now = new Date('2026-09-08T12:00:00Z')
const sample = day => ({ checked_at: `2026-${day}T04:45:00Z`, ...candidate, passed: true, evidence: { complete: true, scope: 'global', blockers: [] } })
const days = ['08-25','08-26','08-27','08-28','08-29','08-30','08-31','09-01','09-02','09-03','09-04','09-05','09-06','09-07']
test('fourteen complete UTC days qualify; elapsed time and duplicate runs do not', () => {
  assert.equal(evaluateAcceptanceStreak(days.map(sample), candidate, now).recommendation, 'APPLY D2')
  assert.equal(evaluateAcceptanceStreak(Array.from({length: 20}, () => sample('09-07')), candidate, now).consecutiveCompleteDays, 1)
  assert.equal(evaluateAcceptanceStreak([], candidate, now).recommendation, 'HOLD')
})
test('missing, failed, incomplete, limited-scope, changed-candidate and changed-schema days break acceptance', () => {
  for (const patch of [null, {passed: false}, {evidence: {complete: false, scope: 'global', blockers: []}}, {evidence: {complete: true, scope: 'patagonia', blockers: []}}, {candidate_sha: 'b'.repeat(40)}, {schema_fingerprint: 'other'}, {checker_version: 'other'}]) {
    const samples = days.map(sample).flatMap(row => row.checked_at.includes('09-05') ? patch === null ? [] : [{...row,...patch}] : [row])
    assert.equal(evaluateAcceptanceStreak(samples,candidate,now).consecutiveCompleteDays,2)
  }
})
test('a later successful retry cannot erase a failing observation; current day failure blocks apply', () => {
  assert.equal(evaluateAcceptanceStreak([...days.map(sample), {...sample('09-07'),passed:false},sample('09-07')],candidate,now).consecutiveCompleteDays,0)
  assert.equal(evaluateAcceptanceStreak([...days.map(sample), {...sample('09-08'),passed:false}],candidate,now).recommendation,'HOLD')
  assert.equal(evaluateAcceptanceStreak(days.map(sample),{...candidate,started_at:'2026-09-06T00:00:00Z'},now).consecutiveCompleteDays,2)
})
const baseEvidence = () => ({captured_at:'2026-09-08T01:00:00Z',coding:[],jobs:[],sync_issues:[],inbound:[],connections:[],routes:[]})
test('decision register combines coding, sync, job and inbound symptoms under connection identity', () => {
  const evidence=baseEvidence()
  evidence.connections=[{id:'conn',org_id:'org',status:'active',external_account_id:'realm'}]
  evidence.coding=[{id:'bill',org_id:'org',entity_type:'bill',legacy_expense_account_id:'old',accounting_coding:{expense_account:{id:'new'}},updated_at:'version'}]
  evidence.sync_issues=[{id:'sync',org_id:'org',connection_id:'conn',entity_type:'bill',entity_id:'bill',external_id:'10',status:'needs_review'}]
  evidence.jobs=[{id:1,org_id:'org',job_type:'accounting_push_vendor_bill',payload:{bill_id:'bill'},status:'failed'}]
  evidence.inbound=[{id:'event',realm_id:'realm',entity_name:'Bill',entity_qbo_id:'10',process_status:'error'}]
  const result=buildDecisionRegister(evidence)
  assert.equal(result.entries.length,1)
  assert.equal(result.entries[0].sources.length,4)
  assert.equal(result.entries[0].reviewer,null)
  assert.equal(result.entries[0].disposition,'unreviewed')
})
test('overlapping remote IDs across connections never merge separate accounting decisions',()=>{
  const evidence=baseEvidence()
  evidence.sync_issues=['a','b'].map(connection_id=>({id:connection_id,org_id:'org',connection_id,entity_type:'bill',entity_id:'bill',external_id:'10',status:'error'}))
  assert.equal(buildDecisionRegister(evidence).entries.length,2)
})
test('neutral-only coding and correct counterparty/dimension paths do not manufacture conflicts',()=>{
  assert.deepEqual(codingDifferences({accounting_coding:{expense_account:{id:'new'}}}),[])
  assert.deepEqual(codingDifferences({legacy_vendor_id:'v',legacy_class_id:'c',accounting_coding:{counterparty:{id:'v'},dimensions:{class:{id:'c'}}}}),[])
  assert.deepEqual(codingDifferences({legacy_expense_account_id:'v',accounting_coding:{expense_account:null}}),['expense_account:missing_direct_neutral_reference'])
})
test('inbound evidence retains separate historical connection identities for the same local entity',()=>{
  const evidence=baseEvidence()
  evidence.connections=['old','current'].map(id=>({id,org_id:'org',status:'active',external_account_id:'realm'}))
  evidence.sync_identities=['old','current'].map(connection_id=>({org_id:'org',connection_id,entity_type:'invoice',entity_id:'invoice',external_id:'10'}))
  evidence.inbound=[{id:'event',realm_id:'realm',entity_name:'Invoice',entity_qbo_id:'10',process_status:'error'}]
  const result=buildDecisionRegister(evidence)
  assert.equal(result.entries.length,2)
  assert.deepEqual(result.entries.map(row=>row.connectionId).sort(),['current','old'])
})
test('remote evidence whitelists complete allocations and never exports memo, names or token data',()=>{
  const remote=inspectRemoteTransaction({Id:'10',SyncToken:'0',PrivateNote:'secret',access_token:'secret',Line:[{Id:'1',Amount:10,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:{value:'a',name:'private'}}},{Id:'2',Amount:20,ItemBasedExpenseLineDetail:{ItemRef:{value:'i'}}}]})
  assert.equal(remote.complete,true)
  assert.equal(remote.lines.length,2)
  assert.equal(remote.lines[0].accountId,'a')
  assert.equal(remote.lines[1].itemId,'i')
  assert.ok(!JSON.stringify(remote).includes('secret'))
  assert.ok(!JSON.stringify(remote).includes('private'))
  assert.equal(inspectRemoteTransaction({Id:'10'}).complete,false)
  assert.equal(classifyRemoteAccounts('a','b',['a','b']),'contains_both')
})
