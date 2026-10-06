const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
const ORG='00000000-0000-4000-8000-000000000001',PKG='00000000-0000-4000-8000-000000000002',HOME='00000000-0000-4000-8000-000000000003',LOT='00000000-0000-4000-8000-000000000004',COMM='00000000-0000-4000-8000-000000000005',ACTOR='00000000-0000-4000-8000-000000000006',MEM='00000000-0000-4000-8000-000000000007',ROLE='00000000-0000-4000-8000-000000000008',DIV='00000000-0000-4000-8000-000000000009',OTHER='00000000-0000-4000-8000-000000000010'
async function setup(t,{inspection=true}={}){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);
 create table orgs(id uuid primary key);create table app_users(id uuid primary key,full_name text);
 create table permissions(key text primary key);create table memberships(id uuid primary key,org_id uuid,user_id uuid,role_id uuid,status text,division_scope text,unique(org_id,user_id));
 create table role_permissions(role_id uuid,permission_key text);
 create table membership_permission_overrides(membership_id uuid references memberships(id),permission_key text,effect text);
 create table membership_divisions(membership_id uuid references memberships(id),division_id uuid);
 create table communities(id uuid primary key,org_id uuid,division_id uuid);
 create table lots(id uuid primary key,org_id uuid,community_id uuid,division_id uuid,project_id uuid,status text,house_plan_version_id uuid);
 create table projects(id uuid primary key,org_id uuid,division_id uuid,phase text,superintendent_id uuid);`)
 const packageDDL=fs.readFileSync(require.resolve('../supabase/migrations/20260718210910_start_packages.sql'),'utf8');await db.exec(packageDDL.slice(packageDDL.indexOf('create table'),packageDDL.indexOf('\n);')+4));
 await db.exec('create table start_release_steps(id uuid primary key,org_id uuid,start_package_id uuid,status text);create table start_package_gates(id uuid primary key,org_id uuid,start_package_id uuid,status text)');
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid)`)
 await db.exec('create table budget_lines(id uuid,org_id uuid,budget_id uuid);create table inspection_items(id uuid,org_id uuid,inspection_id uuid);create table schedule_assignments(id uuid,org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid,org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid)')
 await db.exec('alter table schedule_assignments add column company_id uuid;create table companies(id uuid primary key,org_id uuid);create table files(id uuid primary key,org_id uuid,project_id uuid,storage_path text,metadata jsonb);create table drawing_sets(id uuid primary key,org_id uuid,project_id uuid);create table drawing_revisions(id uuid primary key,org_id uuid,project_id uuid,drawing_set_id uuid,source_file_id uuid)');
 await db.exec('alter table outbox add column dedupe_key text;create table notifications(id uuid primary key,org_id uuid,user_id uuid,notification_type text,payload jsonb,created_at timestamptz default now());create table audit_log(id bigint generated always as identity primary key,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,source text);create table events(id uuid primary key default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,channel text)');
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003024000_starts_core_write_fences.sql','20261003025000_starts_generated_artifact_fences.sql','20261003030000_starts_package_lease_rpc.sql','20261003033500_starts_release_lot_plan_scope.sql','20261003037000_starts_worker_outbox_fanout_fences.sql','20261003038000_starts_release_actor_scope.sql','20261003040000_starts_core_actor_scope.sql','20261003041000_starts_claim_actor_transitions.sql','20261003044000_notification_delivery_receipts.sql','20261003045000_starts_confirmation_recovery.sql','20261003046000_starts_notification_delivery_recovery.sql','20261003047000_starts_delivery_inspection.sql','20261003048000_starts_notification_delivery_authorization.sql'].filter(file=>inspection||file!=='20261003047000_starts_delivery_inspection.sql'))await db.exec(fs.readFileSync(require.resolve(`../supabase/migrations/${file}`),'utf8'))
 await db.query('insert into orgs values($1)',[ORG]);await db.query('insert into app_users(id) values($1)',[ACTOR]);
 await db.exec("insert into permissions values('start.release')")
 await db.query("insert into memberships values($1,$2,$3,$4,'active','assigned')",[MEM,ORG,ACTOR,ROLE]);await db.query("insert into role_permissions values($1,'start.release')",[ROLE]);await db.query('insert into membership_divisions values($1,$2)',[MEM,DIV])
 await db.query('insert into communities values($1,$2,$3)',[COMM,ORG,DIV]);await db.query('insert into lots(id,org_id,community_id,division_id,project_id) values($1,$2,$3,$4,$5)',[LOT,ORG,COMM,DIV,HOME]);await db.query('insert into projects(id,org_id,division_id) values($1,$2,$3)',[HOME,ORG,DIV])
 await db.query("insert into start_packages(id,org_id,project_id,community_id,lot_id,status) values($1,$2,$3,$4,$5,'releasing')",[PKG,ORG,HOME,COMM,LOT]);await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG,actor_id:ACTOR}])
 const job=(await db.query('select * from claim_starts_jobs(1)')).rows[0];await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token})])
 const write=()=>db.query('insert into budgets(org_id,project_id) values($1,$2)',[ORG,HOME]);const lease=async action=>(await db.query('select transition_starts_package_lease($1,$2,$3,$4) ok',[ORG,job.job_id,job.claim_token,action])).rows[0].ok;const control=async sql=>{await db.query("select set_config('request.headers','{}',false)");await db.exec(sql);await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token})])};const claimTransition=async action=>(await db.query('select transition_starts_job_lease($1,$2,$3,$4,$5) ok',[ORG,job.job_id,job.claim_token,action,'worker failure'])).rows[0].ok;return {db,write,job,lease,control,claimTransition}
}
test('current release actor with explicit division access can write under service role',async t=>{
 const h=await setup(t);await h.db.exec('grant all on all tables in schema public to service_role;set role service_role');await h.write()
})
test('membership removal and permission revocation fence the next generated write',async t=>{
 const h=await setup(t);await h.write();await h.db.exec("update memberships set status='inactive'");await assert.rejects(h.write(),/active organization member/)
 await h.db.exec("update memberships set status='active';delete from role_permissions");await assert.rejects(h.write(),/release permission/)
})
test('explicit deny wins over a role wildcard and an override grant restores a missing permission',async t=>{
 const h=await setup(t);await h.db.exec("delete from role_permissions");await h.db.query("insert into membership_permission_overrides values($1,'start.release','grant')",[MEM]);await h.write()
 await h.db.query("insert into role_permissions values($1,'*')",[ROLE]);await h.db.exec("update membership_permission_overrides set effect='deny'");await assert.rejects(h.write(),/release permission/)
})
test('community, lot and home division drift or lost assignment fence writes',async t=>{
 const h=await setup(t)
 for(const table of ['communities','lots','projects']){
  await h.control(`update ${table} set division_id='${OTHER}'`);await assert.rejects(h.write(),/outside actor division access/);await h.control(`update ${table} set division_id='${DIV}'`)
 }
 await h.db.exec('delete from membership_divisions');await assert.rejects(h.write(),/division access/)
})
test('all-division and base org-admin policy retain access, but foreign lot ancestry fails',async t=>{
 const h=await setup(t);await h.db.exec("update memberships set division_scope='all';delete from membership_divisions");await h.write()
 await h.db.exec("update memberships set division_scope='assigned'");await h.db.query("insert into role_permissions values($1,'org.admin')",[ROLE]);await h.write()
 await h.control(`update lots set community_id='${OTHER}'`);await assert.rejects(h.write(),/lot ancestry/)
})
test('revocation during a generated transaction rolls back earlier artifacts',async t=>{
 const h=await setup(t);await h.db.exec('begin');await h.write();await h.db.query("insert into membership_permission_overrides values($1,'start.release','deny')",[MEM]);await assert.rejects(h.write(),/release permission/);await h.db.exec('rollback')
 assert.equal((await h.db.query('select count(*)::int n from budgets')).rows[0].n,0)
})
test('missing permission catalog and foreign membership fail closed',async t=>{
 const h=await setup(t);await h.db.exec('delete from permissions');await assert.rejects(h.write(),/not registered/)
 await h.db.exec("insert into permissions values('start.release')");await h.db.query('update memberships set org_id=$1',[OTHER]);await assert.rejects(h.write(),/active organization member/)
})
test('lot reassignment to another home invalidates the locked release scope',async t=>{
 const h=await setup(t);await h.control(`update lots set project_id='${OTHER}'`);await assert.rejects(h.write(),/home ancestry/)
})

