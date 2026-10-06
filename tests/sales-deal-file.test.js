require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1), HOME=id(2), RES=id(3), CONTRACT=id(4), LOT=id(5), PROSPECT=id(6), COMM=id(7)
function load(file, modules) {
  const out = ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}; new Function('exports','require',out)(exports,name=>modules[name] ?? require(name)); return exports
}
function fixture({ denyHome=false, edit=false, manage=false, homeEdit=true, homeManage=true, client=null }={}) {
  const row = { deal_id:'reservation:'+RES, prospect_id:PROSPECT, reservation_id:RES, contract_id:CONTRACT, project_id:HOME, lot_id:LOT, community_id:COMM, division_id:null, buyer_name:'Buyer', stage:'contract', contract_status:'active', price_cents:30000000 }
  const pricing = { basePriceCents:30000000, lotPremiumCents:0, structuralOptions:[],designSelections:[],incentives:[],structuralOptionsCents:0,designSelectionsCents:0,incentivesCents:0,totalCents:30000000 }
  const store = { lot_reservations:[{ id:RES,org_id:ORG,lot_id:LOT,community_id:COMM,prospect_id:PROSPECT,contract_id:CONTRACT,status:'reserved',expires_at:null,asking_price_cents:'30000000',deposit_required_cents:'1000000',deposit_invoice_id:id(8),notes:null }], contracts:[{ id:CONTRACT,org_id:ORG,project_id:HOME,contract_type:'purchase_agreement',snapshot:{purchase_agreement:{pricing}} }], lots:[{id:LOT,org_id:ORG,community_id:COMM,project_id:HOME}] }
  const db=client??createFakeSupabase(store), reads=[], checks=[], failures={}
  const from=db.from.bind(db);db.from=table=>{reads.push(table);const q=from(table);if(q.run){const run=q.run.bind(q);q.run=()=>failures[table]?{data:null,error:{message:'offline'},count:null}:run()}return q}
  if (!client) db.rpc = async()=>({data:[row],error:null})
  const service=load('lib/services/sales-deals.ts',{
    '@/lib/services/context':{requireOrgContext:async()=>({supabase:db,orgId:ORG,userId:id(9)})},
    '@/lib/services/permissions':{requirePermission:async()=>{},hasPermission:async key=>key==='org.member'?edit:manage},
    '@/lib/services/authorization':{getDivisionAccessForUser:async()=>({assignedOnly:false,divisionIds:[]}),requireAuthorization:async input=>{checks.push(input);if(denyHome)throw Error('Forbidden home')},authorize:async input=>({allowed:input.permission==='project.manage'?homeEdit:homeManage})},
    '@/lib/services/prospects':{getProspect:async()=>({id:PROSPECT,status:'contacted'}),listProspectActivity:async()=>[]},
    '@/lib/services/agreement-signing-status':{getAgreementSigningState:async()=>null},
    '@/lib/validation/sales-deals':require('../lib/validation/sales-deals'),
  })
  return { ...service, store:db.store??store,row,pricing,reads,checks,failures }
}
test('deal file retains integer price/deposit and returns distinct original-owner capabilities',async()=>{
  const h=fixture({edit:true,manage:true,homeManage:false}),d=await h.getSalesDealDetail('reservation:'+RES)
  assert.equal(d.reservation.depositRequiredCents,1000000);assert.equal(d.pricing.totalCents,30000000)
  assert.deepEqual(d.capabilities,{canEditProspect:true,canManageSale:false})
  assert.equal(h.checks[0].projectId,HOME);assert.equal(h.checks[0].permission,'sales.read')
  assert.deepEqual((await fixture().getSalesDealDetail('reservation:'+RES)).capabilities,{canEditProspect:false,canManageSale:false})
})
test('denied linked home never starts reservation, agreement or lot detail reads',async()=>{
  const h=fixture({denyHome:true});await assert.rejects(h.getSalesDealDetail('reservation:'+RES),/Forbidden home/);assert.deepEqual(h.reads,[])
})
for(const table of ['lot_reservations','contracts','lots']) {
  test(`${table} failure and missing required record never render false absence`,async()=>{
    const h=fixture();h.failures[table]=true;await assert.rejects(h.getSalesDealDetail('reservation:'+RES),/Failed to load|reserved lot changed/)
    delete h.failures[table];h.store[table]=[];await assert.rejects(h.getSalesDealDetail('reservation:'+RES),/unavailable/)
  })
}
test('changed reservation, agreement and lot ancestry reject the entire file',async()=>{
  for(const [table,key] of [['lot_reservations','lot_id'],['lot_reservations','community_id'],['lot_reservations','prospect_id'],['lot_reservations','contract_id'],['contracts','project_id'],['lots','project_id'],['lots','community_id']]){
    const h=fixture();h.store[table][0][key]=id(99);await assert.rejects(h.getSalesDealDetail('reservation:'+RES),/changed|another home/)
  }
})
test('malformed monetary source cannot be replaced by zero or imprecise cents',async()=>{
  for(const value of ['','1.5','bad','9007199254740992',-1]){const h=fixture();h.store.lot_reservations[0].deposit_required_cents=value;await assert.rejects(h.getSalesDealDetail('reservation:'+RES),error=>error.name==='ZodError')}
  const h=fixture();h.store.contracts[0].snapshot.purchase_agreement.pricing.totalCents='NaN';await assert.rejects(h.getSalesDealDetail('reservation:'+RES),error=>error.name==='ZodError')
})
test('an inquiry without reservation, agreement or home remains inspectable',async()=>{
  const h=fixture();Object.assign(h.row,{reservation_id:null,contract_id:null,project_id:null,lot_id:null,community_id:null,stage:'inquiry'})
  const d=await h.getSalesDealDetail('prospect:'+PROSPECT);assert.equal(d.reservation,null);assert.equal(d.pricing,null);assert.deepEqual(h.reads,[])
})
test('actual SDK detail transport binds every original table read to organization and record',async()=>{
  const {createClient}=require('@supabase/supabase-js'),base=fixture(),calls=[]
  const client=createClient('https://isolated.example.test','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init)=>{
    const u=new URL(url);calls.push(u)
    const table=u.pathname.split('/').at(-1),data=table==='get_sales_deals'?[base.row]:base.store[table][0]
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})
  }}})
  const h=fixture({client});const d=await h.getSalesDealDetail('reservation:'+RES);assert.equal(d.reservation.depositInvoiceId,id(8))
  for(const u of calls.filter(u=>!u.pathname.includes('/rpc/'))){assert.equal(u.searchParams.get('org_id'),'eq.'+ORG);assert.ok(u.searchParams.get('id').startsWith('eq.'))}
  assert.match(calls.find(u=>u.pathname.endsWith('/contracts')).searchParams.get('select'),/project_id,contract_type,snapshot/)
})

