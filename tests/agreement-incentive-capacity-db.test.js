const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const org=id(1),other=id(2),incentive=id(3),home=id(4),community=id(5)
const migration=fs.readFileSync('supabase/migrations/20261004011501_agreement_incentive_capacity.sql','utf8')
const sourceDDL=fs.readFileSync('supabase/migrations/20260718220318_lot_reservations_incentives.sql','utf8').match(/create table public\.incentives \([\s\S]*?\n\);/)[0]
const snapshot=ids=>({purchase_agreement:{incentive_ids:ids,pricing:{incentives:ids.map(incentiveId=>({incentiveId}))}}})
async function database(t,{existing=0,limit=1}={}){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);create table communities(id uuid primary key);create table app_users(id uuid primary key);
 create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid);
 create table contracts(id uuid primary key,org_id uuid,project_id uuid,contract_type text,status text,snapshot jsonb);
 create function is_org_member(uuid) returns boolean language sql stable as $$ select $1::text=current_setting('test.org_id',true) $$;`)
 await db.exec(sourceDDL)
 await db.query('insert into orgs values($1),($2)',[org,other]);await db.query('insert into communities values($1)',[community])
 await db.query('insert into lots values($1,$2,$3,$4)',[id(6),org,home,community])
 await db.query("insert into incentives(id,org_id,name,amount_cents,max_uses) values($1,$2,'Limited offer',10000,$3)",[incentive,org,limit])
 const insert=(key,ids=[incentive],status='draft',tenant=org)=>db.query("insert into contracts values($1,$2,$3,'purchase_agreement',$4,$5)",[id(key),tenant,home,status,JSON.stringify(snapshot(ids))])
 for(let n=0;n<existing;n++)await insert(10+n)
 return {db,insert,install:()=>db.exec(migration),count:async()=> (await db.query('select used_count::int n from agreement_incentive_capacity where org_id=$1 and incentive_id=$2',[org,incentive])).rows[0].n}
}
test('drafts reserve the last unit; activation and retry do not consume again; void and deletion release',async t=>{
 const f=await database(t);await f.install();await f.insert(10);assert.equal(await f.count(),1)
 await assert.rejects(f.insert(11),/exhausted/);assert.equal((await f.db.query('select count(*)::int n from contracts')).rows[0].n,1)
 await f.db.query("update contracts set status='active' where id=$1",[id(10)]);assert.equal(await f.count(),1)
 await f.db.query('update contracts set snapshot=snapshot where id=$1',[id(10)]);assert.equal(await f.count(),1)
 await f.db.query("update contracts set status='void' where id=$1",[id(10)]);assert.equal(await f.count(),0)
 await f.insert(11);await f.db.query('delete from contracts where id=$1',[id(11)]);assert.equal(await f.count(),0)
 await f.db.query("update contracts set status='active' where id=$1",[id(10)]);assert.equal(await f.count(),1)
})
test('all writers are guarded; malformed/foreign/ineligible incentive claims roll back',async t=>{
 const f=await database(t);await f.install()
 await assert.rejects(f.insert(10,[incentive,incentive]),/Duplicate/)
 await assert.rejects(f.insert(10,[id(99)]),/unavailable/)
 await assert.rejects(f.insert(10,[incentive],'draft',other),/unavailable/)
 const bad=snapshot([incentive]);bad.purchase_agreement.incentive_ids=[]
 await assert.rejects(f.db.query("insert into contracts values($1,$2,$3,'purchase_agreement','draft',$4)",[id(10),org,home,JSON.stringify(bad)]),/differ/)
 for(const sql of ["status='ended'","effective_start='2099-01-01'","effective_end='2000-01-01'","requires_approval=true","community_id=null,requires_approval=true"]){
  await f.db.exec("update incentives set status='active',effective_start=null,effective_end=null,requires_approval=false")
  await f.db.exec(`update incentives set ${sql}`)
  await assert.rejects(f.insert(10),/unavailable/)
 }
 assert.equal(await f.count(),0)
 await f.db.exec("update incentives set status='active',effective_start=null,effective_end=null,requires_approval=true,metadata='{\"approved_at\":\"2026-10-03\"}'")
 await f.insert(10);assert.equal(await f.count(),1)
})
test('policy writes cannot shrink below reserved count, delete or move a used incentive; rollback restores both',async t=>{
 const f=await database(t,{limit:2});await f.install();await f.insert(10);await f.insert(11)
 await assert.rejects(f.db.exec('update incentives set max_uses=1'),/check constraint/)
 await assert.rejects(f.db.exec('delete from incentives'),/cannot be deleted/)
 await assert.rejects(f.db.query('update incentives set org_id=$1',[other]),/cannot be deleted or moved/)
 await f.db.exec('begin');await f.db.query('delete from contracts where id=$1',[id(10)]);assert.equal(await f.count(),1);await f.db.exec('rollback');assert.equal(await f.count(),2)
 await assert.rejects(f.db.exec('truncate contracts'),/bypasses/)
})
test('existing drafts and active agreements reconcile on install; oversubscribed migration refuses history',async t=>{
 const valid=await database(t,{existing:1});await valid.install();assert.equal(await valid.count(),1);await assert.rejects(valid.insert(20),/exhausted/)
 const invalid=await database(t,{existing:2});await assert.rejects(invalid.install(),/check constraint/)
 await invalid.db.exec('rollback')
 assert.equal((await invalid.db.query("select to_regclass('public.agreement_incentive_capacity') relation")).rows[0].relation,null)
 assert.equal((await invalid.db.query('select count(*)::int n from contracts')).rows[0].n,2)
})
test('capacity counters and privileged helpers cannot be forged by application roles',async t=>{
 const f=await database(t);await f.install()
 await f.db.query("select set_config('test.org_id',$1,false)",[org])
 for(const role of ['authenticated','service_role']){
  await f.db.exec(`set role ${role}`)
  await assert.rejects(f.db.exec('update agreement_incentive_capacity set used_count=0'),/permission denied/)
  await assert.rejects(f.db.query('select lock_agreement_incentive_capacity($1,$2)',[org,JSON.stringify([incentive])]),/permission denied/)
  await f.db.exec('reset role')
 }
 await f.db.exec('grant insert on contracts to service_role;set role service_role')
 await f.insert(10)
 await assert.rejects(f.insert(11),/exhausted/)
 await f.db.exec('reset role');assert.equal(await f.count(),1)
 await f.db.exec('set role authenticated');assert.equal((await f.db.query('select * from agreement_incentive_capacity')).rows.length,1)
 await f.db.exec('reset role');await f.db.query("select set_config('test.org_id',$1,false)",[other]);await f.db.exec('set role authenticated');assert.equal((await f.db.query('select * from agreement_incentive_capacity')).rows.length,0);await f.db.exec('reset role')
})
test('changing multiple claims is atomic and community restrictions remain enforced',async t=>{
 const f=await database(t);await f.install();const second=id(7),anotherCommunity=id(8)
 await f.db.query('insert into communities values($1)',[anotherCommunity])
 await f.db.query("insert into incentives(id,org_id,name,amount_cents,max_uses,community_id) values($1,$2,'Other offer',0,1,$3)",[second,org,anotherCommunity])
 await assert.rejects(f.insert(11,[second]),/another community/)
 await f.db.query('update incentives set community_id=$1 where id=$2',[community,second])
 await f.insert(10);await f.insert(11,[second])
 await assert.rejects(f.db.query('update contracts set snapshot=$1 where id=$2',[JSON.stringify(snapshot([second])),id(10)]),/exhausted/)
 assert.equal(await f.count(),1)
 assert.deepEqual((await f.db.query('select snapshot from contracts where id=$1',[id(10)])).rows[0].snapshot,snapshot([incentive]))
 await f.db.query("update contracts set status='void' where id=$1",[id(11)])
 await f.db.query('update contracts set snapshot=$1 where id=$2',[JSON.stringify(snapshot([second])),id(10)])
 assert.equal(await f.count(),0)
 assert.equal((await f.db.query('select used_count::int n from agreement_incentive_capacity where incentive_id=$1',[second])).rows[0].n,1)
})
