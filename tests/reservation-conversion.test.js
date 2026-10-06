require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const {createFakeSupabase}=require('./support/fake-supabase')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1),RES=id(2),LOT=id(3),BUYER=id(4),COMM=id(5),HOME=id(6),DIV=id(7)
function fixture({newHome=false,denied=false,divisions=null,client=null}={}) {
  const stamp='2026-10-01T00:00:00.000Z',calls=[],updates=[],events=[],failures={}
  const lot={id:LOT,org_id:ORG,community_id:COMM,division_id:DIV,lot_number:'47',status:'assigned',project_id:newHome?null:HOME,updated_at:stamp}
  const tables={lot_reservations:[{id:RES,org_id:ORG,lot_id:LOT,community_id:COMM,buyer_contact_id:BUYER,co_buyer_contact_id:null,prospect_id:null,status:'hold',expires_at:new Date(Date.now()+86400000).toISOString(),updated_at:stamp,deposit_invoice_id:null,contract_id:null,lot}],lots:[lot],communities:[{id:COMM,org_id:ORG,division_id:DIV}],contacts:[{id:BUYER,org_id:ORG}],invoices:[],contracts:[],projects:[{id:HOME,org_id:ORG,property_type:'production',client_id:null,updated_at:stamp}]};const db=client??createFakeSupabase(tables)
  let moveHold=false;const from=db.from.bind(db)
  db.from=table=>{const q=from(table);if(typeof q.run!=='function')return q;const update=q.update.bind(q),run=q.run.bind(q);let write=false
    q.update=input=>{write=true;updates.push({table,input});return update(input)}
    q.run=()=>{
      if(failures[table] && (failures[table]==='read'?!write:write))return {data:null,error:{message:'offline'},count:null}
      if(table==='lot_reservations' && write && moveHold)db.store.lot_reservations[0].status='released'
      const result=run()
      if(write && q.cardinality==='maybe' && Array.isArray(result.data)) return {data:result.data[0]??null,error:result.error}
      return result
    };return q}
  const source=fs.readFileSync('lib/services/community-sales.ts','utf8'),modules={zod:require('zod')}
  for(const match of source.matchAll(/from\s+["'](@\/[^"']+)["']/g))modules[match[1]]={}
  Object.assign(modules,{
    '@/lib/services/context':{requireOrgContext:async()=>({supabase:db,orgId:ORG,userId:id(9)})},
    '@/lib/services/reservation-conversion':{reservationConversionEnabled:()=>false},
    '@/lib/services/permissions':{requirePermission:async()=>{}},
    '@/lib/services/authorization':{getDivisionAccessForUser:async()=>({assignedOnly:divisions!==null,divisionIds:divisions??[]}),requireAuthorization:async()=>{if(denied)throw Error('Forbidden home')}},
    '@/lib/services/projects':{createProject:async input=>{calls.push({kind:'home',input});return {id:HOME}}},
    '@/lib/services/invoices':{createInvoice:async input=>{calls.push({kind:'invoice',input});return {id:id(20)}}},
    '@/lib/services/events':{recordEvent:async input=>events.push(input)},
    '@/lib/validation/community-sales':require('../lib/validation/community-sales'),
  })
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,exports={}
  new Function('exports','require',compiled)(exports,name=>modules[name]??require(name))
  return {...exports,store:db.store??tables,calls,updates,events,failures,moveHold:()=>{moveHold=true},convert:(depositCents=0)=>exports.convertHoldToReservation({reservationId:RES,depositCents})}
}
test('valid existing-home conversion uses original owners and exact integer deposit',async()=>{
  const h=fixture();const result=await h.convert(500001)
  assert.equal(result.status,'reserved');assert.equal(h.calls.length,1);assert.equal(h.calls[0].kind,'invoice')
  assert.equal(h.calls[0].input.input.lines[0].unit_cost,5000.01)
  assert.equal(h.store.lot_reservations[0].deposit_required_cents,500001);assert.equal(h.events.length,1)
})
test('zero deposit makes no invoice and unsafe or fractional cents reject before writes',async()=>{
  const h=fixture();await h.convert();assert.equal(h.calls.length,0)
  for(const value of [0.5,-1,2147483648,Number.MAX_SAFE_INTEGER+1]){const bad=fixture();await assert.rejects(bad.convert(value),e=>e.name==='ZodError');assert.equal(bad.updates.length,0)}
})
test('expired, malformed, foreign and already-linked hold sources reject before side effects',async()=>{
  const changes=[r=>r.expires_at='2020-01-01T00:00:00.000Z',r=>r.status='reserved',r=>r.org_id=id(99),r=>r.lot.org_id=id(99),r=>r.lot.community_id=id(99),r=>r.lot.status='closed',r=>r.buyer_contact_id=id(99),r=>r.co_buyer_contact_id=id(99),r=>r.co_buyer_contact_id=BUYER,r=>r.deposit_invoice_id=id(99),r=>r.contract_id=id(99)]
  for(const change of changes){const h=fixture();change(h.store.lot_reservations[0]);await assert.rejects(h.convert(500000));assert.equal(h.calls.length,0);assert.equal(h.updates.length,0)}
})
test('missing community, moved division, denied home and preexisting sale reject before writes',async()=>{
  const changes=[h=>h.store.communities=[],h=>h.store.communities[0].division_id=id(99),h=>h.store.projects[0].client_id=id(99),h=>h.store.projects[0].property_type='commercial',h=>h.store.contracts.push({id:id(20),org_id:ORG,project_id:HOME,contract_type:'purchase_agreement',status:'active'})]
  for(const change of changes){const h=fixture();change(h);await assert.rejects(h.convert());assert.equal(h.updates.length,0)}
  for(const opts of [{denied:true},{divisions:[]},{divisions:[id(99)]}]){const h=fixture(opts);await assert.rejects(h.convert());assert.equal(h.updates.length,0)}
})
test('failed source inspection and an earlier deposit cannot masquerade as clean conversion',async()=>{
  for(const table of ['lot_reservations','communities','contacts','invoices','projects','contracts']){const h=fixture();h.failures[table]='read';await assert.rejects(h.convert(500000),/verify|verified/);assert.equal(h.calls.length,0);assert.equal(h.updates.length,0)}
  const h=fixture();h.store.invoices.push({id:id(20),org_id:ORG,metadata:{invoice_kind:'earnest_deposit',source_reservation_id:RES}})
  await assert.rejects(h.convert(500000),/previous deposit/);assert.equal(h.calls.length,0)
})
test('failed home assignment or lot link prevents a new deposit and reports partial home creation',async()=>{
  const h=fixture();h.failures.projects='write';await assert.rejects(h.convert(500000),/No new deposit/);assert.equal(h.calls.length,0)
  const fresh=fixture({newHome:true});fresh.failures.lots='write';await assert.rejects(fresh.convert(500000),/home was created/)
  assert.deepEqual(fresh.calls.map(c=>c.kind),['home']);assert.equal(fresh.events.length,0)
})
test('a changed hold is not overwritten or announced, but post-invoice partial state still needs atomic receipt',async()=>{
  const h=fixture();h.moveHold();await assert.rejects(h.convert(500000),/completion could not be confirmed/)
  assert.equal(h.store.lot_reservations[0].status,'released');assert.equal(h.events.length,0)
  assert.equal(h.calls.filter(c=>c.kind==='invoice').length,1,'This exposes the remaining transaction gap; it is not atomic completion acceptance')
})

