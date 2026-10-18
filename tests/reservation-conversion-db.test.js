const { migrationSql } = require("./support/migration-sql")
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const { preparationOwner } = require('./support/reservation-creation-owners')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1), ACTOR=id(2), ROLE=id(3), RES=id(4), LOT=id(5), COMM=id(6), DIV=id(7), BUYER=id(8), HOME=id(9), REQUEST=id(10), OTHER=id(11)
const sql='supabase/migrations/20261005121409_reservation_conversion_ownership.sql'
function capturedColumns(path) {
  const blocks=JSON.parse(fs.readFileSync(path,'utf8')).content
  const raw=JSON.parse(blocks.find(x=>x.type==='text').text).result
  return JSON.parse(raw.match(/<untrusted-data-[^>]+>\n([\s\S]*?)\n<\/untrusted-data-/)[1])
}
const columns=[...capturedColumns('tests/fixtures/reservation-conversion/preparation-live-columns.json'),...capturedColumns('tests/fixtures/reservation-conversion/conversion-live-columns.json')]
async function fixture(t,{existing=false,started=false}={}) {
  const db=new PGlite();t.after(()=>db.close())
  // Partial schema with captured column types/defaults. Enum/citext are text,
  // auth.uid is a synthetic GUC and FK/trigger/migration chains are incomplete.
  // This is executable owner SQL evidence, never full-schema/JWT/race acceptance.
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table orgs(id uuid primary key,name text,billing_email text,address jsonb);
    create table app_users(id uuid primary key);create table roles(id uuid primary key);create table permissions(key text primary key);
    create table role_permissions(role_id uuid references roles,permission_key text);
    create table membership_permission_overrides(membership_id uuid,permission_key text,effect text);
    create table membership_divisions(membership_id uuid,division_id uuid);
    create table platform_memberships(id uuid primary key default gen_random_uuid(),user_id uuid,role_id uuid,status text,expires_at timestamptz);
    create function public.is_org_member(uuid) returns boolean language sql stable as $$select true$$;`)
  const tables=[...new Set(columns.map(x=>x.table_name))]
  for(const table of tables) {
    const rows=columns.filter(x=>x.table_name===table), defs=[]
    for(const c of rows) {
      const raw=c.data_type??c.type, textual=['audit_action','event_channel','membership_status','citext','project_status','project_property_type','project_work_type'].includes(raw), type=textual?'text':raw
      let def=c.default_expression
      if(textual && def) def=def.replaceAll('::'+raw,'::text')
      if(def?.includes('nextval(')) { const sequence=def.match(/nextval\('([^']+)'/)[1];await db.exec(`create sequence "${sequence}"`) }
      defs.push(`"${c.column_name}" ${type}${c.not_null?' not null':''}${def ? (table==='accounting_entity_map' && c.column_name==='scope' ? ' generated always as ('+def+') stored' : ' default '+def) : ''}${c.column_name==='id'?' primary key':''}`)
    }
    try { await db.exec(`create table public."${table}"(${defs.join(',')})`) } catch(error) { throw Error(`Fixture ${table}: ${error.message}; ${defs.join(',')}`) }
  }
  await db.exec(`create table lots(id uuid primary key,org_id uuid,community_id uuid,division_id uuid,project_id uuid,lot_number text,status text,updated_at timestamptz default now());
    create table budgets(id uuid primary key,org_id uuid,project_id uuid);create table budget_lines(id uuid primary key,org_id uuid,budget_id uuid);`)
  const authority=migrationSql("20261003232615_purchase_agreement_signing_ownership")
  await db.exec(authority.slice(authority.indexOf('create function public.assert_agreement_signing_actor'),authority.indexOf('create function public.purchase_agreement_signing_input')))
  const invoice=fs.readFileSync('supabase/migrations/20260905004943_invoice_budget_mapping.sql','utf8')
  await db.exec(invoice.slice(invoice.indexOf('create or replace function public.create_invoice_atomic'),invoice.indexOf('create or replace function public.update_invoice_atomic')))
  await db.query("insert into orgs values($1,'Builder','billing@example.test','{}')",[ORG])
  await db.query('insert into app_users values($1),($2)',[ACTOR,OTHER]);await db.query('insert into roles values($1)',[ROLE]);await db.exec("insert into permissions values('sales.manage')")
  await db.query("insert into role_permissions values($1,'sales.manage'),($1,'project.read')",[ROLE])
  await db.query("insert into memberships(org_id,user_id,role_id,status) values($1,$2,$3,'active'),($1,$4,$3,'active')",[ORG,ACTOR,ROLE,OTHER])
  await db.query("insert into communities(id,org_id,division_id,name) values($1,$2,$3,'Community')",[COMM,ORG,DIV])
  await db.query("insert into contacts(id,org_id,full_name,email) values($1,$2,'Original buyer','buyer@example.test')",[BUYER,ORG])
  if(existing) await db.query("insert into projects(id,org_id,name,status,property_type,division_id) values($1,$2,'Spec home','active','production',$3)",[HOME,ORG,DIV])
  await db.query("insert into lots(id,org_id,community_id,division_id,project_id,lot_number,status) values($1,$2,$3,$4,$5,'47',$6)",[LOT,ORG,COMM,DIV,existing?HOME:null,started?'started':'developed'])
  await db.query("insert into lot_reservations(id,org_id,community_id,lot_id,buyer_contact_id,expires_at) values($1,$2,$3,$4,$5,clock_timestamp()+interval '1 day')",[RES,ORG,COMM,LOT,BUYER])
  await db.exec(fs.readFileSync(sql,'utf8'))
  const owner=preparationOwner(), scope={orgId:ORG,actorId:ACTOR,reservationId:RES}
  async function prepare(deposit=500001,key=REQUEST,actor=ACTOR) {
    const expected=(await db.query('select public.reservation_conversion_source($1,$2) v',[ORG,RES])).rows[0].v
    const input={reservationId:RES,depositCents:deposit,projectName:null}
    const bundle=owner.prepareReservationConversionBundle({context:{orgId:ORG,userId:actor,productTier:'commercial'},requestKey:key,input,expected})
    return {input,bundle,key,actor}
  }
  async function rpc(action,p={},role='service_role') {
    await db.exec(`set role ${role}`)
    try { return (await db.query('select public.reservation_conversion($1,$2,$3,$4,$5,$6,$7) v',[ORG,p.actor??ACTOR,RES,action,p.key??null,p.input??null,p.bundle??null])).rows[0].v }
    finally { await db.exec('reset role') }
  }
  async function counts() {
    const result={}
    for(const table of ['projects','contracts','project_financial_settings','invoice_lines','invoices','outbox','audit_log','events','reservation_conversion_receipts']) result[table]=Number((await db.query(`select count(*) n from ${table}`)).rows[0].n)
    return result
  }
  return {db,scope,prepare,rpc,counts}
}
test('saved review creates no home or invoice; atomic commit opens the home with no placeholder contract and preserves original financial owners and exact cents',async t=>{
  const h=await fixture(t),p=await h.prepare();const review=await h.rpc('register',p)
  assert.equal(review.status,'pending');assert.equal(review.review.buyerName,'Original buyer');assert.equal(review.review.createsHome,true)
  assert.equal((await h.counts()).projects,0);assert.equal((await h.counts()).invoices,0)
  const result=await h.rpc('commit',p);assert.equal(result.status,'committed');assert.equal(result.receipt.projectId,p.bundle.projectId)
  const totals=await h.counts();assert.equal(totals.projects,1);assert.equal(totals.contracts,0);assert.equal(totals.project_financial_settings,1)
  assert.equal(totals.invoices,1);assert.equal(totals.invoice_lines,1);assert.equal(totals.reservation_conversion_receipts,1)
  const settings=(await h.db.query('select * from project_financial_settings')).rows[0]
  assert.equal(settings.billing_model,'fixed_price');assert.equal(settings.cost_codes_enabled,null);assert.equal(settings.open_book_required,false)
  assert.equal(p.bundle.billingContract,null)
  const invoice=(await h.db.query('select * from invoices')).rows[0];assert.equal(invoice.total_cents,500001);assert.equal(invoice.product_posture,'production')
  assert.deepEqual(invoice.sent_to_emails,['buyer@example.test']);assert.equal(invoice.issued_snapshot.totals.total_cents,500001)
  assert.equal(Number((await h.db.query('select unit_price_cents from invoice_lines')).rows[0].unit_price_cents),500001)
  assert.equal((await h.db.query('select division_id from projects')).rows[0].division_id,DIV)
  assert.equal((await h.db.query("select count(*) n from outbox where job_type='issue_invoice'")).rows[0].n,1)
  assert.equal((await h.db.query("select count(*) n from audit_log where entity_type='lot'")).rows[0].n,1)
})
test('lost commit reply replays one immutable receipt and cannot reuse its key for changed money',async t=>{
  const h=await fixture(t),p=await h.prepare();await h.rpc('register',p);const first=await h.rpc('commit',p),before=await h.counts()
  await h.db.query("update contacts set full_name='Renamed after commit' where id=$1",[BUYER])
  const replay=await h.rpc('commit',p);assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.review.buyerName,'Original buyer');assert.deepEqual(await h.counts(),before)
  await assert.rejects(h.rpc('commit',{...p,input:{...p.input,depositCents:1}}),/Changed inputs/)
  await assert.rejects(h.db.exec("update reservation_conversion_receipts set invoice_id=null"),/immutable/)
  await assert.rejects(h.db.exec("delete from reservation_conversion_requests"),/immutable/)
})
test('injected failure after invoice creation rolls back home, financial setup, invoice, lot and every completion record',async t=>{
  const h=await fixture(t),p=await h.prepare();await h.rpc('register',p)
  await h.db.exec(`create function fail_completion() returns trigger language plpgsql as $$begin if new.entity_type='lot_reservation' then raise exception 'injected completion failure';end if;return new;end$$;create trigger fail_completion before insert on audit_log for each row execute function fail_completion();`)
  await assert.rejects(h.rpc('commit',p),/injected completion failure/)
  const counts=await h.counts();for(const table of Object.keys(counts))assert.equal(counts[table],0,table)
  assert.equal((await h.db.query('select project_id from lots')).rows[0].project_id,null)
  assert.equal((await h.db.query('select status from lot_reservations')).rows[0].status,'hold')
  assert.equal((await h.rpc('inspect',{key:p.key})).latest.status,'pending')
})
test('changed source stays inspectable and creates no deposit; cancellation closes the original key',async t=>{
  const h=await fixture(t),p=await h.prepare();await h.rpc('register',p)
  await h.db.query("update contacts set email='changed@example.test' where id=$1",[BUYER])
  assert.equal((await h.rpc('inspect')).latest.status,'changed');await assert.rejects(h.rpc('commit',p),/source changed/)
  assert.equal((await h.counts()).invoices,0)
  assert.equal((await h.rpc('cancel',p)).status,'cancelled');await assert.rejects(h.rpc('commit',p),/Cancelled/)
  assert.equal((await h.rpc('register',p)).status,'cancelled');assert.equal((await h.counts()).projects,0)
})
test('current permission revocation and explicit deny prevent commit and recovery access',async t=>{
  const h=await fixture(t),p=await h.prepare();await h.rpc('register',p)
  await h.db.query("insert into membership_permission_overrides select id,'sales.manage','deny' from memberships where user_id=$1",[ACTOR])
  await assert.rejects(h.rpc('commit',p),/lacks organization/);await assert.rejects(h.rpc('inspect'),/lacks organization/)
  assert.equal((await h.counts()).projects,0);assert.equal((await h.counts()).invoices,0)
})
test('sequential competing actors have one commit; this is not independent-session race evidence',async t=>{
  const h=await fixture(t),a=await h.prepare(),b=await h.prepare(500001,id(12),OTHER)
  await h.rpc('register',a);await h.rpc('register',b);await h.rpc('commit',a)
  await assert.rejects(h.rpc('commit',b),/source changed/)
  assert.equal((await h.counts()).projects,1);assert.equal((await h.counts()).invoices,1)
})
test('existing started home and zero deposit keep the existing project and create no billing contract',async t=>{
  const h=await fixture(t,{existing:true,started:true}),p=await h.prepare(0)
  await h.rpc('register',p);const result=await h.rpc('commit',p)
  assert.equal(result.receipt.projectId,HOME);assert.equal(result.receipt.invoiceId,null)
  const counts=await h.counts();assert.equal(counts.projects,1);assert.equal(counts.contracts,0);assert.equal(counts.invoices,0)
  assert.equal((await h.db.query('select status from lots')).rows[0].status,'started')
})
test('only the private server RPC is granted; another actor cannot inspect the original key',async t=>{
  const h=await fixture(t),p=await h.prepare();await h.rpc('register',p)
  await assert.rejects(h.rpc('inspect',{},'anon'),/permission denied/)
  await assert.rejects(h.rpc('inspect',{},'authenticated'),/permission denied/)
  await assert.rejects(h.rpc('inspect',{key:p.key,actor:OTHER}),/another context/)
  await h.db.exec('set role service_role');await assert.rejects(h.db.exec('select * from reservation_conversion_requests'),/permission denied/);await h.db.exec('reset role')
  await h.db.query("select set_config('request.jwt.claim.sub',$1,false)",[OTHER]);await assert.rejects(h.rpc('commit',p),/actor mismatch/)
})
