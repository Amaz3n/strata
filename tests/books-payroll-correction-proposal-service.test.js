const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {lineageFixture,nextSource}=require('./helpers/books-payroll-correction-lineage-fixture')
const {correctionPostingFixture}=require('./helpers/books-payroll-correction-posting-fixture')
const {proposalFixture}=require('./helpers/books-payroll-correction-proposal-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
let f,actor=id(2),denied=false,offline=false,lost=null,calls=[]
const service={async rpc(name,args){calls.push(['rpc',name]);try{
 if(name==='capture_books_export_snapshot')return {data:await capture(f.db),error:null}
 if(name==='capture_books_payroll_workspace_snapshot')return {data:(await f.db.query('select capture_books_payroll_workspace_snapshot($1,$2,$3,$4,$5,$6) result',[args.p_org_id,args.p_project_id,args.p_source_id,args.p_before_time,args.p_before_id,args.p_limit])).rows[0].result,error:null}
 const values=name==='post_books_payroll_correction_proposal'?[args.p_org_id,args.p_id,args.p_proposal_id,args.p_actor_id,args.p_digest,args.p_notes,args.p_key]:name==='lock_books_payroll_correction_decisions'?[args.p_org_id,args.p_source_id,JSON.stringify(args.p_decisions)]:name==='lock_books_payroll_correction_context'?[args.p_org_id,args.p_source_id]:name==='prepare_books_payroll_correction_proposal'?[args.p_org_id,args.p_id,args.p_source_id,args.p_actor_id,JSON.stringify(args.p_plan),args.p_notes,args.p_key]:name==='review_books_payroll_correction_proposal'?[args.p_org_id,args.p_id,args.p_actor_id,args.p_digest,args.p_notes]:[args.p_org_id,args.p_id,args.p_actor_id,args.p_reason]
 const result=await f.db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)
 if(lost===name){lost=null;return {data:null,error:{message:'Response lost after commit'}}}return {data:result.rows[0].result,error:null}
 }catch(error){return {data:null,error:{message:error.message}}}},from(table){calls.push(['read',table]);let conditions=[],ids
 const query={select(){return query},eq(key,value){conditions.push([key,value]);return query},in(key,value){ids=[key,value];return query},async read(){const values=conditions.map(([,value])=>value),where=conditions.map(([key],i)=>`${key}=$${i+1}`);if(ids){values.push(ids[1]);where.push(`${ids[0]}=any($${values.length}::uuid[])`)}return {data:(await f.db.query(`select to_jsonb(source) row from ${table} source${where.length?' where '+where.join(' and '):''}`,values)).rows.map(row=>row.row),error:null}},async maybeSingle(){const r=await query.read();return {...r,data:r.data[0]??null}},async single(){return query.maybeSingle()},async limit(){return query.read()}}
 return query}}
