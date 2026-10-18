require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
const ORG=id(1),ACTOR=id(2),ROLE=id(3),DIV=id(4),COMM=id(5),COMP=id(6),OTHER=id(7)
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table app_users(id uuid primary key);create table permissions(key text primary key);create table roles(id uuid primary key);create table role_permissions(role_id uuid references roles,permission_key text);
 create table memberships(id uuid primary key,org_id uuid,user_id uuid references app_users,role_id uuid references roles,status text,project_scope text default 'all',division_scope text default 'all');
 create table membership_permission_overrides(membership_id uuid references memberships,permission_key text,effect text);create table membership_divisions(membership_id uuid references memberships,division_id uuid);
 create table platform_memberships(user_id uuid references app_users,role_id uuid references roles,status text,expires_at timestamptz);
 create table projects(id uuid primary key,org_id uuid,division_id uuid,phase text default 'closed');create table project_members(org_id uuid,project_id uuid references projects,user_id uuid,role_id uuid references roles,status text);
 create table communities(id uuid primary key,org_id uuid,name text);create table lots(id uuid primary key,org_id uuid,project_id uuid unique references projects,community_id uuid references communities);
 create table warranty_requests(id uuid primary key,org_id uuid,project_id uuid references projects,assigned_company_id uuid);
 create table warranty_service_visits(id uuid primary key,org_id uuid,project_id uuid,request_id uuid,status text,books_cost_approved_at timestamptz,books_approved_cost_cents bigint);
 create table warranty_backcharges(id uuid primary key,org_id uuid,project_id uuid,warranty_request_id uuid,company_id uuid,amount_cents bigint,recovered_cents bigint,status text);
 create table invoices(id uuid primary key,org_id uuid,project_id uuid,total_cents bigint);
 create table closings(id uuid primary key,org_id uuid,project_id uuid,community_id uuid,status text,settlement jsonb,closing_invoice_id uuid);`)
 await db.query('insert into app_users values($1);',[ACTOR]);await db.query('insert into roles values($1),($2)',[ROLE,OTHER]);await db.exec("insert into permissions values('warranty.read');")
 await db.query("insert into role_permissions values($1,'warranty.read'),($1,'project.read')",[ROLE])
 await db.query("insert into memberships(id,org_id,user_id,role_id,status) values($1,$2,$3,$4,'active')",[ACTOR,ORG,ACTOR,ROLE])
 await db.query("insert into communities values($1,$2,'Neighborhood')",[COMM,ORG])
 for(let i=20;i<23;i++){
  const home=id(i),request=id(i+10)
  await db.query('insert into projects(id,org_id,division_id) values($1,$2,$3)',[home,ORG,i===22?OTHER:DIV])
  await db.query('insert into lots values($1,$2,$3,$4)',[id(i+20),ORG,home,COMM])
  await db.query('insert into warranty_requests values($1,$2,$3,$4)',[request,ORG,home,COMP])
  await db.query("insert into warranty_service_visits values($1,$2,$3,$4,'completed',now(),$5)",[id(i+30),ORG,home,request,(i-19)*100])
  await db.query("insert into warranty_backcharges values($1,$2,$3,$4,$5,1000,10,'issued')",[id(i+40),ORG,home,request,COMP])
  await db.query("insert into closings values($1,$2,$3,$4,'closed',$5,null)",[id(i+50),ORG,home,COMM,JSON.stringify({finalPriceCents:(i-19)*10000})])
 }
 await db.exec(`alter table warranty_requests add column category text,add column cost_code_id uuid,add column metadata jsonb default '{}',add column created_at timestamptz default now();
 alter table warranty_backcharges add column created_at timestamptz default now();alter table lots add column house_plan_version_id uuid;
 create table house_plan_versions(id uuid primary key,org_id uuid,house_plan_id uuid,label text,version_number int);create table house_plans(id uuid primary key,org_id uuid,code text,name text);create table companies(id uuid primary key,org_id uuid,name text);create table cost_codes(id uuid primary key,org_id uuid,code text,name text);`)
 await db.exec(fs.readFileSync('supabase/migrations/20261003053000_warranty_actor_analytics.sql','utf8'))
 const summary=async(div=null,comm=null)=>(await db.query('select warranty_cost_summary_for_actor($1,$2,$3,$4) value',[ORG,ACTOR,div,comm])).rows[0].value
 const signal=async()=>(await db.query('select warranty_company_signal_for_actor($1,$2,$3) value',[ORG,ACTOR,COMP])).rows[0].value
 const defects=async(div=null,comm=null)=>(await db.query("select warranty_defect_analysis_for_actor($1,$2,'community',$3,$4) value",[ORG,ACTOR,div,comm])).rows[0].value
 return{db,summary,signal,defects}
}
test('actor aggregates include closed installed-base homes and approved costs without adding claims twice',async t=>{
 const h=await fixture(t),rows=await h.summary();assert.equal(rows.length,1)
 assert.equal(rows[0].warranty_cost_cents,600);assert.equal(rows[0].recovered_cents,30);assert.equal(rows[0].closed_revenue_cents,60000);assert.equal(rows[0].net_cost_cents,570)
 assert.deepEqual(await h.signal(),{request_count:3,backcharge_cents:3000,recovered_cents:30,open_backcharges:3})
 assert.equal((await h.summary(DIV))[0].warranty_cost_cents,300)
 assert.deepEqual(await h.summary(null,OTHER),[])
})
test('assigned homes constrain costs, recovery, revenue and counts before grouping by the same community',async t=>{
 const h=await fixture(t);await h.db.exec("update memberships set project_scope='assigned'")
 assert.deepEqual(await h.summary(),[])
 await h.db.query("insert into project_members values($1,$2,$3,$4,'active')",[ORG,id(20),ACTOR,ROLE])
 const row=(await h.summary())[0];assert.equal(row.warranty_cost_cents,100);assert.equal(row.recovered_cents,10);assert.equal(row.closed_revenue_cents,10000)
 assert.equal((await h.signal()).request_count,1)
 await h.db.exec("update project_members set status='inactive'");assert.deepEqual(await h.summary(),[])
})
test('division restrictions intersect explicit lenses and grant-only admin does not broaden divisions',async t=>{
 const h=await fixture(t);await h.db.exec("update memberships set division_scope='assigned'")
 assert.deepEqual(await h.summary(),[])
 await h.db.query('insert into membership_divisions values($1,$2)',[ACTOR,DIV]);assert.equal((await h.summary())[0].warranty_cost_cents,300)
 assert.deepEqual(await h.summary(OTHER),[])
 await h.db.query("insert into membership_permission_overrides values($1,'org.admin','grant')",[ACTOR]);assert.equal((await h.summary())[0].warranty_cost_cents,300)
 await h.db.query("insert into role_permissions values($1,'org.admin')",[ROLE]);assert.equal((await h.summary())[0].warranty_cost_cents,600)
})
test('explicit deny beats org wildcard while active DB platform access overrides it; expiry is enforced',async t=>{
 const h=await fixture(t);await h.db.query("insert into role_permissions values($1,'*')",[ROLE]);await h.db.query("insert into membership_permission_overrides values($1,'warranty.read','deny')",[ACTOR])
 await assert.rejects(h.summary(),/read permission denied/)
 await h.db.query("insert into role_permissions values($1,'platform.org.access')",[OTHER]);await h.db.query("insert into platform_memberships values($1,$2,'active',now()+interval '1 day')",[ACTOR,OTHER]);assert.equal((await h.summary())[0].warranty_cost_cents,600)
 await h.db.exec("update platform_memberships set expires_at=now()-interval '1 second'");await assert.rejects(h.summary(),/read permission denied/)
})
test('foreign project membership, lot ancestry and request ancestry cannot contribute to aggregates',async t=>{
 const h=await fixture(t);await h.db.exec("update memberships set project_scope='assigned'")
 await h.db.query("insert into project_members values($1,$2,$3,$4,'active')",[OTHER,id(20),ACTOR,ROLE]);assert.deepEqual(await h.summary(),[])
 await h.db.query('update project_members set org_id=$1',[ORG]);await h.db.query('update lots set org_id=$1 where project_id=$2',[OTHER,id(20)]);assert.deepEqual(await h.summary(null,COMM),[])
 await h.db.query('update lots set org_id=$1',[ORG]);await h.db.query('update warranty_service_visits set request_id=$1 where project_id=$2',[id(31),id(20)]);assert.equal((await h.summary())[0].warranty_cost_cents,0)
})
test('analytics RPCs are service-only and internal readable-home policy is private',async t=>{
 const h=await fixture(t)
 const rights=(await h.db.query("select has_function_privilege('authenticated','warranty_cost_summary_for_actor(uuid,uuid,uuid,uuid)','execute') browser,has_function_privilege('service_role','warranty_cost_summary_for_actor(uuid,uuid,uuid,uuid)','execute') service,has_function_privilege('service_role','warranty_readable_homes(uuid,uuid,uuid,uuid)','execute') helper")).rows[0]
 assert.deepEqual(rights,{browser:false,service:true,helper:false})
 await h.db.exec('set role service_role');assert.equal((await h.summary())[0].warranty_cost_cents,600);await h.db.exec('reset role')
})

test('defect denominators and approved costs share actor/division/community scope',async t=>{
 const h=await fixture(t);let row=(await h.defects())[0]
 assert.equal(row.request_count,3);assert.equal(row.closed_home_count,3);assert.equal(row.remediation_cost_cents,600)
 await h.db.exec("update memberships set project_scope='assigned'");await h.db.query("insert into project_members values($1,$2,$3,$4,'active')",[ORG,id(20),ACTOR,ROLE])
 row=(await h.defects())[0];assert.equal(row.request_count,1);assert.equal(row.closed_home_count,1);assert.equal(row.affected_home_count,1);assert.equal(row.remediation_cost_cents,100)
 assert.deepEqual(await h.defects(OTHER),[]);assert.deepEqual(await h.defects(null,OTHER),[])
})

test('analytics includes more than 1000 installed homes without enumerating project IDs',async t=>{
 const h=await fixture(t)
 await h.db.query(`insert into projects(id,org_id,division_id) select md5('home'||n)::uuid,$1,$2 from generate_series(1,1251) n`,[ORG,DIV])
 await h.db.query(`insert into lots(id,org_id,project_id,community_id) select md5('lot'||n)::uuid,$1,md5('home'||n)::uuid,$2 from generate_series(1,1251) n`,[ORG,COMM])
 await h.db.query(`insert into warranty_requests(id,org_id,project_id,assigned_company_id) select md5('request'||n)::uuid,$1,md5('home'||n)::uuid,$2 from generate_series(1,1251) n`,[ORG,COMP])
 await h.db.query(`insert into warranty_service_visits select md5('visit'||n)::uuid,$1,md5('home'||n)::uuid,md5('request'||n)::uuid,'completed',now(),1 from generate_series(1,1251) n`,[ORG])
 assert.equal((await h.summary())[0].warranty_cost_cents,1851)
 assert.equal((await h.defects())[0].request_count,1254)
})
test('approved missing/negative costs and invalid recovery do not silently cancel inside sums',async t=>{
 const h=await fixture(t)
 await h.db.exec('update warranty_service_visits set books_approved_cost_cents=null')
 await assert.rejects(h.summary(),/Invalid scoped warranty monetary evidence/)
 await h.db.exec('update warranty_service_visits set books_approved_cost_cents=100;update warranty_backcharges set recovered_cents=1001')
 await assert.rejects(h.signal(),/Invalid scoped warranty monetary evidence/)
 await assert.rejects(h.defects(),/Invalid scoped warranty monetary evidence/)
})
