require("../scripts/register-ts-node-test")
const assert=require("node:assert/strict"),test=require("node:test"),fs=require("node:fs"),vm=require("node:vm"),ts=require("typescript")
function report({count=1001,denied=false,failedTable=null,deniedDivision=false,unrestricted=false}={}){
 const calls=[]
 const projects=Array.from({length:count},(_,i)=>({id:`project-${String(i).padStart(6,"0")}`,division_id:"division",phase:"delivery",division:{name:"Division"}}))
 const orders=projects.map((p,i)=>({id:`order-${i}`,project_id:p.id,total_cents:100,approved_at:"2026-01-05T00:00:00Z",status:"approved",reason_code_id:"reason",reason:{label:"Overrun"},company_id:"vendor",company:{name:"Vendor"}}))
 if(projects.length)orders.push({...orders[0],id:"other-reason",reason_code_id:"second",reason:{label:"Second reason"}})
 const tables={projects,commitment_change_orders:orders,lots:projects.map((p,i)=>({id:`lot-${i}`,project_id:p.id,community_id:"community",community:{name:"Community"},house_plan_id:"plan",house_plan:{name:"Plan"},division_id:"division"})),budgets:projects.flatMap((p,i)=>[{id:`new-${i}`,project_id:p.id,total_cents:10000,version:2},{id:`old-${i}`,project_id:p.id,total_cents:5000,version:1}]),roles:[{id:"field",key:"field"}],project_members:projects.map((p,i)=>({id:`member-${i}`,project_id:p.id,user_id:"super",status:"active",role_id:"field",created_at:"2026-01-01",user:{full_name:"Super"}}))}
 const db={from(table){let rows=tables[table]??[];const filters=[],sorting=[];let start=0,end=Infinity
  const q={select(){return q},eq(k,v){filters.push([k,v]);if(k!=="org_id")rows=rows.filter(row=>row[k]===v);return q},in(k,v){filters.push([k,v]);rows=rows.filter(row=>v.includes(row[k]));return q},not(k,op,v){rows=rows.filter(row=>row[k]!==v);return q},gte(k,v){filters.push(["gte",k,v]);return q},lt(k,v){filters.push(["lt",k,v]);return q},order(k,opts){sorting.push([k,opts?.ascending!==false]);return q},range(a,b){start=a;end=b;return q},then(resolve,reject){calls.push({table,filters,start});const sorted=[...rows].sort((a,b)=>{for(const [k,asc]of sorting){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(asc?1:-1)}return 0});return Promise.resolve({data:sorted.slice(start,end+1),error:failedTable===table?{message:"offline"}:null}).then(resolve,reject)}};return q}}
 tables.aggregate=[...Array.from({length:count},(_,i)=>({dimension:"reason",dimension_id:`reason-${i}`,dimension_label:`Reason ${i}`,net_variance_cents:100,absolute_variance_cents:100,incidence:1,direct_cost_budget_cents:10000,variance_rate:0.01})),{dimension:"division",dimension_id:"division",dimension_label:"Division",net_variance_cents:count*100,absolute_variance_cents:count*100,incidence:count,direct_cost_budget_cents:10000,variance_rate:count/100}]
 db.rpc=(name,args)=>{assert.equal(name,"get_variance_analysis");assert.equal(args.p_org_id,"org");return db.from("aggregate")}
 const compiled={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/reports/variance-analysis.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require(name){
 if(name==="@/lib/services/context")return {requireOrgContext:async()=>({supabase:db,orgId:"org",userId:"user"})}
 if(name==="@/lib/services/authorization")return {requireAuthorization:async()=>{if(denied)throw new Error("Forbidden")},getDivisionAccessForUser:async()=>({assignedOnly:!unrestricted,divisionIds:deniedDivision?["other"]:["division"]})}
 if(name==="@/lib/reports/date-range")return require("../lib/reports/date-range")
 if(name==="@/lib/land/paging")return require("../lib/land/paging")
 if(name==="@/lib/land/scope")return require("../lib/land/scope")
 if(name==="@/lib/services/reports/csv")return {}
 throw new Error(name)
 }})
 return {get:(overrides={})=>compiled.exports.getVarianceAnalysis({startDate:"2026-01-01",endDate:"2026-01-31",divisionId:unrestricted?undefined:"division",...overrides}),calls}
}
test("division variance includes more than 1000 homes and does not multiply budgets across reasons",async()=>{
 const instance=report();const result=await instance.get()
 assert.equal(result.summary.incidence,1002)
 assert.equal(result.summary.totalAbsoluteCents,100200)
 assert.equal(result.summary.directCostBudgetCents,10010000)
 assert.equal(result.summary.varianceRate,100200/10010000)
 assert.equal(result.rows.find(row=>row.dimension==="superintendent").incidence,1002)
 assert.equal(result.rows.find(row=>row.dimension==="community").incidence,1002)
 for(const call of instance.calls){for(const [key,values]of call.filters)if(["project_id","id"].includes(key))assert.ok(values.length<=100)}
 assert.ok(instance.calls.some(call=>call.table==="projects"&&call.start===1000))
})
test("variance scope refuses unauthorized users and never widens a forbidden division",async()=>{
 const denied=report({denied:true});await assert.rejects(denied.get(),/Forbidden/);assert.equal(denied.calls.length,0)
 const hidden=report({deniedDivision:true});assert.equal((await hidden.get()).summary.incidence,0);assert.equal(hidden.calls.length,0)
})
test("variance data failures cannot become incomplete totals",async()=>{
 for(const failedTable of ["projects","commitment_change_orders","lots","budgets","roles","project_members"])await assert.rejects(report({count:2,failedTable}).get(),/offline/)
})


test("organization-wide variance reads every aggregate group and counts the summary budget once",async()=>{
 const instance=report({unrestricted:true});const result=await instance.get()
 assert.equal(result.rows.length,1002)
 assert.equal(result.summary.incidence,1001)
 assert.equal(result.summary.directCostBudgetCents,10000)
 assert.equal(instance.calls.filter(call=>call.table==="aggregate").length,2)
 await assert.rejects(report({unrestricted:true,failedTable:"aggregate"}).get(),/offline/)
})


test("variance report rejects invalid ranges before reads and uses an exclusive next-day cutoff",async()=>{
 for(const overrides of [{startDate:"2026-02-30"},{endDate:"2025-12-31"},{endDate:"2026-01-31T23:00:00Z"}]){
  const instance=report({count:1});await assert.rejects(instance.get(overrides),/Report/);assert.equal(instance.calls.length,0)
 }
 const instance=report({count:1});await instance.get()
 const query=instance.calls.find(call=>call.table==="commitment_change_orders")
 assert.ok(query.filters.some(([op,k,v])=>op==="gte"&&k==="approved_at"&&v==="2026-01-01T00:00:00.000Z"))
 assert.ok(query.filters.some(([op,k,v])=>op==="lt"&&k==="approved_at"&&v==="2026-02-01T00:00:00.000Z"))
})