const original=Module._load;let prepare,review,withdraw,post,workspace,detail,projectSource,projectProposal
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:actor,supabase:{}})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
 if(name==='./module')return {requireBooksWorkspaceEnabled:async()=>{calls.push(['module']);if(f.disabled)throw new Error('Books is disabled')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async input=>{calls.push(['object']);if(offline)throw new Error('Storage unavailable');const bytes=f.registers?f.registers.get((await f.db.query('select file_id from doc_versions where storage_path=$1',[input.path])).rows[0]?.file_id):f.bytes;if(!bytes)throw new Error('Retained source missing');return {body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})}}}
 return original.call(this,name,...args)
};const loaded=require('../lib/services/books/payroll-correction-proposals');prepare=loaded.preparePayrollCorrectionProposal;review=loaded.reviewPayrollCorrectionProposal;withdraw=loaded.withdrawPayrollCorrectionProposal;post=loaded.postPayrollCorrectionProposal;const w=require('../lib/services/books/payroll-correction-workspace');workspace=w.getProjectPayrollCorrectionWorkspace;detail=w.getProjectPayrollCorrectionDetail;projectSource=w.requireProjectPayrollCorrectionSource;projectProposal=w.requireProjectPayrollCorrectionProposal}finally{Module._load=original}
const input=()=>({id:id(750),sourceId:id(700),notes:'Prepare exact corrected journal and construction proposal',idempotencyKey:'service-correction-proposal-prepare-key'})
test('actual service verifies provider bytes, recovers lost preparation/review and preserves exact historical retries',async t=>{
 f=await proposalFixture(t);actor=id(2);denied=false;offline=false;calls=[];lost='prepare_books_payroll_correction_proposal'
 const before=(await capture(f.db)).tables;assert.equal(await prepare(input()),id(750));assert.deepEqual(calls[0],['authorize','books.adjust']);assert.ok(calls.some(row=>row[0]==='object'))
 offline=true;calls=[];assert.equal(await prepare(input()),id(750));assert.ok(!calls.some(row=>row[0]==='object'))
 await assert.rejects(prepare({...input(),notes:'Different prior preparation explanation'}),/different intent/)
 await assert.rejects(review({id:id(750),notes:'Independent full monetary correction review'}),/separate reviewer/)
 actor=id(51);await assert.rejects(review({id:id(750),notes:'Independent full monetary correction review'}),/Storage unavailable/)
 offline=false;actor=id(50);await assert.rejects(review({id:id(750),notes:'Independent full monetary correction review'}),/separate from all preparers/)
 actor=id(51);lost='review_books_payroll_correction_proposal';assert.equal(await review({id:id(750),notes:'Independent full monetary correction review'}),id(750))
 offline=true;calls=[];assert.equal(await review({id:id(750),notes:'Independent full monetary correction review'}),id(750));assert.ok(!calls.some(row=>row[0]==='object'))
 actor=id(2);await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)]);assert.equal(await prepare(input()),id(750))
 lost='withdraw_books_payroll_correction_proposal';await withdraw({id:id(750),reason:'Withdraw preserved monetary proposal before new construction decision'});await withdraw({id:id(750),reason:'Withdraw preserved monetary proposal before new construction decision'});assert.equal(await prepare(input()),id(750))
 const after=(await capture(f.db)).tables;assert.equal(after.books_payroll_correction_proposals[0].status,'withdrawn');assert.equal(after.books_payroll_correction_proposals[0].reviewed_by,id(51))
 for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','time_entries','billable_costs','books_payroll_postings','books_payroll_labor_ownership'])assert.deepEqual(after[name],before[name])
})
test('whole-organization authorization precedes every private correction monetary lifecycle read/write',async t=>{
 f=await proposalFixture(t);actor=id(2);denied=true;offline=false
 for(const run of [()=>prepare(input()),()=>review({id:id(750),notes:'Independent corrected monetary review'}),()=>withdraw({id:id(750),reason:'Withdraw corrected monetary proposal'})]){calls=[];await assert.rejects(run(),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']])}
 denied=false
})

const postingInput=()=>({id:id(760),proposalId:id(750),planDigest:f.proposal.plan_digest,notes:'Post exact reviewed corrective journal and construction costs',idempotencyKey:'service-atomic-correction-posting-key'})
test('posting service verifies provider bytes, recovers lost commit and confirms exact durable money without storage on retries',async t=>{
 f=await correctionPostingFixture(t);actor=id(2);denied=false;offline=true;lost=null;calls=[]
 await assert.rejects(post(postingInput()),/Storage unavailable/)
 assert.equal((await f.db.query('select count(*)::int n from books_payroll_correction_postings')).rows[0].n,0)
 offline=false;lost='post_books_payroll_correction_proposal';calls=[];const result=await post(postingInput());assert.equal(result.postingId,id(760));assert.deepEqual(calls[0],['authorize','books.adjust']);assert.ok(calls.some(call=>call[0]==='object'))
 offline=true;calls=[];assert.deepEqual(await post(postingInput()),result);assert.ok(!calls.some(call=>call[0]==='object'||call[1]==='post_books_payroll_correction_proposal'))
 await f.db.query("update accounting_periods set status='closed' where id=$1",[id(250)]);await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)]);assert.deepEqual(await post(postingInput()),result)
 await assert.rejects(post({...postingInput(),notes:'Different posting explanation after original commit'}),/different intent/)
 actor=id(51);await assert.rejects(post(postingInput()),/different intent/);actor=id(2)
 // A successful HTTP return alone cannot hide corrupted project-cost evidence.
 await f.db.exec('set session_replication_role=replica');await f.db.query('update job_cost_entries set cost_cents=cost_cents+1 where id=$1',[result.jobCosts[0].jobCostId]);await f.db.exec('set session_replication_role=origin');await assert.rejects(post(postingInput()),/posting differs/)
})
test('posting authorization precedes private reads and changed context cannot commit partial money',async t=>{
 f=await correctionPostingFixture(t);actor=id(2);denied=true;offline=false;calls=[]
 await assert.rejects(post(postingInput()),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']])
 denied=false;const before=(await capture(f.db)).tables;await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)])
 await assert.rejects(post(postingInput()),/evidence changed/)
 const after=(await capture(f.db)).tables;for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','books_payroll_correction_postings'])assert.deepEqual(after[name],before[name])
})

