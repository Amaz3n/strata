require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),Module=require('node:module')
const {invoiceWaiverContentHash}=require('../lib/lien-waivers/invoice-content')
const original=Module._load
Module._load=function(request,...args){if(request==='@/lib/services/invoice-waiver-workflow')return {};return original.call(this,request,...args)}
const packet=require('../lib/services/invoice-waiver-packet')
Module._load=original
const source=fs.readFileSync(require.resolve('../lib/services/invoices.ts'),'utf8')
const start=source.indexOf('export async function issueInvoiceWithContext('),end=source.indexOf('export async function requestInvoiceApproval(',start)
const compiled=ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
function fixture(notes,separate){
 const invoice={id:'inv',org_id:'org',project_id:'project',invoice_number:'1042',title:'Work',status:'draft',notes,total_cents:10000,subtotal_cents:10000,tax_cents:0,approval_status:'not_required',metadata:{lines:[{description:'Work',quantity:1,unit_price_cents:10000}],waiver_packet:{enabled:true,waiver_id:'waiver',...(separate?{delivery_mode:'separate_signature',signer_id:'sam',envelope_id:'envelope'}:{})}}}
 const waiver={id:'waiver',status:'pending_payment',amount_cents:10000,metadata:{workflow:{version:2,lifecycle:separate?'draft':'signed',shared:!separate,signing_document_id:'document',invoice_content_hash:invoiceWaiverContentHash(invoice)}}}
 let deliveries=0
 const db={from(table){let columns='*',patch;const q={select(value){columns=value;return q},eq(){return q},neq(){return q},maybeSingle(){return q},single(){return q},update(value){patch=value;return q},then(resolve){let data;if(table==='invoice_lien_waivers')data=[waiver];else if(table==='documents')data={metadata:{waiver_signer_id:'sam'}};else if(table==='envelopes')data={id:'envelope',status:'sent'};else{const row={...invoice,...patch};data=columns==='*'?row:Object.fromEntries(columns.split(',').map(k=>k.trim()).map(k=>[k,row[k]]))};return Promise.resolve({data,error:null}).then(resolve)}};return q}}
 const exports={};vm.runInNewContext(compiled,{exports,require:()=>packet,assertInvoiceCanIssue:async()=> 'residential',createServiceSupabaseClient:()=>db,recordAudit:async()=>{},deliverIssuedInvoice:async()=>{deliveries++},randomUUID:()=> 'token'})
 return {invoice,send:()=>exports.issueInvoiceWithContext({supabase:db,orgId:'org',userId:'actor',productTier:'residential'},{invoiceId:'inv',recipients:['customer@example.test']}),deliveries:()=>deliveries}
}
for(const separate of [false,true]) for(const notes of ['', 'Payment covers framing through September']) test(`${separate?'other signer':'self signed'} issuance preserves ${notes?'written':'empty'} notes in the waiver check`,async()=>{
 const f=fixture(notes,separate);await f.send();assert.equal(f.deliveries(),1)
 f.invoice.notes='Changed after signing';await assert.rejects(f.send(),/waiver|signing/i);assert.equal(f.deliveries(),1)
})
