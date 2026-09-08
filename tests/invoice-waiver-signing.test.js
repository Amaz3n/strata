require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {randomUUID,createHash}=require('node:crypto')
test('native signing links once, preserves the executed artifact and holds changed invoices internally',async()=>{
 const orgId=randomUUID(),userId=randomUUID(),invoiceId=randomUUID(),waiverId=randomUUID(),docId=randomUUID(),fileId=randomUUID(),envelopeId=randomUUID()
 const bytes=Buffer.from('EXACT EXECUTED PDF INCLUDING AUDIT CERTIFICATE')
 const input={invoice_id:invoiceId,request_id:waiverId,source:'template',template_id:randomUUID(),waiver_type:'conditional_progress',amount_cents:2500,through_date:'2026-09-01',claimant_name:'Builder',customer_name:'Customer',owner_name:'Owner',property_description:'123 Actual St',signer_name:'Signer',signer_title:'President',jurisdiction:'FL'}
 const workflow={version:2,lifecycle:'draft',source:'template',input,shared:false,document_path:'draft.pdf',file_id:randomUUID(),invoice_revision:'revision1',fields:[{key:'signer_name',page:0,x:.1,y:.7,width:.3,height:.05},{key:'signed_date',page:0,x:.6,y:.7,width:.2,height:.05}]}
 const db={invoices:[{id:invoiceId,org_id:orgId,status:'sent',currency:'USD',updated_at:'revision1',invoice_number:'INV-1'}],invoice_lien_waivers:[{id:waiverId,org_id:orgId,invoice_id:invoiceId,status:'pending_payment',amount_cents:2500,metadata:{workflow}}],documents:[],files:[{id:fileId,org_id:orgId,storage_path:'executed.pdf'}],app_users:[{id:userId,email:'signer@example.test'}],payments:[],payment_allocations:[],payment_reversals:[],envelopes:[{id:envelopeId,org_id:orgId,document_id:docId,status:'executed',executed_at:'2026-09-07T12:00:00Z'}]}
 let creates=0
 const supabase={from(table){let filters=[],patch,single=false;const q={select(){return q},eq(key,value){filters.push(row=>key==='metadata'?JSON.stringify(row[key])===value:row[key]===value);return q},update(value){patch=value;return q},single(){single=true;return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve().then(()=>{const rows=db[table].filter(row=>filters.every(f=>f(row)));if(patch)rows.forEach(row=>Object.assign(row,structuredClone(patch)));return {data:structuredClone(single?rows[0]??null:rows),error:null}}).then(resolve,reject)}};return q}}
 const stubs={
 '@/lib/services/context':{requireOrgContext:async()=>({orgId,userId,supabase})},
 '@/lib/services/authorization':{requireAuthorization:async()=>{},authorize:async()=>({allowed:true})},
 '@/lib/services/payments':{getInvoicePaymentActivity:async()=>({payments:[],reversals:[]})},
 '@/lib/storage/files-storage':{downloadFilesObject:async({path})=>{assert.ok(['draft.pdf','executed.pdf'].includes(path));return bytes}},
 '@/lib/services/audit':{recordAudit:async()=>{}},
 '@/lib/services/documents':{createDocument:async(input)=>{creates++;assert.equal(input.source_entity_id,waiverId);assert.equal(input.source_file_id,workflow.file_id);db.documents.push({id:docId,org_id:orgId,status:'draft',metadata:input.metadata});return {id:docId}},replaceDocumentFields:async({fields})=>{assert.deepEqual(fields.map(f=>f.field_type),['signature','date'])}},
 }
 const original=Module._load;Module._load=function(request,...args){return stubs[request]??original.call(this,request,...args)}
 try{
 const {startInvoiceWaiverSigning}=require('../lib/services/invoice-waiver-workflow')
 const {completeInvoiceWaiverFromSigning}=require('../lib/services/invoice-waiver-signing')
 const first=await startInvoiceWaiverSigning(invoiceId,waiverId,true)
 assert.equal(first.documentId,docId);assert.equal(first.waiver.metadata.workflow.shared,false)
 await startInvoiceWaiverSigning(invoiceId,waiverId,true);assert.equal(creates,1)
 const params={supabase,orgId,documentId:docId,envelopeId,executedFileId:fileId}
 await assert.rejects(completeInvoiceWaiverFromSigning(params),/not fully executed/)
 db.documents[0].status='signed';db.documents[0].executed_file_id=fileId
 await completeInvoiceWaiverFromSigning(params)
 let completed=db.invoice_lien_waivers[0].metadata.workflow
 assert.equal(completed.lifecycle,'signed');assert.equal(completed.document_path,'executed.pdf');assert.equal(completed.shared,true)
 assert.equal(completed.sha256,createHash('sha256').update(bytes).digest('hex'))
 assert.equal(completed.signed_at,'2026-09-07T12:00:00Z')
 await completeInvoiceWaiverFromSigning(params)
 db.invoice_lien_waivers[0].metadata.workflow={...workflow,signing_document_id:docId,sharing_requested:true}
 db.invoices[0].updated_at='revision2'
 await completeInvoiceWaiverFromSigning(params)
 completed=db.invoice_lien_waivers[0].metadata.workflow
 assert.equal(completed.shared,false);assert.equal(completed.needs_review,true);assert.equal(completed.lifecycle,'signed')
 db.invoice_lien_waivers[0].metadata.workflow={...workflow,signing_document_id:randomUUID()}
 await assert.rejects(completeInvoiceWaiverFromSigning(params),/does not match/)
 }finally{Module._load=original}
})
