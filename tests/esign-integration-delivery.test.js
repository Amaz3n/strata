require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
const tokens=require('../lib/esign/signing-tokens')
process.env.DOCUMENT_SIGNING_SECRET='delivery-test-secret'
function harness() {
 const row={id:'00000000-0000-4000-8000-000000000001',org_id:'org',token_hash:tokens.hashSigningToken('original'),status:'viewed',sent_at:'2026-01-01T00:00:00Z',sent_to_email:'signer@example.test',envelope_id:'env',documents:{title:'Agreement'},envelopes:{status:'sent',metadata:{reminder_settings:{enabled:true}}}}
 const receipts=[],sends=[],updates=[],templates=[],filters=[];let accepted=false,onOrgRead=()=>{}
 const db={from(table){let inserted; const q={select(){return q},eq(key,value){filters.push([table,key,value]);return q},order(){return q},limit(){return q},update(p){updates.push(p);return q},insert(p){inserted=p;return q},single(){return q},maybeSingle(){return q},then(resolve){if(table==='orgs')onOrgRead();if(inserted)receipts.push({...inserted,sent_at:'2026-01-02T00:00:00Z'});return Promise.resolve({data:structuredClone(table==='document_signing_requests'?row:table==='orgs'?{name:'Org'}:receipts.at(-1)??null),error:null}).then(resolve)}};return q}}
 const exports={},deps={'server-only':{},'node:crypto':require('node:crypto'),'@/lib/esign/signing-tokens':tokens,'@/lib/esign/unified-contracts':{buildUnifiedSigningUrl:t=>`/d/${t}`},'@/lib/supabase/server':{createServiceSupabaseClient:()=>db},'@/lib/emails/signature-email':{SignatureEmail:x=>x},'@/lib/services/mailer':{getOrgSenderEmail:()=>'',renderEmailTemplate:async value=>{templates.push(value);return ''},sendEmail:async p=>{sends.push(p);return accepted}}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/signature-delivery.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>deps[n]??{},Date,Error,Intl,Buffer})
 return {api:exports,row,receipts,sends,updates,templates,filters,db,setOrgRead:fn=>{onOrgRead=fn},setAccepted:()=>{accepted=true}}
}
test('provider failure leaves reminders retryable without rotating tokens or logging sent',async()=>{
 const h=harness(),original=h.row.token_hash,key=`${h.row.id}:${h.row.sent_at}`,input={orgId:'org',requestId:h.row.id,deliveryKey:key}
 await assert.rejects(h.api.deliverAutomaticSigningReminder(input),/not delivered/)
 assert.equal(h.receipts.length,0);assert.equal(h.row.token_hash,original);assert.equal(h.updates.length,1);assert.equal(h.updates[0].delivery_status,'failed');assert.equal(h.updates[0].token_hash,undefined)
 h.setAccepted();await h.api.deliverAutomaticSigningReminder(input)
 assert.equal(h.receipts.length,1);assert.equal(h.sends[0].idempotencyKey,h.sends[1].idempotencyKey)
 await h.api.deliverAutomaticSigningReminder(input)
 assert.equal(h.sends.length,2)
})
test('terminal invitations do not send and viewed invitations retain their state',async()=>{
 const h=harness();h.setAccepted();await h.api.deliverSigningInvitation({orgId:'org',requestId:h.row.id})
 assert.equal(h.sends.length,1);assert.equal(h.updates.length,0);h.row.status='signed'
 await h.api.deliverSigningInvitation({orgId:'org',requestId:h.row.id});assert.equal(h.sends.length,1)
})
test('manual reminders remain available when automation is disabled and replay their receipt safely',async()=>{
 const h=harness();h.setAccepted();h.row.envelopes.metadata.reminder_settings.enabled=false
 const input={orgId:'org',requestId:h.row.id,deliveryKey:`manual:${h.row.id}:attempt-1`}
 await h.api.deliverAutomaticSigningReminder(input)
 assert.equal(h.sends.length,1);assert.equal(h.receipts[0].delivery_type,'manual');assert.equal(h.receipts[0].delivery_key,input.deliveryKey)
 await h.api.deliverAutomaticSigningReminder(input);assert.equal(h.sends.length,1)
})
test('correcting an invitation changes its provider idempotency key',async()=>{
 const h=harness();h.setAccepted();await h.api.deliverSigningInvitation({orgId:'org',requestId:h.row.id})
 h.row.token_hash=tokens.hashSigningToken('corrected');h.row.sent_to_email='corrected@example.test'
 await h.api.deliverSigningInvitation({orgId:'org',requestId:h.row.id})
 assert.notEqual(h.sends[0].idempotencyKey,h.sends[1].idempotencyKey);assert.equal(h.sends[1].to[0],'corrected@example.test')
})
test('inflight invitation keeps recipient and token in the same snapshot across correction',async()=>{
 const h=harness(),expected=tokens.createRecoverableSigningToken(h.row),oldHash=h.row.token_hash
 h.setOrgRead(()=>{h.row.token_hash=tokens.hashSigningToken('corrected-in-flight');h.row.sent_to_email='new@example.test'})
 await assert.rejects(h.api.deliverSigningInvitation({orgId:'org',requestId:h.row.id}),/not delivered/)
 assert.equal(h.sends[0].to[0],'signer@example.test');assert.equal(h.templates[0].signingLink,`/d/${expected}`)
 assert.notEqual(tokens.createRecoverableSigningToken(h.row),expected)
 assert.ok(h.filters.some(([table,key,value])=>table==='document_signing_requests'&&key==='token_hash'&&value===oldHash))
})
test('self-sign links reject a corrected recipient and draft transitions compare the captured credential',async()=>{
 const h=harness()
 await assert.rejects(h.api.issueSigningLinkForRequest(h.db,{orgId:'org',requestId:h.row.id,markSent:false,expectedEmail:'previous@example.test'}),/recipient changed/)
 h.row.status='draft';await h.api.issueSigningLinkForRequest(h.db,{orgId:'org',requestId:h.row.id,markSent:true,expectedEmail:'SIGNER@example.test'})
 assert.ok(h.filters.some(([table,key,value])=>table==='document_signing_requests'&&key==='token_hash'&&value===h.row.token_hash))
})
