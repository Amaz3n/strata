require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const {bidEligibilityReason,calculatePricingBasis} = require("../lib/bids/pricing")
const bid = (patch={})=>({is_current:true,status:"submitted",total_cents:100000,scope_revision:2,...patch})
const scope=[{id:"base",item_type:"base",description:"Concrete"},{id:"gap",item_type:"base",description:"Pumping"},{id:"deduct",item_type:"alternate",description:"Alternate finish"}]
const priced=bid({items:[{bid_scope_item_id:"base",response:"priced",amount_cents:100000},{bid_scope_item_id:"gap",response:"excluded",gc_plug_cents:20000},{bid_scope_item_id:"deduct",response:"priced",amount_cents:-10000}]})
const gap={scope_item_id:"gap",description:"Pumping",amount_cents:20000,disposition:"allowance",owner:"Estimator",note:"Carry separate pumping allowance"}
test("withdrawn, expired, superseded and obsolete scope quotes cannot be selected",()=>{
 assert.match(bidEligibilityReason(bid({status:"withdrawn"}),2),/withdrawn/)
 assert.match(bidEligibilityReason(bid({valid_until:"2026-01-01"}),2,"2026-01-02"),/expired/)
 assert.equal(bidEligibilityReason(bid({valid_until:"2026-01-02"}),2,"2026-01-02"),null)
 assert.match(bidEligibilityReason(bid({is_current:false}),2),/supersedes/)
 assert.match(bidEligibilityReason(bid(),3),/scope changed/)
})
test("a deduct alternate changes vendor value; owned scope gap stays in complete cost",()=>{
 assert.deepEqual(calculatePricingBasis(priced,scope,["deduct"],[gap]),{vendor_total_cents:90000,normalized_total_cents:110000,gap_total_cents:20000})
})
test("selection cannot silently drop excluded scope or assign unowned scope",()=>{
 assert.throws(()=>calculatePricingBasis(priced,scope,[],[]),/Resolve every/)
 assert.throws(()=>calculatePricingBasis(priced,scope,[],[{...gap,owner:""}]),/Assign responsibility/)
 assert.throws(()=>calculatePricingBasis(priced,scope,[],[{...gap,disposition:"unresolved"}]),/Assign responsibility/)
})
test("owner exclusions need justification and do not inflate carried scope cost",()=>{
 assert.throws(()=>calculatePricingBasis(priced,scope,[],[{...gap,disposition:"owner_exclusion",note:""}]),/Describe/)
 assert.equal(calculatePricingBasis(priced,scope,[],[{...gap,disposition:"owner_exclusion"}]).normalized_total_cents,100000)
})
test("invalid alternates cannot leak into a decision",()=>{
 assert.throws(()=>calculatePricingBasis(priced,scope,["unknown"],[gap]),/Unknown alternate/)
 assert.throws(()=>calculatePricingBasis({...priced,items:priced.items.map(i=>i.bid_scope_item_id==="deduct"?{...i,amount_cents:-110000}:i)},scope,["deduct"],[gap]),/cannot exceed/)
})
test("unstructured quote against issued scope requires explicit coverage and duplicate gaps are rejected",()=>{
 assert.throws(()=>calculatePricingBasis(bid(),scope,[],[]),/Resolve every/)
 assert.throws(()=>calculatePricingBasis(priced,scope,[],[gap,gap]),/only once/)
})
