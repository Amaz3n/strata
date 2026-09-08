require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

test('organization signer choices exclude inactive members, other organizations, and missing email', async () => {
  const rows = [
    { org_id: 'org', status: 'active', user: { id: 'a', full_name: 'Alex', email: 'alex@example.test' } },
    { org_id: 'other', status: 'active', user: { id: 'b', full_name: 'Other', email: 'other@example.test' } },
    { org_id: 'org', status: 'invited', user: { id: 'c', full_name: 'Invited', email: 'invited@example.test' } },
    { org_id: 'org', status: 'active', user: { id: 'd', full_name: 'No email', email: null } },
  ]
  const db = { from(table) { assert.equal(table, 'memberships'); const filters=[]; const q={ select(){return q},eq(k,v){filters.push(row=>row[k]===v);return q},then(resolve){return Promise.resolve({data:rows.filter(row=>filters.every(f=>f(row))),error:null}).then(resolve)} };return q } }
  const { listWaiverSigners } = require('../lib/services/waiver-signers')
  assert.deepEqual(await listWaiverSigners(db,'org'),[{id:'a',name:'Alex',email:'alex@example.test'}])
})

test('waiver request resolves member identity on the server and resumes without sending another request', async () => {
  let sends=0, starts=0, status='draft'
  let metadata={}
  const waiver={id:'waiver',metadata:{workflow:{version:2,lifecycle:'draft',input:{signer_name:'Alex'}}}}
  const db={from(table){let patch;const q={select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},single(){return q},maybeSingle(){return q},update(value){patch=value;return q},then(resolve){if(patch)metadata=patch.metadata;return Promise.resolve({data:table==='envelopes'?{id:'envelope'}:patch?{id:'document'}:{metadata},error:null}).then(resolve)}};return q}}
  const ctx={supabase:db,orgId:'org',userId:'creator',invoice:{}}
  const stubs={
    'next/cache':{revalidatePath(){}},
    '@/lib/services/invoice-waiver-workflow':{getInvoiceWaiverRecord:async()=>({ctx,waiver}),startInvoiceWaiverSigning:async()=>{starts++;return {documentId:'document',status,waiver}}},
    '@/lib/services/waiver-signers':{listWaiverSigners:async()=>[{id:'signer',name:'Alex',email:'alex@example.test'}]},
    '@/app/(app)/signatures/actions':{sendDocumentEnvelopeAction:async input=>{sends++;assert.equal(input.recipients[0].user_id,'signer');assert.equal(input.recipients[0].email,'alex@example.test');return {success:true,data:{envelopeId:'envelope'}}}},
  }
  const original=Module._load
  Module._load=function(request,...args){return stubs[request]??original.call(this,request,...args)}
  try {
    const {requestWaiverSignatureAction:request}=require('../app/(app)/invoices/waiver-actions')
    assert.equal((await request('invoice','waiver','outsider',true)).success,false)
    assert.equal(starts,0)
    let result=await request('invoice','waiver','signer',true)
    assert.equal(result.success,true);assert.equal(result.data.isSelf,false);assert.equal(sends,1)
    assert.equal(metadata.waiver_signing_experience,'review');assert.equal(metadata.waiver_signer_id,'signer')
    status='sent'
    result=await request('invoice','waiver','signer',true)
    assert.equal(result.success,true);assert.equal(result.data.envelopeId,'envelope');assert.equal(sends,1)
    metadata.waiver_signer_id='different'
    assert.equal((await request('invoice','waiver','signer',true)).success,false)
    assert.equal(sends,1)
  } finally {Module._load=original}
})
