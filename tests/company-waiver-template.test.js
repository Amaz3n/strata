require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const {waiverTemplateSchema,fillTemplate} = require("../lib/templates/waiver-template")
const draft={name:"Company waiver",title:"Waiver",waiverType:"conditional_progress",body:"Project: {{project_name}}\n\nAmount: {{amount}}. Exceptions: {{exceptions}}",status:"draft",reviewed:false}
test("only reviewed drafts can be published",()=>{
 assert.equal(waiverTemplateSchema.safeParse(draft).success,true)
 assert.equal(waiverTemplateSchema.safeParse({...draft,status:"published"}).success,false)
 assert.equal(waiverTemplateSchema.safeParse({...draft,status:"published",reviewed:true}).success,true)
})
test("rejects unknown and prototype field names without changing document wording",()=>{
 for(const field of ["project","__proto__","constructor"])assert.equal(waiverTemplateSchema.safeParse({...draft,body:`{{${field}}}`}).success,false)
 assert.equal(waiverTemplateSchema.parse(draft).body,draft.body)
})
test("sample preview resolves project values while template preview keeps semantic fields",()=>{
 assert.match(fillTemplate(draft.body,true),/Oakwood Residence/)
 assert.match(fillTemplate(draft.body,false),/\[Project name\]/)
 assert.match(fillTemplate(draft.body,true),/Retainage and disputed work excluded\./)
 assert.equal(fillTemplate("Unchanged terms: 25% retainage.",true),"Unchanged terms: 25% retainage.")
})

test("PDF previews paginate long templates and presets",async()=>{
 const {renderToBuffer}=require("@react-pdf/renderer")
 const {PDFDocument}=require("pdf-lib")
 const {WaiverTemplateDocument}=require("../lib/pdfs/waiver-template")
 const {PresetTemplateDocument}=require("../lib/pdfs/preset-template")
 const content=Array.from({length:45},(_,i)=>`Section ${i+1}. Preserve this wording and all stated exceptions. Project: {{project_name}}. Amount: {{amount}}.`).join("\n\n")
 const waiver=await PDFDocument.load(await renderToBuffer(WaiverTemplateDocument({draft:{...draft,body:content},sample:true})))
 assert.ok(waiver.getPageCount()>1)
 const preset=await PDFDocument.load(await renderToBuffer(PresetTemplateDocument({data:{kind:"Schedule",name:"Example schedule",rows:Array.from({length:65},(_,i)=>({label:`Activity ${i+1}`,detail:"Framing and inspection",value:`Day ${i*2} · 2 days`}))}})))
 assert.ok(preset.getPageCount()>1)
})