test('core home, lot, package, step and gate writes stop after actor revocation',async t=>{
 const h=await setup(t);await h.db.exec('grant all on all tables in schema public to service_role;set role service_role')
 await h.db.exec("update projects set phase='delivery';update lots set status='started'")
 for(const table of ['start_release_steps','start_package_gates'])await h.db.query(`insert into ${table} values(gen_random_uuid(),$1,$2,'pending')`,[ORG,PKG])
 await h.db.exec("update memberships set status='inactive'")
 for(const sql of ["update projects set phase='precon'","update lots set status='assigned'","update start_packages set status='released'","update start_release_steps set status='completed'","update start_package_gates set status='passed'"])await assert.rejects(h.db.exec(sql),/active organization member/)
 assert.equal((await h.db.query('select status from start_packages')).rows[0].status,'releasing')
})
test('acquisition and renewal require current access, while own-lease cleanup survives revocation',async t=>{
 const h=await setup(t);await h.db.exec('grant all on all tables in schema public to service_role;set role service_role')
 await h.control("update start_packages set metadata=jsonb_build_object('preserved','keep')")
 await h.db.exec("update memberships set status='inactive'")
 await assert.rejects(h.lease('acquire'),/active organization member/)
 await h.db.exec("update memberships set status='active'");assert.equal(await h.lease('acquire'),true)
 await h.db.exec('delete from role_permissions')
 await assert.rejects(h.lease('heartbeat'),/release permission/)
 assert.equal(await h.lease('clear'),true)
 const row=(await h.db.query('select metadata,status from start_packages')).rows[0]
 assert.equal(row.status,'releasing');assert.equal(row.metadata.release_lease_token,null);assert.equal(row.metadata.preserved,'keep')
})
test('cleanup after revocation never clears another worker lease or an expired claim',async t=>{
 const h=await setup(t);await h.db.exec("update memberships set status='inactive'")
 await h.control(`update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}')`)
 assert.equal(await h.lease('clear'),false)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,OTHER)
 await h.control(`update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${h.job.claim_token}');update outbox set start_job_lease_expires_at=now()-interval '1 second'`)
 assert.equal(await h.lease('clear'),false)
})
test('workers cannot alter the package, home or lot scope that authorized their writes',async t=>{
 const h=await setup(t)
 for(const sql of [`update start_packages set project_id=null`,`update start_packages set lot_id='${OTHER}'`,`update start_packages set community_id='${OTHER}'`])await assert.rejects(h.db.exec(sql),/package ancestry is immutable/)
 for(const table of ['lots','projects'])await assert.rejects(h.db.exec(`update ${table} set division_id='${OTHER}'`),/division is immutable/)
 for(const sql of [`update lots set project_id=null`,`update lots set community_id='${OTHER}'`,`update lots set house_plan_version_id='${OTHER}'`])await assert.rejects(h.db.exec(sql),/lot ancestry and plan are immutable/)
 await assert.rejects(h.db.query('update projects set id=$1',[OTHER]),/project mismatch/)
})
test('direct metadata lease acquisition cannot bypass a revoked actor',async t=>{
 const h=await setup(t);await h.control("update start_packages set metadata='{}'")
 await h.db.exec('delete from membership_divisions')
 await assert.rejects(h.db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[h.job.claim_token]),/division access/)
 assert.deepEqual((await h.db.query('select metadata from start_packages')).rows[0].metadata,{})
})
test('core revocation during finalization rolls back earlier home writes',async t=>{
 const h=await setup(t);await h.db.exec('begin');await h.db.exec("update projects set phase='delivery';update memberships set status='inactive'")
 await assert.rejects(h.db.exec("update start_packages set status='released'"),/active organization member/);await h.db.exec('rollback')
 assert.equal((await h.db.query('select phase from projects')).rows[0].phase,null)
 assert.equal((await h.db.query('select status from start_packages')).rows[0].status,'releasing')
})
test('ordinary server edits retain their independent authorization path without worker headers',async t=>{
 const h=await setup(t);await h.db.exec("update memberships set status='inactive'")
 await h.control("update projects set phase='delivery';update start_packages set notes='ordinary server action'")
 assert.equal((await h.db.query('select notes from start_packages')).rows[0].notes,'ordinary server action')
})