test('actual SDK writes bind the original home client/version and live hold version; missing reply remains unconfirmed',async()=>{
  const {createClient}=require('@supabase/supabase-js')
  for(const missing of [false,true]){
    const base=fixture(),requests=[]
    const client=createClient('https://isolated.example.test','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init)=>{
      const u=new URL(url),table=u.pathname.split('/').at(-1);requests.push({u,method:init.method,body:init.body?JSON.parse(init.body):null})
      let data=['contacts','contracts','invoices'].includes(table)?base.store[table]:base.store[table][0]
      if(init.method==='PATCH') data=table==='projects'?{id:HOME}:missing?null:{...base.store.lot_reservations[0],status:'reserved',deposit_required_cents:500001,deposit_invoice_id:id(20)}
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})
    }}})
    const h=fixture({client})
    if(missing)await assert.rejects(h.convert(500001),/completion could not be confirmed/);else assert.equal((await h.convert(500001)).status,'reserved')
    const writes=requests.filter(r=>r.method==='PATCH');assert.equal(writes.length,2)
    assert.equal(writes[0].u.searchParams.get('client_id'),'is.null')
    for(const r of writes){assert.equal(r.u.searchParams.get('org_id'),'eq.'+ORG);assert.equal(r.u.searchParams.get('updated_at'),'eq.2026-10-01T00:00:00.000Z')}
    const last=writes[1];assert.equal(last.u.searchParams.get('status'),'eq.hold');assert.equal(last.u.searchParams.get('deposit_invoice_id'),'is.null');assert.match(last.u.searchParams.get('or'),/expires_at.gt/)
    assert.equal(last.body.deposit_required_cents,500001);assert.equal(h.events.length,missing?0:1)
  }
})

test('reservation deposit input preserves cents and rejects blank, malformed and database-overflow amounts',()=>{
  const {parseReservationDeposit,reservationDepositInput}=require('../lib/sales/reservation-deposit')
  assert.equal(reservationDepositInput(500001),'5000.01');assert.equal(parseReservationDeposit('5000.01'),500001)
  assert.equal(parseReservationDeposit('$5,000.01'),500001);assert.equal(parseReservationDeposit('1.005'),101)
  assert.equal(parseReservationDeposit('21474836.47'),2147483647);assert.equal(parseReservationDeposit('0'),0)
  for(const value of ['', ' ', '1.2.3','-0.01','21474836.48','99999999999999999999'])assert.equal(parseReservationDeposit(value),null)
})
