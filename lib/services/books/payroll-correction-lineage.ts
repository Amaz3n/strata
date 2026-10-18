import { z } from "zod"
const uuid=z.string().uuid().toLowerCase()
export const payrollCorrectionBaselineSchema=z.object({previousPostingId:uuid.nullable(),previousSourceId:uuid.nullable(),previousPlanDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),sequence:z.number().int().positive().safe()}).strict()
const linkSchema=z.object({id:uuid,org_id:uuid,source_id:uuid,posting_id:uuid,plan_digest:z.string().regex(/^[a-f0-9]{64}$/),previous_posting_id:uuid.nullable().optional().default(null),sequence:z.number().int().positive().safe().optional().default(1),result:z.object({journalId:uuid}).passthrough()}).passthrough()
type Tables=Record<string,Record<string,unknown>[]>
/** Select only durable monetary ancestry. Explicit null replays a first historical
 * approval; omitted identity selects the current head for a new proposal. */
export function payrollCorrectionLineage(tables:Tables,orgId:string,rootId:string,previousId?:string|null){
 const available=(tables.books_payroll_correction_postings??[]).filter(row=>row.org_id===orgId&&row.posting_id===rootId)
 if(previousId===null)return {baseline:{previousPostingId:null,previousSourceId:null,previousPlanDigest:null,sequence:1},postings:[]}
 const rows=available.map(row=>linkSchema.parse(row)).sort((a,b)=>a.sequence-b.sequence)
 const head=previousId===undefined?rows.at(-1):rows.find(row=>row.id===previousId)
 if(previousId!==undefined&&!head)throw new Error("Correction monetary predecessor is missing")
 if(!head)return {baseline:{previousPostingId:null,previousSourceId:null,previousPlanDigest:null,sequence:1},postings:[]}
 const selected=rows.filter(row=>row.sequence<=head.sequence),ids=new Set<string>(),sources=new Set<string>()
 for(const [index,row] of selected.entries()){
  if(row.sequence!==index+1||row.previous_posting_id!==(index===0?null:selected[index-1].id)||ids.has(row.id)||sources.has(row.source_id))throw new Error("Correction monetary lineage is incomplete, branched or cyclic")
  ids.add(row.id);sources.add(row.source_id)
 }
 return {baseline:{previousPostingId:head.id,previousSourceId:head.source_id,previousPlanDigest:head.plan_digest,sequence:head.sequence+1},postings:selected}
}