test('release claim heartbeats stop on membership, permission and division revocation',async t=>{
 const h=await setup(t);await h.db.exec('grant all on all tables in schema public to service_role;set role service_role')
 assert.equal(await h.claimTransition('heartbeat'),true)
 await h.db.exec("update memberships set status='inactive'");await assert.rejects(h.claimTransition('heartbeat'),/active organization member/)
 await h.db.exec("update memberships set status='active';delete from role_permissions");await assert.rejects(h.claimTransition('heartbeat'),/release permission/)
 await h.db.query("insert into role_permissions values($1,'start.release')",[ROLE]);await h.db.exec('delete from membership_divisions');await assert.rejects(h.claimTransition('heartbeat'),/division access/)
})
test('direct claim table updates cannot bypass heartbeat authorization or package cleanup',async t=>{
 const h=await setup(t);await h.db.exec("update memberships set status='inactive'")
 await assert.rejects(h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()+interval '3 minutes'"),/active organization member/)
 await assert.rejects(h.db.exec("update outbox set status='pending',start_claim_token=null,start_job_lease_expires_at=null"),/package lease cleanup first/)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'processing')
})
test('revoked actors can atomically retry and clear their own package without domain changes',async t=>{
 const h=await setup(t);await h.db.exec('grant all on all tables in schema public to service_role;set role service_role')
 await h.db.exec("update memberships set status='inactive'");assert.equal(await h.claimTransition('retry'),true)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0],job=(await h.db.query('select * from outbox')).rows[0]
 assert.equal(pkg.status,'releasing');assert.equal(pkg.metadata.release_lease_token,null)
 assert.equal(job.status,'pending');assert.equal(job.retry_count,1);assert.equal(job.start_claim_token,null);assert.equal(job.last_error,'worker failure')
 assert.equal(await h.claimTransition('retry'),false)
})
test('deferral clears only the owned lease and preserves the retry budget',async t=>{
 const h=await setup(t);assert.equal(await h.claimTransition('defer'),true)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,null)
 const job=(await h.db.query('select *,run_at>now() delayed from outbox')).rows[0]
 assert.equal(job.status,'pending');assert.equal(job.retry_count,0);assert.equal(job.delayed,true)
})
test('completion requires a released package and remains possible after actor revocation',async t=>{
 const h=await setup(t);await assert.rejects(h.claimTransition('complete'),/durably released package/)
 await h.db.exec("update start_packages set status='released';update memberships set status='inactive'")
 await assert.rejects(h.claimTransition('heartbeat'),/no longer releasing/)
 assert.equal(await h.claimTransition('complete'),true)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'completed')
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,null)
})
test('late claim write failure rolls back its preceding package lease cleanup',async t=>{
 const h=await setup(t)
 await h.db.exec(`create function reject_claim_completion() returns trigger language plpgsql as $$ begin if new.status='pending' then raise exception 'injected claim write failure';end if;return new;end $$;create trigger reject_claim_completion before update on outbox for each row execute function reject_claim_completion()`)
 await assert.rejects(h.claimTransition('retry'),/injected claim write failure/)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,h.job.claim_token)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'processing')
})
test('retry leaves a foreign package owner intact',async t=>{
 const h=await setup(t);await h.control(`update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}')`)
 assert.equal(await h.claimTransition('retry'),true)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,OTHER)
})
test('failed package transitions cannot mark a canceled home completed',async t=>{
 const h=await setup(t);await h.control("update start_packages set status='cancelled'")
 await assert.rejects(h.claimTransition('complete'),/durably released package/)
 await assert.rejects(h.claimTransition('heartbeat'),/no longer releasing/)
 assert.equal(await h.claimTransition('retry'),true)
 assert.equal((await h.db.query('select status from start_packages')).rows[0].status,'cancelled')
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,null)
})

