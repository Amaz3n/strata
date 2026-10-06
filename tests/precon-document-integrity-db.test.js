const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs')
const { PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const org='20000000-0000-0000-0000-000000000001',actor='10000000-0000-0000-0000-000000000001',lead='30000000-0000-0000-0000-000000000001',job='50000000-0000-0000-0000-000000000001',doc='40000000-0000-0000-0000-000000000001',other='40000000-0000-0000-0000-000000000002'
test('latest executed-deal migration enforces commercial continuity and document integrity',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(fs.readFileSync('tests/fixtures/precon-handoff-schema.sql','utf8'))
 await db.exec(`alter table public.estimates add title text,add version integer default 1,add created_at timestamptz default now(),add sent_at timestamptz,add client_signed_at timestamptz,add token_hash text,add recipient_contact_id uuid,add valid_until date,add tax_cents integer;alter table public.estimate_items add cost_code_id uuid,add unit text,add markup_pct numeric,add sort_order integer;`)
 for(const file of ['20260921121029_precon_workspace.sql','20260921121038_precon_transactional_handoff.sql','20260921121045_optional_preconstruction_project_start.sql','20260922183258_executed_agreement_project_conversion.sql','20261001121457_precon_document_integrity.sql'])await db.exec(fs.readFileSync(`supabase/migrations/${file}`,'utf8'))
 const one=async sql=>(await db.query(sql)).rows[0]
 const reset=async(status='executed',purpose='construction_agreement')=>{
  await db.exec(`truncate public.estimate_review_links,public.file_links,public.events,public.precon_decisions,public.precon_workspaces,public.contracts,public.budgets,public.estimates,public.files,public.prospect_contacts,public.contacts,public.project_financial_settings,public.projects,public.prospects,public.orgs,public.app_users cascade;insert into public.orgs values('${org}','Builder');insert into public.app_users values('${actor}','builder@example.test');insert into public.prospects(id,org_id,name,status) values('${lead}','${org}','Kitchen','pricing');`)
  await db.query(`insert into public.estimates(id,org_id,prospect_id,title,status,metadata,total_cents,subtotal_cents,executed_at) values($1,$2,$3,'Kitchen',$4,$5,100000,90000,case when $4='executed' then now() else null end)`,[doc,org,lead,status,JSON.stringify({precon:{purpose,billing_model:'fixed_price',retainage_percent:5},accepted_options:{ids:['option'],accepted_total_cents:125000}})])
 }
 const start=async(expected=null,reviewed=doc)=>(await db.query('select public.start_prospect_project($1,$2,$3,$4,$5,$6) result',[org,lead,actor,expected,'residential',reviewed])).rows[0].result
 const issue=async(token,revoke=false)=>{const row=await one('select updated_at::text stamp from public.estimates');return db.query('select public.issue_estimate_review_link($1,$2,$3,$4,$5)',[org,doc,token,row.stamp,revoke])}
 await t.test('actual SQL gate rejects proposal, services, pending signature, missing and obsolete agreements',async()=>{
  for(const [status,purpose] of [['approved','budget'],['executed','preconstruction_agreement'],['client_signed','construction_agreement'],['draft','construction_agreement']]){await reset(status,purpose);await assert.rejects(start(),/Execute/);assert.equal((await one('select count(*)::int n from public.projects')).n,0)}
  await reset();await db.exec('delete from public.estimates');await assert.rejects(start(),/Execute/)
  await reset();await db.exec('update public.estimates set is_current_version=false');await assert.rejects(start(),/Execute/)
  await reset();await assert.rejects(start(null,other),/agreement changed/)
 })
 await t.test('all signed billing models and accepted option totals transfer without a budget; retries are idempotent',async()=>{
  for(const model of ['fixed_price','cost_plus_percent','cost_plus_fixed_fee','cost_plus_gmp','time_and_materials']){
   await reset();await db.query('update public.estimates set metadata=metadata||$1::jsonb',[JSON.stringify({precon:{purpose:'construction_agreement',billing_model:model,retainage_percent:5,fixed_fee_cents:15000,gmp_cents:200000,payment_terms:'Deposit'},markup_percent:20})])
   const result=await start(),contract=await one('select * from public.contracts')
   assert.equal(contract.total_cents,125000);assert.equal(Number(contract.retainage_percent),5);assert.equal(contract.snapshot.estimate_id,doc)
   assert.equal(contract.contract_type,model==='time_and_materials'?'time_materials':model.startsWith('cost_plus')?'cost_plus':'fixed')
   assert.equal((await one('select billing_model from public.project_financial_settings')).billing_model,model)
   if(model==='cost_plus_fixed_fee')assert.equal(contract.fixed_fee_cents,15000)
   if(model==='cost_plus_gmp')assert.equal(contract.gmp_cents,200000)
   assert.equal((await one('select count(*)::int n from public.budgets')).n,0)
   assert.equal((await one('select status from public.estimates')).status,'executed')
   assert.equal((await start(result.projectId)).alreadyStarted,true)
   assert.equal((await one('select count(*)::int n from public.contracts')).n,1)
   assert.equal((await one('select count(*)::int n from public.events')).n,1)
  }
 })
 await t.test('placeholder billing supersedes safely; configured contract conflicts roll back activation',async()=>{
  for(const placeholder of [true,false]){
   await reset();await db.exec(`insert into public.projects(id,org_id,prospect_id,name,phase,status) values('${job}','${org}','${lead}','Old name','precon','planning');insert into public.contracts(org_id,project_id,status,total_cents,snapshot) values('${org}','${job}','active',${placeholder?0:70000},'{"billing_setup_source":"project_settings"}');`)
   if(placeholder){await start(job);assert.equal((await one("select count(*)::int n from public.contracts where status='superseded'")).n,1);assert.equal((await one('select name from public.projects')).name,'Kitchen')}
   else{await assert.rejects(start(job),/different billing contract/);assert.equal((await one('select phase from public.projects')).phase,'precon');assert.equal((await one('select status from public.prospects')).status,'pricing')}
  }
 })
 await t.test('event failure rolls back billing, project and lead together',async()=>{
  await reset();await db.exec(`create function public.fail_start_event() returns trigger language plpgsql as $$begin raise exception 'injected failure';end$$;create trigger fail_start before insert on public.events for each row execute function public.fail_start_event();`)
  await assert.rejects(start(),/injected failure/);assert.equal((await one('select count(*)::int n from public.contracts')).n,0);assert.equal((await one('select count(*)::int n from public.projects')).n,0)
  await db.exec('drop trigger fail_start on public.events')
 })
 await t.test('copy and resend preserve old capabilities; explicit replacement revokes all and first sharing freezes draft',async()=>{
  await reset('draft');await db.exec("update public.estimates set token_hash='legacy'")
  await issue('one');await issue('two');assert.equal((await one('select count(*)::int n from public.estimate_review_links')).n,2);assert.equal((await one('select token_hash from public.estimates')).token_hash,'legacy');assert.equal((await one('select status from public.estimates')).status,'sent')
  await issue('replacement',true);assert.equal((await one('select count(*)::int n from public.estimate_review_links')).n,1);assert.equal((await one('select token_hash from public.estimates')).token_hash,null)
  await db.exec("update public.estimates set status='client_signed',client_signed_at=now()");await assert.rejects(issue('signed'),/unsigned/)
 })
 await t.test('draft RPC enforces immutable purpose, deal lifecycle, published content and current document family',async()=>{
  const save=async(purpose='construction_agreement')=>{const row=await one('select updated_at::text stamp from public.estimates');return db.query('select public.save_estimate_draft($1,$2,$3,$4,$5)',[org,doc,row.stamp,{metadata:{precon:{purpose}}},[]])}
  await reset('draft');await assert.rejects(save('budget'),/separate document/)
  await db.exec("update public.prospects set status='lost'");await assert.rejects(save(),/Reopen/)
  await reset('draft');await issue('published');await assert.rejects(save(),/unpublished draft/)
  await reset('draft');await db.exec(`insert into public.estimates(id,org_id,prospect_id,status,created_at,metadata) values('${other}','${org}','${lead}','draft',now()+interval '1 day','{"precon":{"purpose":"construction_agreement"}}')`);await assert.rejects(save(),/newer document/)
 })
 await t.test('first publication rechecks the saved brief revision and delivery state under the SQL gate',async()=>{
  await reset('draft');
  await db.exec(`update public.estimates set metadata=jsonb_set(metadata,'{precon,brief_version}','1');insert into public.precon_workspaces(org_id,prospect_id,version,brief) values('${org}','${lead}',3,'{"pricing_revision":2}');`)
  await assert.rejects(issue('stale-brief'),/pricing basis changed/)
  assert.equal((await one('select count(*)::int n from public.estimate_review_links')).n,0)
  await db.exec("update public.estimates set metadata=jsonb_set(metadata,'{precon,brief_version}','2')")
  await issue('current-brief')
  await db.exec(`insert into public.projects(id,org_id,prospect_id,name,phase,status) values('${job}','${org}','${lead}','Kitchen','delivery','active')`)
  await assert.rejects(issue('delivery'),/in delivery/)
 })
 await t.test('public API roles cannot issue capabilities or convert',async()=>{
  await reset();for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(start(),/permission denied/);await assert.rejects(db.query('select public.issue_estimate_review_link($1,$2,$3,$4,$5)',[org,doc,'denied',new Date(),false]),/permission denied/);await db.exec('reset role')}
 })
})
