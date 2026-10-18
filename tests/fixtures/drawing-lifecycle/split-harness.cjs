const assert=require("node:assert/strict")
const {loadHandler,database}=require("./harness.cjs")
const {syntheticPdf}=require("./synthetic.cjs")
async function createSplitFixture(pages){
 let started=0
 const bytes=await syntheticPdf(pages),mupdf=await import('mupdf'),objects=new Map(),counts={downloads:0,opens:0,puts:0,registrationCalls:0,registrationBatchSizes:[],firstEmittedAfterPuts:null,firstPageMs:null};let failAt=null
 const tables={drawing_sets:[{id:'set',org_id:'org',project_id:'project',title:'Set'}],files:[{id:'file',org_id:'org',storage_path:'source.pdf'}],
 drawing_revisions:[{id:'revision',org_id:'org',status:'processing',processed_pages:0}],drawing_deleted_pages:[],drawing_split_pages:[],outbox:[],
 drawing_sheet_versions:Array.from({length:pages},(_,page_index)=>({id:`version-${page_index}`,org_id:'org',drawing_revision_id:'revision',drawing_sheet_id:`sheet-${page_index}`,page_index}))}
 const db=database(tables,async(name,args)=>{
  if(name==='register_drawing_split_batch'){
   counts.registrationCalls++;counts.registrationBatchSizes.push(args.p_pages.length)
   return {data:args.p_pages.map(page=>{
    let intent=tables.drawing_split_pages.find(p=>p.page_index===page.pageIndex)
    if(!intent){intent={id:`intent-${page.pageIndex}`,org_id:'org',revision_id:'revision',source_hash:page.sourceHash,page_index:page.pageIndex,state:'reserved',storage_prefix:`org/split/${page.pageIndex}`};tables.drawing_split_pages.push(intent)}
    return {...intent,pageIndex:page.pageIndex,sheetId:`sheet-${page.pageIndex}`,versionId:`version-${page.pageIndex}`}
   })}
  }
  if(name==='emit_drawing_split_page'){
   const intent=tables.drawing_split_pages.find(p=>p.id===args.p_intent_id)
   if(args.p_payload.pagePdfPath)assert.ok(objects.has(args.p_payload.pagePdfPath),'PUT must precede fanout')
   if(intent.state!=='emitted'){intent.state='emitted';tables.outbox.push(args.p_payload);counts.firstEmittedAfterPuts??=counts.puts;counts.firstPageMs??=performance.now()-started}
   return {data:tables.outbox.length}
  }
  throw Error(`Unexpected RPC ${name}`)
 })
 const pipeline=loadHandler('lib/services/drawings-pipeline.ts',{
  '@/lib/services/mupdf-loader':{loadMupdf:async()=>({...mupdf,Document:{openDocument:(...args)=>{counts.opens++;return mupdf.Document.openDocument(...args)}}})},
  '@/lib/storage/drawings-pdfs-storage':{downloadDrawingPdfObject:async()=>{counts.downloads++;return bytes}},
  '@/lib/storage/drawings-tiles-storage':{uploadTilesObject:async({path,bytes})=>{counts.puts++;if(counts.puts===failAt)throw Error('storage interrupted');objects.set(path,bytes)}},
  '@/lib/services/ai/drawings-vision':{drawingsVisionConfigured:async()=>false},
  '@/lib/services/drawings-pipeline-trigger':{triggerDrawingsPipeline:async()=>{}},
 },['handleProcessDrawingSet','drawingRenderRecipe'])
 const job={org_id:'org',payload:{orgId:'org',drawingSetId:'set',projectId:'project',sourceFileId:'file',draftRevisionId:'revision'}}
 return {tables,db,counts,pipeline,job,objects,fail:at=>{failAt=at},run:()=>{started=performance.now();return pipeline.handleProcessDrawingSet(db.client,job,Date.now()+770000)}}
}

module.exports={createSplitFixture}