test('expired claim recovery clears the matching package token without actor permission',async t=>{
 const h=await setup(t);await h.control("update outbox set start_job_lease_expires_at=now()-interval '1 second';update memberships set status='inactive'")
 for(const action of ['heartbeat','defer','retry','complete'])assert.equal(await h.claimTransition(action),false)
 await assert.rejects(h.db.query('select recover_starts_job_leases()'),/unscoped service client/)
 await h.db.query("select set_config('request.headers','{}',false)")
 await h.db.exec('grant all on all tables in schema public to service_role;set role service_role')
 assert.equal((await h.db.query('select recover_starts_job_leases() n')).rows[0].n,1)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,null)
 const job=(await h.db.query('select * from outbox')).rows[0]
 assert.equal(job.status,'pending');assert.equal(job.retry_count,1);assert.equal(job.start_claim_token,null)
})
test('expired recovery cannot erase a newer package owner',async t=>{
 const h=await setup(t);await h.control(`update outbox set start_job_lease_expires_at=now()-interval '1 second';update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}')`)
 await h.db.query("select set_config('request.headers','{}',false)")
 assert.equal((await h.db.query('select recover_starts_job_leases() n')).rows[0].n,1)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,OTHER)
})
test('recovery cleanup and requeue form one rollback boundary',async t=>{
 const h=await setup(t);await h.control("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await h.db.query("select set_config('request.headers','{}',false)")
 await h.db.exec(`create function reject_recovery() returns trigger language plpgsql as $$ begin if new.status='pending' then raise exception 'injected recovery failure';end if;return new;end $$;create trigger reject_recovery before update on outbox for each row execute function reject_recovery()`)
 await assert.rejects(h.db.query('select recover_starts_job_leases()'),/injected recovery failure/)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,h.job.claim_token)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'processing')
})

test('claim heartbeats cannot create an unbounded worker lease',async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()+interval '1 year'"),/Invalid starts claim transition/)
})
test('malformed package jobs can fail safely and cannot wedge recovery',async t=>{
 const h=await setup(t);await h.control("update outbox set payload=jsonb_build_object('start_package_id','invalid')")
 await assert.rejects(h.claimTransition('heartbeat'),/Invalid starts package identity/)
 await assert.rejects(h.claimTransition('complete'),/Invalid starts package identity/)
 assert.equal(await h.claimTransition('retry'),true)
 // No reliable package identity exists, so no package lease may be erased.
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,h.job.claim_token)
 await h.db.query("select set_config('request.headers','{}',false)")
 await h.db.exec("update outbox set run_at=now();select * from claim_starts_jobs(1);update outbox set start_job_lease_expires_at=now()-interval '1 second',retry_count=2")
 assert.equal((await h.db.query('select recover_starts_job_leases() n')).rows[0].n,1)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
})
test('notice claim bookkeeping retains its independent permission path',async t=>{
 const h=await setup(t);await h.db.query("select set_config('request.headers','{}',false)")
 await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'trade_schedule_change_notice','{}')",[ORG])
 const notice=(await h.db.query('select * from claim_starts_jobs(1)')).rows[0]
 await h.db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-starts-job-id':String(notice.job_id),'x-starts-claim-token':notice.claim_token})])
 await h.db.exec("update memberships set status='inactive'")
 for(const action of ['heartbeat','complete'])assert.equal((await h.db.query('select transition_starts_job_lease($1,$2,$3,$4) ok',[ORG,notice.job_id,notice.claim_token,action])).rows[0].ok,true)
 assert.equal((await h.db.query('select metadata from start_packages')).rows[0].metadata.release_lease_token,h.job.claim_token)
})

test('terminal retry parks only the still-owned releasing package after actor revocation',async t=>{
 const h=await setup(t);await h.control("update outbox set retry_count=2;update memberships set status='inactive'")
 assert.equal(await h.claimTransition('retry'),true)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0],job=(await h.db.query('select status,retry_count from outbox')).rows[0]
 assert.equal(pkg.status,'attention');assert.equal(pkg.metadata.release_lease_token,null)
 assert.equal(job.status,'failed');assert.equal(job.retry_count,3)
})
test('terminal recovery parks its own releasing home',async t=>{
 const h=await setup(t);await h.control("update outbox set retry_count=2,start_job_lease_expires_at=now()-interval '1 second'")
 await h.db.query("select set_config('request.headers','{}',false)")
 assert.equal((await h.db.query('select recover_starts_job_leases() n')).rows[0].n,1)
 assert.equal((await h.db.query('select status from start_packages')).rows[0].status,'attention')
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
})
test('terminal retry never parks another package owner',async t=>{
 const h=await setup(t);await h.control(`update outbox set retry_count=2;update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}')`)
 assert.equal(await h.claimTransition('retry'),true)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0]
 assert.equal(pkg.status,'releasing');assert.equal(pkg.metadata.release_lease_token,OTHER)
})
test('terminal parking rolls back with a rejected claim failure write',async t=>{
 const h=await setup(t);await h.control('update outbox set retry_count=2')
 await h.db.exec(`create function reject_terminal_failure() returns trigger language plpgsql as $$ begin if new.status='failed' then raise exception 'injected terminal failure';end if;return new;end $$;create trigger reject_terminal_failure before update on outbox for each row execute function reject_terminal_failure()`)
 await assert.rejects(h.claimTransition('retry'),/injected terminal failure/)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0]
 assert.equal(pkg.status,'releasing');assert.equal(pkg.metadata.release_lease_token,h.job.claim_token)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'processing')
})

