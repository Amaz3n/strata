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
const background=[]
let beforeUpdate, updateError;
const column=(row,key)=> key.startsWith("metadata->editable_waiver->>") ? (row.metadata?.editable_waiver?.[key.split("->>")[1]] ?? null) : row[key];
const supabase={from(table){const filters=[];let patch, ordering, limit;
 const execute=()=>{queries.push(filters);if(patch && beforeUpdate){const hook=beforeUpdate;beforeUpdate=undefined;hook();}if(patch && updateError)return {data:null,error:updateError};const selected=rows.filter(r=>filters.every(([k,v,operator])=>operator==="gt" ? column(r,k)>v : column(r,k)===v)).slice().reverse();if(ordering==="id")selected.sort((a,b)=>a.id.localeCompare(b.id));if(limit!==undefined)selected.splice(limit);if(patch)selected.forEach(row=>Object.assign(row,patch));return {data:structuredClone(selected),error:null};};
 const q={update(value){patch=value;return q},select(){return q},eq(key,value){assert.notEqual(key,"metadata","Never send a whole document in the request URL");filters.push([key,value]);return q},is(key,value){filters.push([key,value]);return q},gt(key,value){filters.push([key,value,"gt"]);return q},order(key){ordering=key;return q},limit(value){limit=value;return q},single(){const r=execute();return Promise.resolve({data:r.data?.[0],error:r.error??(r.data?.length?null:{message:"missing"})})},maybeSingle(){const r=execute();return Promise.resolve({data:r.data?.[0]??null,error:r.error})},then(resolve){return Promise.resolve(execute()).then(resolve)}};return q;}};

Module._load=function(request,parent,isMain){
 if(request==="@/lib/services/mupdf-loader")return {loadMupdf:()=>import("mupdf")}
 if(request==="@/lib/services/context")return {requireOrgContext:async()=>({orgId,userId,supabase})}
 if(request==="@/lib/services/authorization")return {requireAuthorization:async()=>{if(!allowed)throw new Error("Forbidden")}}
 if(request==="@/lib/services/ai/gateway")return {runAiObject:async(input)=>{const schema=require("ai").zodSchema(input.schema).jsonSchema;function check(node){if(!node||typeof node!=="object")return;if(node.properties)assert.deepEqual([...(node.required||[])].sort(),Object.keys(node.properties).sort());for(const child of Object.values(node))if(Array.isArray(child))child.forEach(check);else check(child)}check(schema);assert.equal(schema.properties.document.properties.version.type,"integer");assert.equal(schema.properties.document.properties.version.const,undefined);assert.equal(schema.properties.document.properties.version.enum,undefined);assert.equal(input.feature,"document_extraction");assert.equal(input.orgId,orgId);assert.equal(input.files[0].mediaType,"application/pdf");return {ok:true,object:{isWaiver:true,name:"Imported waiver",title:"Waiver",waiverType:"conditional_progress",body:"Project: {{project_name}}. Exceptions remain unchanged.",document:{...require("../lib/templates/waiver-document").documentFromBody("Project: {{project_name}}. Exceptions remain unchanged."),fields:[{key:"project_name",label:"Project",type:"text",source:"manual",value:"",required:true,options:[]}]},warnings:["Review the notary wording."]}}}}
 if(request==="next/server")return {after(callback){background.push(callback)}}
 if(request==="next/cache")return {revalidatePath(){}}
 if(request==="@/lib/services/generated-documents")return {storeGeneratedPdf:async(input)=>{assert.equal(input.orgId,orgId);assert.equal(input.projectId,null);assert.equal(input.shareWithClients,undefined);assert.ok((await PDFDocument.load(input.pdf)).getPageCount()>=1);const id=randomUUID();rows.push({id,org_id:input.orgId,folder_path:input.folderPath,metadata:input.metadata,archived_at:null,created_at:new Date().toISOString()});return {fileId:id,storagePath:"test"}}}
 return load.call(this,request,parent,isMain)
}
const {saveCompanyWaiverTemplate,listCompanyWaiverTemplates,importCompanyWaiverTemplate,beginCompanyWaiverImport,getCompanyWaiverImport,listWaiverExampleInvoices}=require("../app/(app)/settings/templates/waiver-actions")
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
 const result=await importCompanyWaiverTemplate(form);assert.equal(result.draft.document.fields.length,0);assert.equal(result.draft.reviewed,false);assert.equal(result.draft.status,"draft");assert.equal(result.warnings[0],"Review the notary wording.");assert.equal(result.draft.warnings[0],result.warnings[0]);assert.ok(rows.some(r=>r.id===result.sourceFileId&&r.folder_path==="/Templates/Originals"));
 const saved=await saveCompanyWaiverTemplate(result.draft,undefined,result.sourceFileId);assert.equal(saved.sourceFileId,result.sourceFileId)
 const invalid=new FormData();invalid.append("file",new File(["not a pdf"],"fake.pdf"));await assert.rejects(importCompanyWaiverTemplate(invalid));
})

