require('../scripts/register-ts-node-test')
const test=require('node:test')
const assert=require('node:assert/strict')
const {parseWaiverAmount,formatWaiverAmount,editableWaiverValues}=require('../lib/lien-waivers/preparation')
const {renderEditableInvoiceWaiver}=require('../lib/pdfs/editable-invoice-waiver')
const Module=require('node:module');const originalLoad=Module._load
Module._load=function(request,parent,isMain){if(request==='@/lib/services/mupdf-loader')return {loadMupdf:()=>import('mupdf')};return originalLoad.call(this,request,parent,isMain)}
const {waiverSignatureFields}=require('../lib/pdfs/waiver-signature-fields')
Module._load=originalLoad
const loadMupdf=()=>import('mupdf')
const input={project_name:'Actual project',property_description:'123 Actual Street',claimant_name:'Builder LLC',customer_name:'Client',owner_name:'Owner',amount_cents:12345678,through_date:'2026-09-07',exceptions:'Retainage excluded',signer_name:'Signer'}
test('currency formatting preserves exact cents and rejects invalid input',()=>{
 for(const [value,cents] of [['170,000.00',17000000],['0.01',1],['1234.5',123450]])assert.equal(parseWaiverAmount(value),cents)
 assert.equal(formatWaiverAmount(17000000),'170,000.00')
 for(const value of ['','-2','1e4','20.999','abc'])assert.ok(Number.isNaN(parseWaiverAmount(value)))
 assert.equal(editableWaiverValues({...input,through_date:''}).through_date,'[Work through date]')
})
test('editable waiver uses actual invoice values and places signing fields on the last page',async()=>{
 const template={name:'Company waiver',title:'Conditional waiver',body:'Project {{project_name}}. Payment {{amount}}. Through {{through_date}}. Signed {{signed_date}}. '+('Preserved company wording. '.repeat(600)),waiverType:'conditional_progress',status:'published',reviewed:true}
 const bytes=await renderEditableInvoiceWaiver(template,input,'INV-TEST')
 const fields=await waiverSignatureFields(bytes,1)
 const mupdf=await loadMupdf();const doc=mupdf.Document.openDocument(bytes,'application/pdf')
 try{
  assert.ok(doc.countPages()>1)
  const page=doc.loadPage(0)
  try{assert.ok(page.search('Actual project').length);assert.ok(page.search('$123,456.78').length);assert.equal(page.search('TEMPLATE PREVIEW').length,0)}finally{page.destroy()}
  assert.equal(fields.length,3);assert.equal(fields[0].page_index,0);assert.equal(fields[1].page_index,doc.countPages()-1)
  assert.equal(fields[1].field_type,'signature');assert.equal(fields[2].field_type,'date')
  for(const f of fields){assert.ok(f.x>=0&&f.y>=0&&f.x+f.w<=1&&f.y+f.h<=1)}
 }finally{doc.destroy()}
})