test('terminal retry preserves a released home while clearing its own lease',async t=>{
 const h=await setup(t);await h.control("update outbox set retry_count=2;update start_packages set status='released'")
 assert.equal(await h.claimTransition('retry'),true)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0]
 assert.equal(pkg.status,'released');assert.equal(pkg.metadata.release_lease_token,null)
})
test('terminal recovery leaves a newer package owner and home status intact',async t=>{
 const h=await setup(t);await h.control(`update outbox set retry_count=2,start_job_lease_expires_at=now()-interval '1 second';update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}')`)
 await h.db.query("select set_config('request.headers','{}',false)")
 assert.equal((await h.db.query('select recover_starts_job_leases() n')).rows[0].n,1)
 const pkg=(await h.db.query('select status,metadata from start_packages')).rows[0]
 assert.equal(pkg.status,'releasing');assert.equal(pkg.metadata.release_lease_token,OTHER)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
})

test('scoped post-publication delivery reservations recheck real release actor and preserve headers',async t=>{
 const h=await setup(t),note='00000000-0000-4000-8000-000000000011'
 await h.db.exec("update start_packages set status='released'")
 await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) values($1,$2,$3,'start_released',$4)",[note,ORG,ACTOR,{entity_type:'start_package',entity_id:PKG,project_id:HOME}])
 const headers=(await h.db.query("select current_setting('request.headers') h")).rows[0].h
 await h.db.exec('grant all on all tables in schema public to service_role;grant usage on all sequences in schema public to service_role;set role service_role')
 const reserved=(await h.db.query("select reserve_notification_delivery($1,$2,'deliver_push') receipt",[ORG,note])).rows[0].receipt
 assert.equal(reserved.status,'pending')
 assert.equal((await h.db.query("select current_setting('request.headers') h")).rows[0].h,headers)
 await h.db.exec("update memberships set status='inactive'")
 await assert.rejects(h.db.query("select reserve_notification_delivery($1,$2,'deliver_push')",[ORG,note]),/active organization member/)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='deliver_push'")).rows[0].n,1)
})
test('scoped delivery reservations refuse another home and an expired claim',async t=>{
 const h=await setup(t),note='00000000-0000-4000-8000-000000000011'
 await h.db.exec("update start_packages set status='released'")
 await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) values($1,$2,$3,'start_released',$4)",[note,ORG,ACTOR,{entity_type:'start_package',entity_id:PKG,project_id:OTHER}])
 await assert.rejects(h.db.query("select reserve_notification_delivery($1,$2,'deliver_push')",[ORG,note]),/notification scope mismatch/)
 await h.control("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await assert.rejects(h.db.query("select reserve_notification_delivery($1,$2,'deliver_push')",[ORG,note]),/confirmation claim lost/)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,0)
})

test('late actor revocation or claim loss rolls back confirmation intent and its source mutation',async t=>{
 for(const loss of ['actor','claim']){
  const h=await setup(t),note='00000000-0000-4000-8000-000000000011'
  await h.db.exec("update start_packages set status='released'")
  await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) values($1,$2,$3,'start_released',$4)",[note,ORG,ACTOR,{entity_type:'start_package',entity_id:PKG,project_id:HOME}])
  const mutation=loss==='actor'?"update memberships set status='inactive'":"update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second' where job_type='start_release'"
  await h.db.exec(`create function revoke_during_reservation() returns trigger language plpgsql as $$ begin ${mutation};return new;end $$;create trigger revoke_during_reservation after insert on notification_delivery_receipts for each row execute function revoke_during_reservation()`)
  await assert.rejects(h.db.query("select reserve_notification_delivery($1,$2,'deliver_push')",[ORG,note]),loss==='actor'?/active organization member/:/claim lost during reservation/)
  assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,0)
  assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='deliver_push'")).rows[0].n,0)
  assert.equal((await h.db.query('select status from memberships')).rows[0].status,'active')
 }
})

