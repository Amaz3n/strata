require("../scripts/register-ts-node-test")
const test=require("node:test")
const assert=require("node:assert/strict")
const {randomUUID}=require("node:crypto")
const {PDFDocument}=require("pdf-lib")
const Module=require("node:module")
const load=Module._load
const orgId=randomUUID(),userId=randomUUID()
let allowed=true
const rows=[]
const queries=[]
const supabase={from(table){const filters=[];const q={select(){return q},eq(key,value){filters.push([key,value]);return q},is(key,value){filters.push([key,value]);return q},order(){return q},limit(){return q},single(){const data=rows.slice().reverse().find(r=>filters.every(([k,v])=>(k==="metadata->editable_waiver->>familyId"?r.metadata?.editable_waiver?.familyId:r[k])===v));queries.push(filters);return Promise.resolve({data,error:data?null:{message:"missing"}})},then(resolve){queries.push(filters);return Promise.resolve({data:rows.filter(r=>filters.every(([k,v])=>(k==="metadata->editable_waiver->>familyId"?r.metadata?.editable_waiver?.familyId:r[k])===v)).slice().reverse(),error:null}).then(resolve)}};return q}}
Module._load=function(request,parent,isMain){
 if(request==="@/lib/services/context")return {requireOrgContext:async()=>({orgId,userId,supabase})}
 if(request==="@/lib/services/authorization")return {requireAuthorization:async()=>{if(!allowed)throw new Error("Forbidden")}}
 if(request==="@/lib/services/ai/gateway")return {runAiObject:async(input)=>{assert.equal(input.feature,"document_extraction");assert.equal(input.orgId,orgId);assert.equal(input.files[0].mediaType,"application/pdf");return {ok:true,object:{isWaiver:true,name:"Imported waiver",title:"Waiver",waiverType:"conditional_progress",body:"Project: {{project_name}}. Exceptions remain unchanged.",warnings:["Review the notary wording."]}}}}
 if(request==="next/cache")return {revalidatePath(){}}
 if(request==="@/lib/services/generated-documents")return {storeGeneratedPdf:async(input)=>{assert.equal(input.orgId,orgId);assert.equal(input.projectId,null);assert.equal(input.shareWithClients,undefined);assert.ok((await PDFDocument.load(input.pdf)).getPageCount()>=1);const id=randomUUID();rows.push({id,org_id:input.orgId,folder_path:input.folderPath,metadata:input.metadata,archived_at:null,created_at:new Date().toISOString()});return {fileId:id,storagePath:"test"}}}
 return load.call(this,request,parent,isMain)
}
const {saveCompanyWaiverTemplate,listCompanyWaiverTemplates,importCompanyWaiverTemplate}=require("../app/(app)/settings/templates/waiver-actions")
test.after(()=>{Module._load=load})
const draft={name:"Test company form",title:"Test waiver",waiverType:"conditional_progress",body:"Project: {{project_name}}. Amount: {{amount}}.",status:"draft",reviewed:false}
test("company template persistence is scoped, immutable and permission protected",async()=>{
 allowed=false;await assert.rejects(saveCompanyWaiverTemplate(draft),/Forbidden/);assert.equal(rows.length,0)
 allowed=true;const first=await saveCompanyWaiverTemplate(draft)
 const second=await saveCompanyWaiverTemplate({...draft,status:"published",reviewed:true,body:draft.body+" Preserved exceptions."},first.id)
 assert.equal(second.revision,2);await assert.rejects(saveCompanyWaiverTemplate(draft,first.id),/newer revision/);assert.notEqual(first.id,second.id);assert.equal(first.familyId,second.familyId);assert.equal(rows[0].metadata.editable_waiver.body,draft.body)
 const listed=await listCompanyWaiverTemplates();assert.equal(listed.length,1);assert.equal(listed[0].id,second.id)
 await assert.rejects(saveCompanyWaiverTemplate(draft,randomUUID()),/Template not found/)
 await assert.rejects(saveCompanyWaiverTemplate(draft,undefined,randomUUID()),/Source document not found/)
 assert.ok(queries.every(filters=>filters.some(([k,v])=>k==="org_id"&&v===orgId)))
})

test("PDF import preserves the source and returns an unapproved editable draft",async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const form=new FormData();form.append("file",new File([await pdf.save()],"sample.pdf",{type:"application/pdf"}));
 const result=await importCompanyWaiverTemplate(form);assert.equal(result.draft.reviewed,false);assert.equal(result.draft.status,"draft");assert.equal(result.warnings[0],"Review the notary wording.");assert.equal(result.draft.warnings[0],result.warnings[0]);assert.ok(rows.some(r=>r.id===result.sourceFileId&&r.folder_path==="/Templates/Originals"));
 const saved=await saveCompanyWaiverTemplate(result.draft,undefined,result.sourceFileId);assert.equal(saved.sourceFileId,result.sourceFileId)
 const invalid=new FormData();invalid.append("file",new File(["not a pdf"],"fake.pdf"));await assert.rejects(importCompanyWaiverTemplate(invalid));
})
