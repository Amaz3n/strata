require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {physicalWaiverTemplate}=require('../lib/templates/waiver-physical')
test('paper preparation leaves manual notary entries blank and preserves business defaults and wording',()=>{
 const template={body:'Original wording',document:{fields:[{key:'notary_signature',label:'Notary signature',source:'manual',type:'text',required:true,value:'old signature'},{key:'notary_state',label:'State',source:'constant',type:'text',required:true,value:'FL'},{key:'amount',label:'Amount',source:'manual',type:'currency',required:true,value:''}]}}
 const paper=physicalWaiverTemplate(template)
 assert.equal(paper.document.fields[0].value,'________________')
 assert.equal(paper.document.fields[0].required,false)
 assert.equal(paper.document.fields[1].value,'FL')
 assert.deepEqual(paper.document.fields[2],template.document.fields[2])
 assert.equal(paper.body,template.body)
 assert.equal(template.document.fields[0].value,'old signature')
})