async function failedConfirmation(t){
 const h=await setup(t)
 await h.control("update start_packages set status='released',released_at=clock_timestamp(),released_by='"+ACTOR+"',actual_start_date='2026-09-07';update outbox set retry_count=2")
 await h.claimTransition('retry')
 await h.db.query("select set_config('request.headers','{}',false)")
 h.recover=(actor=ACTOR,reason='Provider outage resolved',org=ORG,pkg=PKG)=>h.db.query('select retry_start_confirmation($1,$2,$3,$4,$5) receipt',[org,pkg,h.job.job_id,actor,reason])
 return h
}
test('failed released-home confirmation recovery preserves source evidence and commits audit with the same job',async t=>{
 const h=await failedConfirmation(t),before=(await h.db.query('select * from start_packages')).rows[0]
 await h.db.exec('grant all on all tables in schema public to service_role;grant usage on all sequences in schema public to service_role;set role service_role')
 const receipt=(await h.recover()).rows[0].receipt
 assert.equal(receipt.job_id,String(h.job.job_id));assert.equal(receipt.status,'pending')
 assert.deepEqual((await h.db.query('select * from start_packages')).rows[0],before)
 const job=(await h.db.query('select * from outbox')).rows[0]
 assert.equal(job.status,'pending');assert.equal(job.retry_count,0);assert.equal(job.last_error,null);assert.equal(job.start_claim_token,null)
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,1)
 const audit=(await h.db.query('select * from audit_log')).rows[0]
 assert.equal(audit.actor_user_id,ACTOR);assert.equal(audit.source,'starts.confirmation_recovery');assert.equal(audit.after_data.reason,'Provider outage resolved')
 assert.equal((await h.db.query('select event_type from events')).rows[0].event_type,'start.confirmation_retried')
 await assert.rejects(h.recover(),/Only unclaimed failed/)
})
test('confirmation recovery rejects browser calls, foreign scope, missing original actor and invalid reasons',async t=>{
 const h=await failedConfirmation(t)
 await h.db.exec('set role authenticated');await assert.rejects(h.recover(),/permission denied/);await h.db.exec('reset role')
 await assert.rejects(h.recover(ACTOR,'Short'),/Invalid confirmation recovery/)
 await assert.rejects(h.recover(ACTOR,'Provider outage resolved',OTHER),/unavailable in package/)
 await assert.rejects(h.recover(ACTOR,'Provider outage resolved',ORG,OTHER),/unavailable in package/)
 await h.db.exec('update start_packages set released_by=null')
 await assert.rejects(h.recover(),/original release evidence/)
 assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
})
test('recovery coordinator must have current release permission and all home ancestry access',async t=>{
 const h=await failedConfirmation(t)
 await h.db.exec("update memberships set status='inactive'");await assert.rejects(h.recover(),/active organization member/)
 await h.db.exec("update memberships set status='active';delete from role_permissions");await assert.rejects(h.recover(),/release permission/)
 await h.db.query("insert into role_permissions values($1,'start.release')",[ROLE]);await h.db.exec('delete from membership_divisions')
 await assert.rejects(h.recover(),/division access/)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
})
test('audit and event persistence failures roll back the confirmation requeue',async t=>{
 const h=await failedConfirmation(t)
 for(const table of ['audit_log','events']){
  await h.db.exec("create function reject_recovery_evidence() returns trigger language plpgsql as $$ begin raise exception 'Evidence persistence unavailable';end $$;create trigger reject_recovery_evidence before insert on "+table+" for each row execute function reject_recovery_evidence()")
  await assert.rejects(h.recover(),/Evidence persistence unavailable/)
  assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
  assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
  assert.equal((await h.db.query('select count(*)::int n from events')).rows[0].n,0)
  await h.db.exec('drop trigger reject_recovery_evidence on '+table+';drop function reject_recovery_evidence()')
 }
})
test('late actor revocation during recovery evidence insertion rolls back the job and evidence',async t=>{
 const h=await failedConfirmation(t)
 await h.db.exec("create function revoke_recovery_actor() returns trigger language plpgsql as $$ begin update memberships set status='inactive';return new;end $$;create trigger revoke_recovery_actor after insert on events for each row execute function revoke_recovery_actor()")
 await assert.rejects(h.recover(),/active organization member/)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
 assert.equal((await h.db.query('select status from memberships')).rows[0].status,'active')
 assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
})

test('a replacement coordinator authorizes recovery while the original release actor remains unchanged',async t=>{
 const h=await failedConfirmation(t)
 await h.db.query('insert into app_users(id) values($1)',[OTHER])
 await h.db.query('update start_packages set released_by=$1',[OTHER])
 await h.db.query("update outbox set payload=payload||jsonb_build_object('actor_id',$1::text)",[OTHER])
 await h.recover()
 assert.equal((await h.db.query('select released_by from start_packages')).rows[0].released_by,OTHER)
 assert.equal((await h.db.query('select payload from outbox')).rows[0].payload.actor_id,ACTOR)
 assert.equal((await h.db.query('select after_data from audit_log')).rows[0].after_data.released_by,OTHER)
})
test('active claims and worker-scoped requests cannot use operator confirmation recovery',async t=>{
 const h=await failedConfirmation(t)
 await h.db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-starts-job-id':String(h.job.job_id)})])
 await assert.rejects(h.recover(),/inside a worker claim/)
 await h.db.query("select set_config('request.headers','{}',false)")
 await h.db.exec('update outbox set start_claim_token=gen_random_uuid()')
 await assert.rejects(h.recover(),/Only unclaimed failed/)
})
test('another active confirmation job prevents failed-job recovery',async t=>{
 const h=await failedConfirmation(t)
 await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG,actor_id:ACTOR}])
 await assert.rejects(h.recover(),/Another confirmation attempt is active/)
 assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
})
test('late release-evidence changes roll back job recovery and the trigger mutation',async t=>{
 const h=await failedConfirmation(t)
 await h.db.exec("create function change_recovery_source() returns trigger language plpgsql as $$ begin update start_packages set actual_start_date='2026-09-08';return new;end $$;create trigger change_recovery_source after insert on events for each row execute function change_recovery_source()")
 await assert.rejects(h.recover(),/Release evidence changed/)
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'failed')
 assert.equal((await h.db.query("select actual_start_date::text d from start_packages")).rows[0].d,'2026-09-07')
})

