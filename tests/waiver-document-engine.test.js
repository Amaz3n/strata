require('../scripts/register-ts-node-test')
const test=require('node:test'), assert=require('node:assert/strict'), Module=require('node:module')
const {randomUUID}=require('node:crypto')
const {waiverTemplateSchema}=require('../lib/templates/waiver-template')
const {documentFromBody,newWaiverBlock}=require('../lib/templates/waiver-document')
const {resolveWaiverValues,validateWaiverValues,visibleWaiverBlock,templateMatches,templatePriority,validateWaiverSigners}=require('../lib/templates/waiver-engine')
const {renderOriginalWaiver}=require('../lib/pdfs/waiver-original')
const {WaiverTemplateDocument}=require('../lib/pdfs/waiver-template')
const {renderToBuffer}=require('@react-pdf/renderer')
const {PDFDocument,StandardFonts}=require('pdf-lib')
const originalLoad=Module._load
Module._load=function(request,...args){if(request==='@/lib/services/mupdf-loader')return {loadMupdf:()=>import('mupdf')};return originalLoad.call(this,request,...args)}
const {waiverSignatureFields}=require('../lib/pdfs/waiver-signature-fields')
Module._load=originalLoad
const base={project_name:'Actual project',amount:'$12,345.67',exceptions:'None',signed_date:'________________',invoice_number:'INV-42'}
const template=()=>({name:'Test form',title:'Waiver',body:'',waiverType:'conditional_progress',status:'published',reviewed:true,document:documentFromBody('Project {{project_name}}. Payment {{amount}}.')})
const field=(key,type='text',source='manual',value='')=>({key,label:key,type,source,value,required:true,options:[]})
async function textOf(bytes){const mupdf=await import('mupdf');const pdf=mupdf.Document.openDocument(bytes,'application/pdf');try {let text='';for(let i=0;i<pdf.countPages();i++){const p=pdf.loadPage(i),t=p.toStructuredText();try{text+=t.asText()}finally{t.destroy();p.destroy()}}return text}finally{pdf.destroy()}}
test('custom values cannot override Arc facts and required, typed fields fail closed',()=>{
 const t=template();t.document.fields=[field('contract_ref'),field('retained','currency','constant','1200.25'),field('payment_alias','currency','amount')];t.document.blocks[0].text+=' {{contract_ref}} {{retained}} {{payment_alias}}';
 assert.equal(waiverTemplateSchema.safeParse(t).success,true)
 const values=resolveWaiverValues(t,base,{amount:'$0',contract_ref:'REF-91'})
 assert.equal(values.amount,base.amount);assert.equal(values.retained,'$1,200.25');assert.equal(values.payment_alias,base.amount)
 assert.doesNotThrow(()=>validateWaiverValues(t,values))
 assert.throws(()=>validateWaiverValues(t,resolveWaiverValues(t,base)),/contract_ref/)
 t.document.fields=[field('deadline','date')];assert.throws(()=>resolveWaiverValues(t,base,{deadline:'2026-02-30'}),/valid date/)
 t.document.fields=[{...field('scope','choice'),options:['Partial','Final']}];assert.throws(()=>resolveWaiverValues(t,base,{scope:'Other'}),/valid option/)
})
test('unknown mappings, duplicate keys, unresolved issues and prototype names cannot activate',()=>{
 for(const key of ['constructor','prototype','project_name']){const t=template();t.document.fields=[field(key)];assert.equal(waiverTemplateSchema.safeParse(t).success,false)}
 const t=template();t.document.fields=[field('a'),field('a')];assert.equal(waiverTemplateSchema.safeParse(t).success,false)
 t.document.fields=[field('b','text','made_up')];assert.equal(waiverTemplateSchema.safeParse(t).success,false)
 t.document.fields=[];t.document.issues=[{id:'1',message:'Uncertain clause',resolved:false}];assert.equal(waiverTemplateSchema.safeParse(t).success,false)
 t.status='draft';assert.equal(waiverTemplateSchema.safeParse(t).success,true)
})
test('conditional sections require data only when included and cannot drop exceptions',()=>{
 const t=template();t.document.fields=[field('claim')];const b=newWaiverBlock('paragraph','Excluded {{claim}}');b.condition={field:'exceptions',operator:'present',value:''};t.document.blocks.push(b)
 assert.equal(visibleWaiverBlock(b,base),false)
 assert.doesNotThrow(()=>validateWaiverValues(t,resolveWaiverValues(t,base)))
 assert.throws(()=>validateWaiverValues(t,resolveWaiverValues(t,{...base,exceptions:'Disputed work'})),/claim/)
 t.document.blocks.pop();assert.throws(()=>validateWaiverValues(t,{...base,exceptions:'Disputed work'}),/no exceptions field/)
})
test('project, customer, direction and state restrict defaults deterministically',()=>{
 const t=template(),id=randomUUID();t.applicability='incoming';t.jurisdiction='FL';t.defaults={enabled:true,projectIds:[id],customerName:'Builder LLC',signerName:'',signerTitle:''}
 const c={direction:'incoming',jurisdiction:'FL',projectId:id,customerName:'builder llc'}
 assert.equal(templateMatches(t,c),true)
 for(const patch of [{direction:'outgoing'},{jurisdiction:'CA'},{projectId:randomUUID()},{customerName:'Other'}])assert.equal(templateMatches(t,{...c,...patch}),false)
 assert.ok(templatePriority(t)>templatePriority(template()))
})
test('structured tables repeat actual covered items, paginate, and map each signer to the correct page',async()=>{
 const t=template();t.document.blocks.push(newWaiverBlock('page_break'))
 const table=newWaiverBlock('table');table.repeat='covered_items';table.columns=['Invoice','Amount'];table.rows=[['{{item_number}}','{{item_amount}}']];t.document.blocks.push(table)
 t.document.blocks.push(newWaiverBlock('signature'),{...newWaiverBlock('signature'),signerRole:'witness'})
 const values={...base,covered_items:JSON.stringify(Array.from({length:45},(_,i)=>({item_number:`BILL-${i+1}`,item_amount:'$500.00'})))}
 assert.throws(()=>validateWaiverSigners(t),/witness/)
 assert.doesNotThrow(()=>validateWaiverSigners(t,[{role:'witness',name:'Test Witness',email:'witness@example.test'}]))
 validateWaiverValues(t,values)
 const bytes=await renderToBuffer(WaiverTemplateDocument({draft:t,values,invoiceNumber:'INV-42'}))
 const text=await textOf(bytes);assert.match(text,/BILL-45/);assert.match(text,/Actual project/);assert.doesNotMatch(text,/\{\{/)
 const fields=await waiverSignatureFields(bytes,0,t);assert.equal(fields.filter(f=>f.field_type==='signature').length,2);assert.ok(fields.some(f=>f.signer_role==='witness'));assert.ok(fields.every(f=>f.y>=0&&f.y+f.h<=1));assert.ok((await PDFDocument.load(bytes)).getPageCount()>1)
})
test('original PDF keeps exact clauses, fills custom fields, and refuses clipping or missing pages',async()=>{
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText('Original terms must remain unchanged.',{x:40,y:700,font,size:11});const original=await pdf.save(),before=Buffer.from(original)
 const t=template();t.document.mode='original';t.document.placements=[{id:'a',key:'contract_ref',kind:'text',page:0,x:.1,y:.3,width:.5,height:.05},{id:'s',key:'signer_name',kind:'signature',page:0,x:.1,y:.8,width:.3,height:.06}]
 const bytes=await renderOriginalWaiver(original,t,{contract_ref:'CONTRACT-91'});const text=await textOf(bytes);assert.match(text,/Original terms must remain unchanged/);assert.match(text,/CONTRACT-91/);assert.deepEqual(Buffer.from(original),before)
 const fields=await waiverSignatureFields(bytes,0,t);assert.equal(fields[0].x,.1);assert.equal(fields[0].y,.8)
 await assert.rejects(renderOriginalWaiver(original,t,{contract_ref:'Overflow '.repeat(500)}),/does not fit/)
 t.document.placements[0].page=4;await assert.rejects(renderOriginalWaiver(original,t,{contract_ref:'X'}),/missing page/)
})

test('ordinary imported signature blanks activate and only explicit signing-date tokens receive date fields',async()=>{
 const t=template();t.document.blocks=[newWaiverBlock('paragraph','Claimant Signature: ________________________________ Date: {{signed_date}}\nOther blank: ________________________________'),newWaiverBlock('signature')];
 assert.equal(waiverTemplateSchema.safeParse(t).success,true);
 const bytes=await renderToBuffer(WaiverTemplateDocument({draft:t,values:base}));
 const fields=await waiverSignatureFields(bytes,0,t);
 assert.equal(fields.filter(f=>f.field_type==='signature').length,1);
 assert.equal(fields.filter(f=>f.field_type==='date').length,2,'one inline date and one signature-row date; no dates on literal blanks');
 const text=await textOf(bytes);assert.match(text,/Claimant Signature/);assert.match(text,/Other blank/);
});