test('service prepares, independently reviews and posts a later correction with complete actual ancestry and lost-response recovery',async t=>{
 f=await lineageFixture(t);actor=id(2);denied=false;offline=false;lost='post_books_payroll_correction_proposal';calls=[]
 const first=await post(postingInput());assert.equal(first.sequence,1)
 const source=await nextSource(f),args={id:id(980),sourceId:source.id,notes:'Prepare subsequent monetary correction from actual posted register',idempotencyKey:'service-sequential-proposal-key'}
 lost='prepare_books_payroll_correction_proposal';assert.equal(await prepare(args),id(980))
 actor=id(51);lost='review_books_payroll_correction_proposal';assert.equal(await review({id:id(980),notes:'Independent subsequent construction and monetary review'}),id(980))
 const saved=(await f.db.query('select to_jsonb(q) row from books_payroll_correction_proposals q where id=$1',[id(980)])).rows[0].row
 assert.equal(saved.plan.baseline.previousPostingId,first.postingId);assert.equal(saved.plan.math.costDeltaCents,2000)
 actor=id(2);const args2={id:id(981),proposalId:saved.id,planDigest:saved.plan_digest,notes:'Post independently reviewed subsequent corrective payroll',idempotencyKey:'service-sequential-post-key'};lost='post_books_payroll_correction_proposal'
 const second=await post(args2);assert.equal(second.sequence,2);assert.equal(second.previousPostingId,first.postingId)
 offline=true;calls=[];assert.deepEqual(await post(args2),second);assert.deepEqual(await post(postingInput()),first);assert.ok(!calls.some(row=>row[0]==='object'))
 assert.equal(await prepare(args),saved.id,'original monetary preparation recovers after actual posting');actor=id(51);assert.equal(await review({id:saved.id,notes:'Independent subsequent construction and monetary review'}),saved.id)
 actor=id(2);await assert.rejects(withdraw({id:saved.id,reason:'Attempt to withdraw already posted sequential correction'}),/not withdrawal/)
})
test('a damaged monetary predecessor prevents service preparation before new provider storage or money writes',async t=>{
 f=await lineageFixture(t);actor=id(2);denied=false;offline=false;lost=null
 const first=await post(postingInput()),source=await nextSource(f),before=(await capture(f.db)).tables
 await f.db.exec('set session_replication_role=replica');await f.db.query('update job_cost_entries set cost_cents=cost_cents+1 where id=$1',[first.jobCosts[0].jobCostId]);await f.db.exec('set session_replication_role=origin');calls=[]
 await assert.rejects(prepare({id:id(980),sourceId:source.id,notes:'Prepare later correction requiring valid original monetary ancestry',idempotencyKey:'damaged-lineage-proposal-key'}),/posting differs/)
 assert.ok(!calls.some(row=>row[0]==='object'))
 const after=(await capture(f.db)).tables;for(const name of ['journal_entries','journal_lines','accounting_facts','books_payroll_correction_proposals','books_payroll_correction_postings'])assert.deepEqual(after[name],before[name])
})