async function failedStartDelivery(t,{prune=false,recipient=ACTOR}={}){
 const h=await failedConfirmation(t),note=OTHER,request='00000000-0000-4000-8000-000000000011'
 await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) values($1,$2,$3,'start_released',$4)",[note,ORG,recipient,{entity_type:'start_package',entity_id:PKG,project_id:HOME,title:'House released'}])
 const delivery=(await h.db.query("select reserve_notification_delivery($1,$2,'deliver_push') receipt",[ORG,note])).rows[0].receipt
 await h.db.query("update outbox set status='failed' where id=$1",[delivery.job_id])
 if(prune)await h.db.query('delete from outbox where id=$1',[delivery.job_id])
 h.delivery=delivery;h.request=request;h.note=note
 h.recoverDelivery=(id=request,reason='Provider credentials restored',org=ORG,pkg=PKG)=>h.db.query('select retry_start_notification_delivery($1,$2,$3,$4,$5,$6) receipt',[org,pkg,delivery.receipt_id,ACTOR,id,reason])
 return h
}
test('failed notification recovery keeps its original job and consumes one audited request proof',async t=>{
 const h=await failedStartDelivery(t)
 await h.db.exec('grant all on notifications,outbox,start_packages,audit_log,events to service_role;grant usage on all sequences in schema public to service_role;set role service_role')
 const recovered=(await h.recoverDelivery()).rows[0].receipt
 assert.equal(recovered.job_id,h.delivery.job_id);assert.equal(recovered.status,'pending');assert.equal(recovered.replayed,false)
 const replay=(await h.recoverDelivery()).rows[0].receipt;assert.equal(replay.replayed,true);assert.equal(replay.job_id,recovered.job_id)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_recoveries')).rows[0].n,1)
 assert.ok((await h.db.query('select consumed_at from notification_delivery_recoveries')).rows[0].consumed_at)
 assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,1)
 await h.db.query("update outbox set status='failed' where id=$1",[recovered.job_id])
 await assert.rejects(h.db.query("update outbox set status='pending' where id=$1",[recovered.job_id]),/audited recovery/)
 await h.db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-notification-recovery-id':h.request})])
 await assert.rejects(h.db.query("update outbox set status='pending' where id=$1",[recovered.job_id]),/proof does not match/)
})
test('pruned failed notification jobs recover under the same delivery identity and request replay survives completion pruning',async t=>{
 const h=await failedStartDelivery(t,{prune:true}),before=(await h.db.query('select * from start_packages')).rows[0]
 const recovered=(await h.recoverDelivery()).rows[0].receipt
 assert.notEqual(recovered.job_id,h.delivery.job_id);assert.equal(recovered.receipt_id,h.delivery.receipt_id)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,1)
 assert.deepEqual((await h.db.query('select * from start_packages')).rows[0],before)
 await h.db.query("update outbox set status='completed' where id=$1",[recovered.job_id]);await h.db.query('delete from outbox where id=$1',[recovered.job_id])
 const replay=(await h.recoverDelivery()).rows[0].receipt
 assert.equal(replay.job_id,recovered.job_id);assert.equal(replay.status,'completed');assert.equal(replay.replayed,true)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='deliver_push'")).rows[0].n,0)
 await assert.rejects(h.recoverDelivery('00000000-0000-4000-8000-000000000012'),/Only failed deliveries/)
})
test('notification recovery refuses foreign scope, changed request evidence and revoked coordinator access',async t=>{
 const h=await failedStartDelivery(t)
 await assert.rejects(h.recoverDelivery(h.request,'Provider credentials restored',OTHER),/original released-home evidence/)
 await assert.rejects(h.recoverDelivery(h.request,'Provider credentials restored',ORG,OTHER),/original released-home evidence/)
 await h.recoverDelivery()
 await assert.rejects(h.recoverDelivery(h.request,'Different repaired condition'),/different evidence/)
 await h.db.exec("update memberships set status='inactive'")
 await assert.rejects(h.recoverDelivery(),/active organization member/)
})
test('missing or changed notification sources cannot be reconstructed from a receipt',async t=>{
 const h=await failedStartDelivery(t,{prune:true})
 await h.db.query('update notifications set payload=payload||$1::jsonb',[{title:'Different content'}])
 await assert.rejects(h.recoverDelivery(),/differs from its delivery receipt/)
 await h.db.exec('delete from notifications')
 await assert.rejects(h.recoverDelivery(),/Original package notification is unavailable/)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_recoveries')).rows[0].n,0)
})
test('evidence-write failure rolls back a replacement job and preserves the pruned failed receipt',async t=>{
 const h=await failedStartDelivery(t,{prune:true})
 await h.db.exec("create function fail_delivery_evidence() returns trigger language plpgsql as $$ begin raise exception 'Evidence unavailable';end $$;create trigger fail_delivery_evidence before insert on audit_log for each row execute function fail_delivery_evidence()")
 await assert.rejects(h.recoverDelivery(),/Evidence unavailable/)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='deliver_push'")).rows[0].n,0)
 const receipt=(await h.db.query('select * from notification_delivery_receipts')).rows[0]
 assert.equal(receipt.status,'failed');assert.equal(receipt.outbox_job_id,null)
})