const React=require('react'),{renderToStaticMarkup}=require('react-dom/server')
function leaf(name){return function FixtureLeaf(props){return React.createElement('div',{'data-component':name},props.children)}}
test('actual primary-action component disables reader mutations and omits their dialogs while preserving owning links',()=>{
  const modules={'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'next/link':{default:leaf('Link')},'@/components/ui/button':{Button:props=>React.createElement('button',{disabled:props.disabled},props.children)},'@/lib/sales/primary-action':require('../lib/sales/primary-action')}
  for(const [path,name] of [['find-a-home-dialog','FindAHomeDialog'],['reserve-lot-dialog','ReserveLotDialog'],['purchase-agreement-sheet','PurchaseAgreementSheet']])modules['@/components/sales/'+path]={[name]:leaf(name)}
  const {DealPrimaryAction}=load('components/sales/deal-primary-action.tsx',modules)
  for(const stage of ['inquiry','hold','contract']){
    const props={deal:{stage,contractId:null,reservationId:RES,projectId:HOME},buyer:{},reserveTarget:{},communities:[],canManageSale:false}
    const html=renderToStaticMarkup(React.createElement(DealPrimaryAction,props));assert.match(html,/disabled/);assert.doesNotMatch(html,/data-component/)
    const writable=renderToStaticMarkup(React.createElement(DealPrimaryAction,{...props,canManageSale:true}));assert.match(writable,/FindAHomeDialog/)
  }
  const linked=renderToStaticMarkup(React.createElement(DealPrimaryAction,{deal:{stage:'building',projectId:HOME},buyer:null,reserveTarget:null,communities:[],canManageSale:false}));assert.match(linked,/Schedule the closing/)
})
function elements(tree, out=[]) {
  if (!React.isValidElement(tree)) return out
  out.push(tree)
  for (const value of Object.values(tree.props)) {
    if (Array.isArray(value)) for(const child of value) elements(child,out)
    else elements(value,out)
  }
  return out
}
function pageFixture(detail, rosterError=false) {
  const names=['DealOverviewHeader','DealOverviewHistory','DealOverviewMeta'], overview=Object.fromEntries(names.map(name=>[name,leaf(name)]))
  const menu=leaf('DealActionsMenu'), primary=leaf('DealPrimaryAction')
  const page=load('app/(app)/sales/[dealId]/page.tsx',{
    'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'next/server':{connection:async()=>{}},'next/navigation':{notFound:()=>{throw Error('Not found')}},
    '@/components/layout/page-loading-skeleton':{PageLoadingSkeleton:leaf('Loading')},'@/components/layout/page-layout':{PageLayout:leaf('PageLayout')},'@/components/overview/primitives':{BAND_X:''},
    '@/components/sales/agreement-signing-recovery':{AgreementSigningRecovery:leaf('Signing')},'@/components/sales/deal-stage-track':{DealStageTrack:leaf('Stages')},
    '@/components/sales/deal-actions-menu':{DealActionsMenu:menu},'@/components/sales/deal-primary-action':{DealPrimaryAction:primary},'@/components/sales/overview':overview,
    '@/lib/sales/activity':require('../lib/sales/activity'),'@/lib/sales/deal-attention':require('../lib/sales/deal-attention'),'@/lib/sales/lost-reasons':require('../lib/sales/lost-reasons'),'@/lib/sales/primary-action':require('../lib/sales/primary-action'),
    '@/lib/services/desk-context':{getAmbientDeskContext:async()=>({communities:[]})},'@/lib/services/sales-deals':{getSalesDealDetail:async()=>detail},'@/lib/services/team':{listTeamMembers:async()=>{if(rosterError)throw Error('Roster unavailable');return[]}},'@/lib/utils':{cn:(...args)=>args.join(' ')},
  })
  const shell=page.default({params:Promise.resolve({dealId:'reservation:'+RES})})
  return { result:shell.props.children.type(shell.props.children.props), menu,primary,...overview }
}
test('deal page wires reader capabilities through menu, primary action, history and follow-up',async()=>{
  const detail=await fixture().getSalesDealDetail('reservation:'+RES),p=pageFixture(detail),tree=await p.result,all=elements(tree)
  assert.equal(all.find(e=>e.type===p.menu).props.canEditProspect,false)
  assert.equal(all.find(e=>e.type===p.menu).props.canManageSale,false)
  assert.equal(all.find(e=>e.type===p.primary).props.canManageSale,false)
  assert.equal(all.find(e=>e.type===p.DealOverviewHistory).props.canLog,false)
  assert.equal(all.find(e=>e.type===p.DealOverviewMeta).props.canEditProspect,false)
  await assert.rejects(pageFixture(detail,true).result,/Roster unavailable/)
})
test('actual actions menu omits reader controls and separates sale management from lead editing',()=>{
  const leaves=new Proxy({}, {get:(_,name)=>leaf(String(name))})
  const dependencies={'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'next/navigation':{useRouter:()=>({})},'@/hooks/use-toast':{useToast:()=>({toast:()=>{}})},'@/lib/action-result':{unwrapAction:value=>value},'@/app/(app)/sales/actions':{},'@/components/icons':leaves}
  for(const path of ['alert-dialog','button','dropdown-menu'])dependencies['@/components/ui/'+path]=leaves
  for(const path of ['edit-deal-sheet','mark-lost-dialog','release-reservation-dialog','void-agreement-dialog'])dependencies['@/components/sales/'+path]=leaves
  const {DealActionsMenu}=load('components/sales/deal-actions-menu.tsx',dependencies)
  const props={deal:{prospectId:PROSPECT,fullName:'Buyer'},teamMembers:[],communities:[],isLost:false,isClosed:false,isDeletable:true,reservation:{id:RES},agreement:{contractId:CONTRACT},canEditProspect:false,canManageSale:false}
  assert.equal(renderToStaticMarkup(React.createElement(DealActionsMenu,props)),'')
  const manager=renderToStaticMarkup(React.createElement(DealActionsMenu,{...props,canManageSale:true}))
  assert.match(manager,/Release the lot/);assert.match(manager,/Void the agreement/);assert.doesNotMatch(manager,/Edit deal|Mark lost|Delete deal|EditDealSheet|MarkLostDialog/)
  const lead=renderToStaticMarkup(React.createElement(DealActionsMenu,{...props,canEditProspect:true}))
  assert.match(lead,/Edit deal/);assert.doesNotMatch(lead,/Release the lot|Void the agreement|ReleaseReservationDialog|VoidAgreementDialog/)
})
test('original prospect reads propagate failed history sources and linked-home reads',async()=>{
  const source=fs.readFileSync('lib/services/prospects.ts','utf8'),modules={}
  for(const match of source.matchAll(/from\s+["'](@\/[^"']+)["']/g))modules[match[1]]={}
  const db=createFakeSupabase({estimates:[],events:[],prospects:[{id:PROSPECT,org_id:ORG,name:'Buyer',status:'contacted',tags:[]}],prospect_contacts:[],projects:[]})
  let failed='estimates';const from=db.from.bind(db);db.from=table=>{const q=from(table),run=q.run.bind(q);q.run=()=>table===failed?{data:null,error:{message:'offline'}}:run();return q}
  modules['@/lib/services/context']={requireOrgContext:async()=>({supabase:db,orgId:ORG,userId:id(9)})}
  modules['@/lib/services/permissions']={requireAnyPermission:async()=>{}}
  const service=load('lib/services/prospects.ts',modules)
  await assert.rejects(service.listProspectActivity(PROSPECT,ORG,60),/activity sources: offline/)
  await assert.rejects(service.getProspect(PROSPECT,ORG),/linked estimates or home/)
  failed='projects';await assert.rejects(service.getProspect(PROSPECT,ORG),/linked estimates or home/)
  failed=null;assert.deepEqual(await service.listProspectActivity(PROSPECT,ORG,60),[])
})
test('deal error boundary retries server reads and offers the owning sales desk',()=>{
  let retries=0
  const Button=leaf('Button'),Link=leaf('Link')
  const {default:ErrorPage}=load('app/(app)/sales/[dealId]/error.tsx',{'react/jsx-runtime':require('react/jsx-runtime'),'next/link':{default:Link},'@/components/ui/button':{Button}})
  const tree=ErrorPage({error:new Error('sensitive source detail'),retry:()=>retries++}),all=elements(tree)
  all.find(e=>e.type===Button && e.props.children==='Try again').props.onClick()
  assert.equal(retries,1);assert.equal(all.find(e=>e.type===Link).props.href,'/sales')
  const html=renderToStaticMarkup(tree);assert.match(html,/role="alert"/);assert.doesNotMatch(html,/sensitive source detail/)
})
