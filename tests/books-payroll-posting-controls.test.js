require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {sources,prepareProposal,reviewProposal}=require('./helpers/books-payroll-posting-proposal-fixture')
const {scenario,refresh,capture}=require('./helpers/books-payroll-workflow-fixture')
const {prepare,review}=require('./helpers/books-payroll-database')
const {id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollPostingPlan}=require('../lib/services/books/payroll-posting-plan')
const context=async f=>(await f.db.query('select lock_books_payroll_posting_context($1,$2) controls',[org,id(230)])).rows[0].controls
const period=(f,i,start,end,status='open')=>f.db.query('insert into accounting_periods(id,org_id,period_start,period_end,status,fiscal_year,fiscal_period) values($1,$2,$3,$4,$5,2026,9)',[id(i),org,start,end,status])
async function ready(t){
 const f=await scenario(t,true)
 await f.db.exec("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"time_and_materials_rate\"')");await refresh(f)
 await prepare(f.db,f.evidence);await review(f.db,f.evidence);f.parent=(await capture(f.db)).tables.books_payroll_imports[0];f.plan=payrollPostingPlan(f.parent,null)
 await prepareProposal(f);await reviewProposal(f);return f
}
test('posting context checks every dated journal and reports missing/closed/reviewing calendar and construction review',async t=>{
 const f=await sources(t);await prepareProposal(f);await reviewProposal(f)
 let c=await context(f);assert.equal(c.controlsSatisfied,false);assert.equal(c.calendarBlockers.length,2);assert.ok(c.constructionBlockers.some(row=>row.code==='review_cost_plus_correction'))
 await period(f,250,'2026-09-01','2026-09-16');await period(f,251,'2026-09-17','2026-09-30','closed')
 c=await context(f);assert.deepEqual(c.calendarBlockers,[{accountingDate:'2026-09-18',code:'accounting_period_closed'}])
 await f.db.query('update accounting_periods set status=$1 where id=$2',['reviewing',id(251)]);c=await context(f);assert.equal(c.calendarBlockers[0].code,'accounting_period_reviewing')
 await f.db.query('update accounting_periods set status=$1 where id=$2',['reopened',id(251)]);c=await context(f);assert.equal(c.calendarBlockers.length,0);assert.equal(c.controlsSatisfied,false,'cost-plus review remains unresolved after reopen')
 assert.equal(c.postingImplemented,false)
})
test('reviewed T&M corrections pass current controls with open or reopened periods and preserve hourly customer amounts',async t=>{
 const f=await ready(t);await period(f,250,'2026-09-01','2026-09-30')
 let c=await context(f);assert.equal(c.controlsSatisfied,true);assert.deepEqual(c.constructionBlockers,[]);assert.equal(c.accountingDates.length,1)
 await f.db.query('update accounting_periods set status=$1 where id=$2',['reopened',id(250)]);c=await context(f);assert.equal(c.controlsSatisfied,true)
 const before=(await capture(f.db)).tables;await context(f);const after=(await capture(f.db)).tables
 for(const name of ['journal_entries','journal_lines','job_cost_entries','billable_costs','books_payroll_posting_proposals'])assert.deepEqual(after[name],before[name],'preflight does not post '+name)
})
test('source freeze is exclusive and calendar reads shared until transaction ends; normal writers use shared source fence',async t=>{
 const f=await ready(t);await period(f,250,'2026-09-01','2026-09-30')
 const locks=async()=> (await f.db.query("select label,mode from (values('source',hashtextextended('books-payroll-source:'||$1,0)),('calendar',hashtextextended('books-period-calendar:'||$1,0))) k(label,key) join pg_locks l on l.locktype='advisory' and l.pid=pg_backend_pid() and l.classid=((k.key>>32)&4294967295)::oid and l.objid=(k.key&4294967295)::oid order by label,mode",[org])).rows
 await f.db.exec('begin');await context(f)
 const held=await locks();assert.ok(held.some(row=>row.label==='source'&&row.mode==='ExclusiveLock'));assert.ok(held.some(row=>row.label==='calendar'&&row.mode==='ShareLock'))
 await f.db.exec('commit');assert.deepEqual(await locks(),[])
 await f.db.exec('begin');await f.db.query('update time_entries set hours=hours where id=$1',[id(81)]);assert.deepEqual(await locks(),[{label:'source',mode:'ShareLock'}]);await f.db.exec('rollback')
})
test('stale source or unreviewed/withdrawn proposal cannot obtain posting context',async t=>{
 const f=await sources(t);await prepareProposal(f);await assert.rejects(context(f),/reviewed full proposal/);await reviewProposal(f)
 await f.db.query('update journal_lines set dimensions=$1::jsonb where id=$2',[JSON.stringify({payment_reference:'Changed after full proposal review'}),id(63)])
 await assert.rejects(context(f),/source revision changed/)
 await assert.rejects(f.db.query('select lock_books_payroll_posting_context($1,$2)',[id(99),id(230)]),/unavailable in organization/)
 const flags=(await f.db.query("select has_function_privilege('authenticated','lock_books_payroll_posting_context(uuid,uuid)','execute') browser,has_function_privilege('service_role','lock_books_payroll_posting_context(uuid,uuid)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,service:true})
})
test('legacy overlapping calendar blocks posting context rather than guessing one period',async t=>{
 const f=await ready(t);await period(f,250,'2026-09-01','2026-09-30');await period(f,251,'2026-09-10','2026-09-20')
 const c=await context(f);assert.equal(c.controlsSatisfied,false);assert.deepEqual(c.calendarBlockers,[{accountingDate:'2026-09-15',code:'ambiguous_accounting_period'}])
})
