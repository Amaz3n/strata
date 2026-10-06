require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript")
function history({ count = 2, denied = false, scoped = false, noDivisions = false, hiddenProject = false, hiddenParent = false, failedTable = null, missingAmount = false } = {}) {
  const calls = []
  const awards = Array.from({ length: count }, (_,i) => ({ id:`award-${i}`, awarded_commitment_id:`commitment-${i}`, package:{ id:`package-${i}`, project_id:`project-${i}`, community_id:hiddenParent ? "hidden" : null, community:null, house_plan_id:null, plan:null, budget_line_id:`budget-${i}` } }))
  const tables = { bid_awards:awards, projects:awards.map((_,i) => ({ id:`project-${i}`, division_id:hiddenProject ? "other" : "assigned" })), commitments:awards.map((_,i) => ({ id:`commitment-${i}`, total_cents:i%2 ? 300 : 100 })), budget_lines:awards.map((_,i) => ({id:`budget-${i}`,amount_cents:200})) }
  if (missingAmount) tables.commitments.pop()
  const db = { from(table) {
    let rows=tables[table] ?? []
    const filters=[]
    const q={ select(value){filters.push(["select",value]);return q},returns(){return q},eq(k,v){filters.push([k,v]);return q},is(){return q},order(){return q},or(value,opts){filters.push([opts.referencedTable,value]);return q},in(k,v){filters.push([k,v]);if(k === "id" || k === "division_id") rows=rows.filter(row=>v.includes(row[k]));return q},range(a,b){rows=rows.slice(a,b+1);return q},then(resolve,reject){calls.push({table,filters});return Promise.resolve({data:rows,error:failedTable===table ? {message:"offline"}:null}).then(resolve,reject)}};return q
  } }
  const compiled={exports:{}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/bid-intelligence.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require(name){
    if (name === "zod") return require("zod")
    if (name === "@/lib/services/bid-intelligence-visibility") return {}
    if(name==="@/lib/services/context")return {requireOrgContext:async()=>({supabase:db,orgId:"org",userId:"user"})}
    if(name==="@/lib/services/permissions")return {requirePermission:async()=>{if(denied)throw new Error("Forbidden")}}
    if(name==="@/lib/services/authorization")return {getDivisionAccessForUser:async()=>({assignedOnly:scoped,divisionIds:noDivisions?[]:["assigned"]})}
    if(name==="@/lib/land/paging")return require("../lib/land/paging")
    if(name==="@/lib/services/bids")return {}
    throw new Error(name)
  }})
  return {get:()=>compiled.exports.getCostCodeBidHistory("cost-code"),calls}
}
test("history has complete award pagination, bounded reference batches and correct even median",async()=>{
  const instance=history({count:1002})
  const result=await instance.get()
  assert.equal(result.award_count,1002)
  assert.equal(result.median_bid_to_budget_pct,100)
  assert.equal(result.min_award_cents,100)
  assert.equal(result.max_award_cents,300)
  assert.equal(instance.calls.filter(call=>call.table==="bid_awards").length,3)
  for(const call of instance.calls){
    assert.ok(call.filters.some(([k,v])=>k==="org_id"&&v==="org"))
    if(call.table==="bid_awards")assert.ok(call.filters.some(([k,v])=>k==="package.cost_code_id"&&v==="cost-code"))
    else assert.ok(call.filters.find(([k])=>k==="id")[1].length<=100)
  }
})
test("history rejects unauthorized callers and excludes hidden parents before reading amounts",async()=>{
  const denied=history({denied:true});await assert.rejects(denied.get(),/Forbidden/);assert.equal(denied.calls.length,0)
  const none=history({scoped:true,noDivisions:true});assert.equal((await none.get()).award_count,0);assert.equal(none.calls.length,0)
  for(const options of [{scoped:true,hiddenProject:true},{scoped:true,hiddenParent:true}]){
    const instance=history(options);assert.equal((await instance.get()).award_count,0)
    assert.equal(instance.calls.some(call=>["commitments","budget_lines"].includes(call.table)),false)
  }
})
test("history fails explicitly on read failures and missing referenced amounts",async()=>{
  for(const failedTable of ["bid_awards","projects","commitments","budget_lines"])await assert.rejects(history({failedTable}).get(),/offline/)
  await assert.rejects(history({missingAmount:true}).get(),/missing amounts/)
})