test('assigned superintendent recovery requires current read permission and recipient membership',async t=>{
 const h=await failedStartDelivery(t,{recipient:OTHER})
 const member='00000000-0000-4000-8000-000000000012',role='00000000-0000-4000-8000-000000000013'
 await h.db.query('insert into app_users(id) values($1)',[OTHER]);await h.db.exec("insert into permissions values('start.read')")
 await h.db.query("insert into memberships values($1,$2,$3,$4,'active','all')",[member,ORG,OTHER,role]);await h.db.query("insert into role_permissions values($1,'start.read')",[role])
 await h.db.query('update projects set superintendent_id=$1',[OTHER])
 await h.recoverDelivery()
 await h.db.query("update memberships set status='inactive' where user_id=$1",[OTHER])
 await assert.rejects(h.recoverDelivery(),/active organization member/)
 await h.db.query("update memberships set status='active' where user_id=$1",[OTHER]);await h.db.query("insert into membership_permission_overrides values($1,'start.read','deny')",[member])
 await assert.rejects(h.recoverDelivery(),/release permission/)
})
test('late recipient revocation rolls back all delivery recovery evidence and intent',async t=>{
 const h=await failedStartDelivery(t,{prune:true})
 await h.db.exec("create function revoke_delivery_actor() returns trigger language plpgsql as $$ begin update memberships set status='inactive';return new;end $$;create trigger revoke_delivery_actor after insert on events for each row execute function revoke_delivery_actor()")
 await assert.rejects(h.recoverDelivery(),/active organization member/)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_recoveries')).rows[0].n,0)
 assert.equal((await h.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='deliver_push'")).rows[0].n,0)
 assert.equal((await h.db.query('select status from notification_delivery_receipts')).rows[0].status,'failed')
})
test('browser recovery and mutation of durable request evidence are forbidden',async t=>{
 const h=await failedStartDelivery(t);await h.recoverDelivery()
 await assert.rejects(h.db.exec("update notification_delivery_recoveries set reason='Different repaired condition'"),/immutable/)
 await assert.rejects(h.db.exec('delete from notification_delivery_recoveries'),/immutable/)
 await h.db.exec('set role authenticated');await assert.rejects(h.recoverDelivery(),/permission denied/)
 await assert.rejects(h.db.exec('select * from notification_delivery_recoveries'),/permission denied/)
})

test('delivery inspection paginates every scoped receipt and retains scope after source pruning',async t=>{
 const h=await failedStartDelivery(t,{prune:true})
 await h.db.query("update app_users set full_name='Site superintendent' where id=$1",[ACTOR])
 const notes=(await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) select gen_random_uuid(),$1,$2,'start_released',$3 from generate_series(1,42) returning id",[ORG,ACTOR,{entity_type:'start_package',entity_id:PKG,project_id:HOME}])).rows
 for(const note of notes)await h.db.query("select reserve_notification_delivery($1,$2,'deliver_notification')",[ORG,note.id])
 const read=async(after=null,failed=false)=>(await h.db.query('select list_start_notification_deliveries($1,$2,$3,$4,$5,20) page',[ORG,PKG,ACTOR,after,failed])).rows[0].page
 const ids=[];let cursor=null
 do{const page=await read(cursor);assert.ok(page.items.length<=20);ids.push(...page.items.map(row=>row.receipt_id));cursor=page.next_cursor;assert.equal(page.has_more,cursor!==null)}while(cursor)
 assert.equal(ids.length,43);assert.equal(new Set(ids).size,43)
 const failed=await read(null,true);assert.equal(failed.items.length,1);assert.equal(failed.items[0].recipient_name,'Site superintendent');assert.equal(failed.items[0].job_id,null)
 await h.db.exec('delete from notifications')
 const retained=await read(null,true);assert.equal(retained.items.length,1);assert.equal(retained.items[0].source_available,false)
 await assert.rejects(h.db.query('select list_start_notification_deliveries($1,$2,$3,$4,false,20)',[ORG,PKG,ACTOR,ACTOR]),/different package/)
 await h.db.exec("update memberships set status='inactive'");await assert.rejects(read(),/active organization member/)
})
test('inspection source scope is immutable and browser inspection is denied',async t=>{
 const h=await failedStartDelivery(t)
 await assert.rejects(h.db.query('update notification_delivery_receipts set source_entity_id=$1',[OTHER]),/identity is immutable/)
 await h.db.exec('set role authenticated')
 await assert.rejects(h.db.query('select list_start_notification_deliveries($1,$2,$3)',[ORG,PKG,ACTOR]),/permission denied/)
})
test('historical scope enrichment requires unchanged notification identity and hash',async t=>{
 const h=await setup(t,{inspection:false})
 await h.db.query("select set_config('request.headers','{}',false)")
 const notes=(await h.db.query("insert into notifications(id,org_id,user_id,notification_type,payload) select gen_random_uuid(),$1,$2,'start_released',$3 from generate_series(1,2) returning id",[ORG,ACTOR,{entity_type:'start_package',entity_id:PKG,project_id:HOME}])).rows
 for(const note of notes)await h.db.query("select reserve_notification_delivery($1,$2,'deliver_push')",[ORG,note.id])
 await h.db.query("update notifications set payload=payload||jsonb_build_object('title','Changed source') where id=$1",[notes[1].id])
 await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003047000_starts_delivery_inspection.sql'),'utf8'))
 const receipts=(await h.db.query('select notification_id,source_entity_id from notification_delivery_receipts')).rows
 assert.equal(receipts.find(row=>row.notification_id===notes[0].id).source_entity_id,PKG)
 assert.equal(receipts.find(row=>row.notification_id===notes[1].id).source_entity_id,null)
})

test('delivery authorization returns verified source only for a processing owned receipt and current recipient',async t=>{
 const h=await failedStartDelivery(t);await h.recoverDelivery();await h.db.query("update outbox set status='processing' where id=$1",[h.delivery.job_id])
 const authorize=()=>h.db.query('select authorize_start_notification_delivery($1,$2,$3) source',[ORG,h.delivery.job_id,h.delivery.receipt_id])
 assert.equal((await authorize()).rows[0].source.user_id,ACTOR)
 await h.db.exec("update memberships set status='inactive'");await assert.rejects(authorize(),/active organization member/)
 await h.db.exec("update memberships set status='active'");await h.db.query("update outbox set status='completed' where id=$1",[h.delivery.job_id])
 await assert.rejects(authorize(),/no longer owned/)
})
test('delivery authorization rejects changed payload, wrong job and browser use',async t=>{
 const h=await failedStartDelivery(t);await h.recoverDelivery();await h.db.query("update outbox set status='processing' where id=$1",[h.delivery.job_id])
 await assert.rejects(h.db.query('select authorize_start_notification_delivery($1,$2,$3)',[ORG,h.job.job_id,h.delivery.receipt_id]),/no longer owned/)
 await h.db.query("update notifications set payload=payload||jsonb_build_object('message','Changed source')")
 await assert.rejects(h.db.query('select authorize_start_notification_delivery($1,$2,$3)',[ORG,h.delivery.job_id,h.delivery.receipt_id]),/differs from authorized/)
 await h.db.exec('set role authenticated')
 await assert.rejects(h.db.query('select authorize_start_notification_delivery($1,$2,$3)',[ORG,h.delivery.job_id,h.delivery.receipt_id]),/permission denied/)
})
