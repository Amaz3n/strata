require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript")
const vendor = "00000000-0000-4000-8000-000000000001"
function service({ denied=false, scoped=true, hidden=false, count=1, fail=null, missingPackage=false, signedChange=10, total=100, distinctPackages=false, production=false, missingAward=false }={}) {
  const calls=[]
  const tables={
    bid_invites:Array.from({length:count},(_,i)=>({id:`invite-${i}`,company_id:vendor,bid_package_id:distinctPackages ? `package-${i}` : "package",status:i%2?"declined":"submitted"})),
    bid_packages:missingPackage?[]:Array.from({length:distinctPackages?count:1},(_,i)=>({id:distinctPackages?`package-${i}`:"package",community_id:"community",house_plan_id:"plan",project_id:null})),
    communities:[{id:"community",division_id:hidden?"other":"assigned"}],house_plans:[{id:"plan",division_id:null}],
    projects:[{id:"project",division_id:hidden?"other":"assigned"}],
    commitments:[{id:"commitment",project_id:"project",company_id:vendor,total_cents:total,status:"approved","metadata->>source":"bid_award"},{id:"canceled",project_id:"project",company_id:vendor,total_cents:999,status:"canceled","metadata->>source":"bid_award"}],
    vendor_price_agreements:production ? [...Array.from({length:1001},(_,i)=>({id:`agreement-${i}`,company_id:vendor,source_bid_award_id:"award"})),{id:"rescinded-agreement",company_id:vendor,source_bid_award_id:"rescinded"},{id:"hidden-agreement",company_id:vendor,source_bid_award_id:"hidden-award"}] : [],
    bid_awards:production ? [{id:"award",bid_package_id:"package",rescinded_at:null},{id:"rescinded",bid_package_id:"package",rescinded_at:"2026-01-01"},{id:"hidden-award",bid_package_id:"hidden-package",rescinded_at:null}].filter(row=>!missingAward||row.id!=="award") : [],
    commitment_change_orders:Array.from({length:count},(_,i)=>({id:`co-${i}`,commitment_id:"commitment",total_cents:signedChange,status:"approved"})),
  }
  if(production){tables.bid_packages.push({id:"hidden-package",project_id:null,community_id:"hidden-community",house_plan_id:null});tables.communities.push({id:"hidden-community",division_id:"other"})}
  const db={from(table){let rows=tables[table]??[];const filters=[];let start=0
    const q={select(){return q},not(k,op,v){rows=rows.filter(row=>row[k]!==v);return q},eq(k,v){filters.push([k,v]);if(k!=="org_id")rows=rows.filter(row=>row[k]===v);return q},neq(k,v){rows=rows.filter(row=>row[k]!==v);return q},in(k,v){filters.push([k,v]);rows=rows.filter(row=>v.includes(row[k]));return q},or(){rows=rows.filter(row=>row.division_id==null||row.division_id==="assigned");return q},order(){return q},range(a,b){start=a;rows=rows.slice(a,b+1);return q},then(resolve,reject){calls.push({table,filters,start});return Promise.resolve({data:rows,error:fail===table?{message:"offline"}:null}).then(resolve,reject)}};return q}}
  function compile(path,dependencies){const compiled={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(path),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require:dependencies});return compiled.exports}
  const visibility=compile("../lib/services/bid-intelligence-visibility.ts",()=>{throw new Error("Unexpected runtime dependency")})
  const api=compile("../lib/services/bid-intelligence.ts",name=>{
    if(name==="zod")return require("zod")
    if(name==="@/lib/services/bid-intelligence-visibility")return visibility
    if(name==="@/lib/services/context")return {requireOrgContext:async()=>({supabase:db,orgId:"org",userId:"user"})}
    if(name==="@/lib/services/permissions")return {requirePermission:async()=>{if(denied)throw new Error("Forbidden")}}
    if(name==="@/lib/services/authorization")return {getDivisionAccessForUser:async()=>({assignedOnly:scoped,divisionIds:["assigned"]})}
    if(name==="@/lib/land/paging")return require("../lib/land/paging")
    if(name==="@/lib/services/bids")return {}
    throw new Error(name)
  })
  return {get:(ids=[vendor])=>api.getVendorBidStats(ids),calls}
}
test("vendor statistics authorize before reads and hide out-of-division activity",async()=>{
  const denied=service({denied:true});await assert.rejects(denied.get(),/Forbidden/);assert.equal(denied.calls.length,0)
  const hidden=service({hidden:true});const result=(await hidden.get()).get(vendor)
  assert.equal(result.invited_count,0);assert.equal(result.awarded_count,0);assert.equal(result.change_order_growth_pct,null)
  assert.equal(hidden.calls.some(call=>call.table==="commitment_change_orders"),false)
})
test("vendor counts and growth include every page and exclude canceled commitments",async()=>{
  const instance=service({count:1001,distinctPackages:true})
  const result=(await instance.get([vendor,vendor])).get(vendor)
  assert.equal(result.invited_count,1001);assert.equal(result.submitted_count,501);assert.equal(result.declined_count,500)
  assert.equal(result.awarded_count,1);assert.equal(result.change_order_growth_pct,10010)
  assert.equal(instance.calls.filter(call=>call.table==="bid_invites").length,3)
  assert.equal(instance.calls.filter(call=>call.table==="commitment_change_orders").length,3)
  assert.equal(instance.calls.filter(call=>call.table==="bid_packages").length,11)
  for(const call of instance.calls){
    assert.ok(call.filters.some(([k,v])=>k==="org_id"&&v==="org"))
    for(const [key,values] of call.filters)if(["id","company_id","commitment_id"].includes(key))assert.ok(values.length<=100)
  }
})
test("vendor statistics fail closed on missing ancestry and any failed history read",async()=>{
  for(const fail of ["bid_invites","commitments","vendor_price_agreements","bid_packages","communities","house_plans","projects","commitment_change_orders"])await assert.rejects(service({fail}).get(),/offline/)
  await assert.rejects(service({missingPackage:true}).get(),/missing packages/)
  for(const total of [null,-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(service({total}).get(),/invalid monetary/)
})
test("vendor growth handles credits, zero bases and malformed vendor identifiers",async()=>{
  assert.equal((await service({signedChange:-10}).get()).get(vendor).change_order_growth_pct,-10)
  assert.equal((await service({total:0}).get()).get(vendor).change_order_growth_pct,null)
  const instance=service();await assert.rejects(instance.get(["bad"]));assert.equal(instance.calls.length,0)
})


test("production experience counts distinct visible awards, not agreement rows or revisions",async()=>{
  const instance=service({production:true})
  const result=(await instance.get()).get(vendor)
  assert.equal(result.production_awarded_count,1)
  assert.equal(result.awarded_count,1)
  assert.equal(instance.calls.filter(call=>call.table==="vendor_price_agreements").length,3)
  assert.equal((await service({production:true,scoped:false}).get()).get(vendor).production_awarded_count,2)
  await assert.rejects(service({production:true,missingAward:true}).get(),/missing awards/)
  await assert.rejects(service({production:true,fail:"bid_awards"}).get(),/offline/)
})
