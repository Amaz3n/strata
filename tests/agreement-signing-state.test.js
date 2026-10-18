require('../scripts/register-ts-node-test')
const assert=require('node:assert/strict'),test=require('node:test')
const {deriveAgreementSigningState:derive,signingState,packetStaleState}=require('../lib/sales/agreement-signing-state')
const buyer={id:'buyer-request',status:'sent',sequence:1,required:true,signerRole:'buyer',contactId:'buyer',deliveryStatus:null,providerId:null}
const builder={id:'builder-request',status:'draft',sequence:2,required:true,signerRole:'builder',contactId:null,deliveryStatus:null,providerId:null}
const base={documentId:'document',documentStatus:'sent',envelopeStatus:'sent',owned:true,buyerId:'buyer',coBuyerId:null,canManage:true,requests:[buyer,builder]}
test('draft contracts never imply an invitation was sent or accepted',()=>{
 assert.equal(signingState('not_prepared').stage,'not_prepared')
 assert.equal(derive({...base,documentStatus:'draft',envelopeStatus:null,requests:[]}).stage,'prepared')
 assert.equal(derive({...base,documentStatus:'draft',envelopeStatus:null,requests:[],owned:false}).canResume,false)
 assert.equal(derive(base).stage,'queued')
 for(const deliveryStatus of [null,'delayed'])assert.equal(derive({...base,requests:[{...buyer,deliveryStatus,providerId:'receipt'},builder]}).stage,'queued')
 assert.equal(derive({...base,requests:[{...buyer,deliveryStatus:'accepted',providerId:'receipt'},builder]}).stage,'awaiting_buyer')
 const viewed=derive({...base,requests:[{...buyer,status:'viewed'},builder]})
 assert.equal(viewed.stage,'awaiting_buyer');assert.ok(!viewed.detail.includes('accepted'))
})
test('buyer and builder routing uses exact required roles and contact identities',()=>{
 assert.equal(derive({...base,requests:[{...buyer,status:'signed'},{...builder,status:'sent'}]}).stage,'awaiting_builder')
 for(const change of [{contactId:'foreign'},{sequence:2},{required:false},{signerRole:'other'}])assert.equal(derive({...base,requests:[{...buyer,...change},builder]}).stage,'reconcile')
 for(const requests of [[],[buyer],[buyer,buyer,builder],[buyer,{...builder,status:'signed'}]])assert.equal(derive({...base,requests}).stage,'reconcile')
 const co={...buyer,id:'co-request',signerRole:'co_buyer',contactId:'co',status:'signed'}
 assert.equal(derive({...base,coBuyerId:'co',requests:[{...buyer,status:'signed'},co,builder]}).stage,'awaiting_builder')
})
test('failure evidence, incomplete execution and conflicting lifecycle records require attention',()=>{
 for(const deliveryStatus of ['failed','bounced','complained'])assert.equal(derive({...base,requests:[{...buyer,deliveryStatus},builder]}).stage,'delivery_failed')
 const signed=[{...buyer,status:'signed'},{...builder,status:'signed'}]
 assert.equal(derive({...base,requests:signed}).stage,'reconcile')
 assert.equal(derive({...base,documentStatus:'signed',envelopeStatus:'executed',requests:signed}).stage,'completed')
 for(const envelopeStatus of ['voided','expired',null])assert.equal(derive({...base,envelopeStatus}).stage,'reconcile')
 assert.equal(derive({...base,requests:[{...buyer,status:'voided'},builder]}).stage,'reconcile')
 assert.equal(derive({...base,documentStatus:'draft',envelopeStatus:'draft',requests:[{...buyer,status:'draft'},builder],canManage:false}).canResume,false)
})


test('sales attention uses evidence labels and never infers sent invitations from a draft',()=>{
 const {dealAttentionItems}=require('../lib/sales/deal-attention')
 const now=new Date('2026-10-03T12:00:00Z'),deal={stage:'contract',contractStatus:'draft',contractId:'contract',projectId:'home',createdAt:now.toISOString()}
 const input={deal,reservation:null,hasContactDetails:true,ownerAssigned:true,lastTouchAt:now.toISOString()}
 const missing=dealAttentionItems(input,now).find(r=>r.kind==='agreement')
 assert.equal(missing.title,'Agreement signing status needs verification')
 for(const stage of ['not_prepared','queued','awaiting_builder','delivery_failed']){
  const signing=signingState(stage)
  assert.equal(dealAttentionItems({...input,signing},now).find(r=>r.kind==='agreement').title,signing.title)
 }
})


test('board next action and deal header do not invent delivery from a draft',()=>{
 const {resolveDealPrimaryAction}=require('../lib/sales/primary-action')
 const {nextActionFor}=require('../lib/sales/next-action')
 const deal={stage:'contract',contractStatus:'draft',contractId:'contract',projectId:'home'}
 assert.ok(!resolveDealPrimaryAction(deal).hint.includes('Out for signature'))
 const state=signingState('not_prepared')
 assert.equal(resolveDealPrimaryAction(deal,state).hint,state.detail)
 assert.equal(nextActionFor(deal).label,'Review agreement signing')
})
test('a draft whose packet went stale says why and offers a refresh only to a seller who can make one',()=>{
 const stale=packetStaleState('This agreement\'s packet is missing the required addendum HOA disclosure.',true)
 assert.equal(stale.stage,'packet_stale');assert.match(stale.detail,/HOA disclosure/);assert.equal(stale.canResume,true)
 assert.equal(packetStaleState('Withdrawn',false).canResume,false)
})