test('construction placement service binds choices, verifies original CSV, recovers lost responses and rejects a different retry choice',async t=>{
 const {scenario}=require('./helpers/books-payroll-construction-decisions-fixture')
 f=await scenario(t);await f.db.exec(migrationSql("20261004053644_books_payroll_workspace_reads"));actor=id(2);denied=false;offline=false;calls=[];lost='prepare_books_payroll_correction_proposal'
 const request={id:id(999),sourceId:f.source.id,notes:'Prepare explicitly reviewed destination budget and GMP classification',idempotencyKey:'service-construction-choice-prepare-key',constructionDecisions:f.choices}
 assert.equal(await prepare(request),id(999));assert.ok(calls.some(row=>row[0]==='object'))
 const proposal=(await capture(f.db)).tables.books_payroll_correction_proposals.find(row=>row.id===id(999))
 assert.equal(proposal.plan.version,3);assert.deepEqual(proposal.plan.constructionDecisions,f.choices)
 offline=true;calls=[];assert.equal(await prepare(request),id(999));assert.ok(!calls.some(row=>row[0]==='object'))
 const changed=structuredClone(request);changed.constructionDecisions[0].gmpClassification='inside_gmp'
 await assert.rejects(prepare(changed),/different intent/)
 await assert.rejects(prepare({...request,constructionDecisions:undefined}),/different intent/)
 actor=id(51);offline=false;lost='review_books_payroll_correction_proposal';assert.equal(await review({id:id(999),notes:'Independent review of destination placement and unchanged customer rates'}),id(999))
 actor=id(2);lost='post_books_payroll_correction_proposal'
 const posting={id:id(975),proposalId:id(999),planDigest:proposal.plan_digest,notes:'Post independently reviewed provider correction placement',idempotencyKey:'service-construction-choice-post-key'}
 const result=await post(posting);assert.equal(result.sequence,2);assert.ok(result.jobCosts.some(row=>row.projectId===id(994)&&row.budgetLineId===id(998)))
 offline=true;calls=[];assert.deepEqual(await post(posting),result);assert.ok(!calls.some(row=>row[0]==='object'));assert.equal(await prepare(request),id(999))
})