test("background imports persist a resumable result and remain organization scoped",async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const form=new FormData();form.append("file",new File([await pdf.save()],"background.pdf",{type:"application/pdf"}));
 const {sourceFileId}=await beginCompanyWaiverImport(form);
 assert.equal((await getCompanyWaiverImport(sourceFileId)).status,"reading");
 assert.equal(background.length,1);await background.shift()();
 const ready=await getCompanyWaiverImport(sourceFileId);assert.equal(ready.status,"ready");assert.equal(ready.draft.reviewed,false);
 const row=rows.find(r=>r.id===sourceFileId);row.org_id=randomUUID();await assert.rejects(getCompanyWaiverImport(sourceFileId),/unavailable/);row.org_id=orgId;
 row.metadata={waiver_import:{status:"reading",startedAt:new Date(Date.now()-190000).toISOString()}};assert.match((await getCompanyWaiverImport(sourceFileId)).message,/interrupted/);
})

test("example invoice listing requires template permission and scopes results to organization and project",async()=>{
 const project=randomUUID(),id=randomUUID();rows.push({id,org_id:orgId,project_id:project,invoice_number:"SAMPLE-1"});rows.push({id:randomUUID(),org_id:randomUUID(),project_id:project,invoice_number:"OTHER-ORG"});allowed=false;await assert.rejects(listWaiverExampleInvoices(project),/Forbidden/);allowed=true;assert.deepEqual(await listWaiverExampleInvoices(project),[{id,label:"SAMPLE-1"}]);assert.deepEqual(await listWaiverExampleInvoices(randomUUID()),[]);
});

test("large drafts save repeatedly with short version filters and reject stale or racing edits",async()=>{
 const large={...draft,body:('Preserve this clause. '.repeat(900))+'{{project_name}}'};
 const first=await saveCompanyWaiverTemplate(large);assert.ok(first.editToken);
 const second=await saveCompanyWaiverTemplate({...large,name:'Changed name'},first.id,undefined,first.editToken);
 assert.equal(second.id,first.id);assert.notEqual(second.editToken,first.editToken);assert.equal(rows.find(r=>r.id===first.id).metadata.editable_waiver.name,'Changed name');
 await assert.rejects(saveCompanyWaiverTemplate(large,first.id,undefined,first.editToken),/changed elsewhere/);
 beforeUpdate=()=>{rows.find(r=>r.id===first.id).metadata.editable_waiver.editToken=randomUUID()};
 await assert.rejects(saveCompanyWaiverTemplate(large,second.id,undefined,second.editToken),/changed elsewhere/);
 assert.ok(queries.every(filters=>JSON.stringify(filters).length<2000));
});
test("legacy drafts gain a version token and database failures are not reported as conflicts",async()=>{
 const first=await saveCompanyWaiverTemplate(draft);delete rows.find(r=>r.id===first.id).metadata.editable_waiver.editToken;
 const saved=await saveCompanyWaiverTemplate(draft,first.id);assert.ok(saved.editToken);
 updateError={code:'42501'};
 try{await assert.rejects(saveCompanyWaiverTemplate(draft,saved.id,undefined,saved.editToken),/Unable to save this draft/)}finally{updateError=undefined}
});
