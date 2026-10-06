require('../scripts/register-ts-node-test');
const test = require('node:test'), assert = require('node:assert/strict');
const {documentFromBody,newWaiverBlock}=require('../lib/templates/waiver-document');
const {connectWaiverField,waiverSetupFields,waiverNotaryFieldKeys,waiverReviewGroups,replaceWaiverDocument,waiverActivationReviewMessage}=require('../lib/templates/waiver-setup');
const {waiverTemplateSchema}=require('../lib/templates/waiver-template');
const {resolveWaiverValues}=require('../lib/templates/waiver-engine');
const form=()=>({name:'Test',title:'Test form',status:'draft',reviewed:false,waiverType:'conditional_final',body:'Project {{project_name}}',document:documentFromBody('Project {{project_name}}')});
test('changing a built-in connection rewrites every reference without changing Arc facts',()=>{
 const draft=form();const table=newWaiverBlock('table');table.columns=['{{project_name}}'];table.rows=[['{{project_name}}']];table.condition={field:'project_name',operator:'present',value:''};draft.document.blocks.push(table);draft.document.placements=[{id:'p',key:'project_name',kind:'text',page:0,x:.1,y:.1,width:.2,height:.1}];
 const next=connectWaiverField(draft,'project_name',{source:'constant',value:'Contract-specific name'});
 assert.equal(next.key,'form_project_name');assert.match(next.draft.body,/form_project_name/);assert.equal(next.draft.document.blocks[1].condition.field,next.key);assert.equal(next.draft.document.placements[0].key,next.key);assert.equal(waiverTemplateSchema.safeParse(next.draft).success,true);
 const values=resolveWaiverValues(next.draft,{project_name:'Real project'});assert.equal(values.project_name,'Real project');assert.equal(values[next.key],'Contract-specific name');assert.equal(draft.document.fields.length,0);
});
test('existing custom connections retain type and identity, unused definitions do not become setup questions',()=>{
 const draft=form();draft.document.fields=[{key:'reference',label:'Contract ref',source:'manual',value:'',type:'text',required:true,options:[]}];assert.equal(waiverSetupFields(draft).length,1);
 draft.document.blocks[0].text+=' {{reference}} {{reference}}';const next=connectWaiverField(draft,'reference',{source:'invoice_number',value:''});assert.equal(next.key,'reference');assert.equal(next.draft.document.fields.length,1);assert.equal(next.draft.document.fields[0].required,true);assert.equal(waiverSetupFields(next.draft).length,2);
});
test('notarization grouping uses section context instead of classifying every state or county as notary data',()=>{
 const draft=form();draft.document.blocks=[newWaiverBlock('heading','Project information'),newWaiverBlock('paragraph','State {{project_state}}'),newWaiverBlock('heading','5. NOTARIZATION'),newWaiverBlock('paragraph','State {{notary_state}} County {{notary_county}}'),newWaiverBlock('heading','Other information'),newWaiverBlock('paragraph','County {{property_county}}')];
 const keys=waiverNotaryFieldKeys(draft);assert.deepEqual([...keys],['notary_state','notary_county']);
});
test('review grouping retains every original issue and its resolution',()=>{
 const draft=form();draft.document.issues=[{id:'1',message:'Compare wording.',resolved:false},{id:'2',message:'Notary signer needed.',resolved:true},{id:'3',message:'Blank original required for original mode.',resolved:false}];const groups=waiverReviewGroups(draft);assert.equal(groups.length,3);assert.equal(groups.flatMap(g=>g.issues).length,3);assert.equal(groups.find(g=>g.key==='signing').issues[0].resolved,true);
});

test('replacing a PDF retains compatible connections, new wording and mandatory review',()=>{
 const old=connectWaiverField(form(),'project_name',{source:'constant',value:'Contract name'}).draft;old.defaults={enabled:true,projectIds:[],customerName:'Builder',signerName:'',signerTitle:''};
 const incoming=form();incoming.document.blocks[0].text='Updated wording {{project_name}}';const replaced=replaceWaiverDocument(old,incoming);
 assert.match(replaced.document.blocks[0].text,/Updated wording/);assert.equal(replaced.document.fields[0].value,'Contract name');assert.equal(replaced.defaults.customerName,'Builder');assert.equal(replaced.status,'draft');assert.equal(replaced.reviewed,false);assert.equal(replaced.document.issues.at(-1).resolved,false);assert.equal(waiverTemplateSchema.safeParse(replaced).success,true);
});

test('activation explains unresolved notes even after the final checkbox was checked',()=>{
 const draft=form();draft.reviewed=true;draft.document.issues=[{id:'a',message:'Check wording',resolved:false},{id:'b',message:'Confirm notary signer',resolved:false}];
 assert.match(waiverActivationReviewMessage(draft),/2 import sections/);draft.document.issues.forEach(i=>i.resolved=true);assert.equal(waiverActivationReviewMessage(draft),null);draft.reviewed=false;assert.match(waiverActivationReviewMessage(draft),/final review checkbox/);
});