test('project review workspace authorizes before private reads and rejects disabled Books and unrelated/foreign project access',async t=>{
 const {scenario}=require('./helpers/books-payroll-construction-decisions-fixture')
 f=await scenario(t);await f.db.exec(migrationSql("20261004053644_books_payroll_workspace_reads"));actor=id(2);offline=false;denied=true;calls=[]
 await assert.rejects(workspace(id(4)),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']])
 denied=false;f.disabled=true;calls=[];await assert.rejects(workspace(id(4)),/disabled/);assert.ok(!calls.some(c=>c[0]==='rpc'||c[0]==='read'))
 f.disabled=false;calls=[];const w=await workspace(id(4));assert.deepEqual(calls[0],['authorize','books.adjust']);assert.equal(w.sources.length,2);assert.deepEqual(calls.filter(row=>row[0]==='rpc'),[['rpc','capture_books_payroll_workspace_snapshot']]);calls=[];await assert.rejects(workspace(id(4),{preparedAt:'invalid',id:id(3)}));assert.ok(!calls.some(row=>row[0]==='rpc'||row[0]==='read'))
 assert.ok((await workspace(id(994))).sources.some(row=>row.id===f.source.id));await assert.rejects(workspace(id(9876)),/unavailable/)
 await f.db.query("insert into projects values($1,$2,'active')",[id(9877),org]);await assert.rejects(projectSource(id(9877),f.source.id),/does not affect/)
 await assert.rejects(projectSource(id(4),id(9878)),/does not affect|unavailable/i)
})
test('project detail exposes the entire cross-project register, current placement needs, independent-review and stale approval states',async t=>{
 const {scenario}=require('./helpers/books-payroll-construction-decisions-fixture')
 f=await scenario(t);await f.db.exec(migrationSql("20261004053644_books_payroll_workspace_reads"));actor=id(2);denied=false;offline=false;calls=[]
 let d=await detail({projectId:id(4),sourceId:f.source.id});assert.equal(d.ready,false);assert.equal(d.costs.length,6);assert.ok(d.costs.some(row=>row.projectId===id(994)));assert.equal(d.registerTotals.gross_cents,28000);assert.ok(d.budgetLines.some(row=>row.id===id(998)))
 const request={id:id(999),sourceId:f.source.id,notes:'Prepare explicitly reviewed destination placement',idempotencyKey:'project-workspace-choice-key',constructionDecisions:f.choices};await prepare(request)
 d=await detail({projectId:id(4),sourceId:f.source.id});assert.equal(d.ready,true);assert.equal(d.proposal.canReview,false);assert.equal(d.proposal.constructionDecisions.length,3)
 actor=id(51);d=await detail({projectId:id(994),sourceId:f.source.id});assert.equal(d.proposal.canReview,true);assert.equal(await projectProposal(id(4),id(999)),f.source.id)
 await f.db.query('update contracts set gmp_cents=100000 where id=$1',[id(996)])
 d=await detail({projectId:id(4),sourceId:f.source.id});assert.equal(d.ready,false);assert.match(d.currentError,/evidence has changed/i)
 await f.db.query('update contracts set gmp_cents=null where id=$1',[id(996)]);await review({id:id(999),notes:'Independent project monetary placement review'})
 const p=(await capture(f.db)).tables.books_payroll_correction_proposals.find(row=>row.id===id(999));actor=id(2);await post({id:id(975),proposalId:p.id,planDigest:p.plan_digest,notes:'Post full reviewed cross-project correction',idempotencyKey:'project-workspace-post-key'})
 await f.db.query("update projects set status='completed' where id=$1",[id(994)]);await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(998)])
 d=await detail({projectId:id(4),sourceId:f.source.id});assert.equal(d.receipt.id,id(975));assert.equal(d.costs.length,6);assert.equal(d.currentError,null);assert.equal(d.proposal.canReview,false);assert.equal(d.ready,false)
 const w=await workspace(id(994));assert.equal(w.sources.find(row=>row.id===f.source.id).status,'posted')
})

test('project review shows reservation conflicts and immutable withdrawn proposal history instead of silently losing it',async t=>{
 const {scenario}=require('./helpers/books-payroll-construction-decisions-fixture')
 f=await scenario(t);await f.db.exec(migrationSql("20261004053644_books_payroll_workspace_reads"));actor=id(2);denied=false;offline=false
 await prepare({id:id(999),sourceId:f.source.id,notes:'Prepare reviewed destination placement for full correction',idempotencyKey:'project-history-prepare-key',constructionDecisions:f.choices})
 const next=await nextSource(f,{number:2,gross:29000,date:'2026-09-22',allocation:{project_id:id(994)}})
 const blocked=await detail({projectId:id(994),sourceId:next.id});assert.equal(blocked.ready,false);assert.match(blocked.currentError,/Another correction/)
 await withdraw({id:id(999),reason:'Withdraw proposal before preparing replacement commercial evidence'})
 const history=await detail({projectId:id(4),sourceId:f.source.id});assert.equal(history.proposal,null);assert.equal(history.reviewHistory.length,1);assert.equal(history.reviewHistory[0].status,'withdrawn');assert.match(history.reviewHistory[0].withdrawalReason,/replacement commercial/)
})
