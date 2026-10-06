const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function service({flag=true,denied=false,homeDenied=false,race=false,failedTable=null}={}){
 const captured={reads:[],authorized:[],reserves:[],publishes:[]},configuration={lot_id:id(4),house_plan_id:null,house_plan_version_id:null,elevation_id:null,swing:'left'}
 const tables={contracts:[{id:id(1),org_id:id(2),project_id:id(3),contract_type:'purchase_agreement',status:'draft',buyer_contact_id:id(5),co_buyer_contact_id:null,snapshot:{purchase_agreement:{configuration}}}],lots:[{id:id(4),org_id:id(2),project_id:id(3),house_plan_id:null,house_plan_version_id:null,house_plan_elevation_id:null,swing:'left',status:'assigned'}],lot_reservations:[{id:id(6),org_id:id(2),lot_id:id(4),contract_id:id(1),status:'reserved'}]}
 let contractReads=0
 const supabase={from(table){captured.reads.push(table);let rows=tables[table]??[];const q={select(columns){if(table==='lots')for(const column of columns.split(','))assert.ok(Object.hasOwn(tables.lots[0],column),`Unknown lot column ${column}`);return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},limit(n){rows=rows.slice(0,n);return q},maybeSingle:async()=>{contractReads+=table==='contracts'?1:0;return {data:race&&table==='contracts'&&contractReads===2?{...rows[0],project_id:id(99)}:rows[0]??null,error:failedTable===table?{message:'Read failed'}:null}},then(resolve,reject){return Promise.resolve({data:rows,error:failedTable===table?{message:'Read failed'}:null}).then(resolve,reject)}};return q}}
 const compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/community-sales.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{ARC_AGREEMENT_DURABLE_SIGNING_ENABLED:flag?'true':'false',DOCUMENT_SIGNING_SECRET:'test-only'}},require(name){
 if(name==='zod'||name==='crypto')return require(name)
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({supabase,orgId:id(2),userId:id(7)})}
 if(name==='@/lib/services/permissions')return {requirePermission:async()=>{if(denied)throw new Error('Denied')}}
 if(name==='@/lib/services/authorization')return {requireAuthorization:async input=>{captured.authorized.push(input);if(homeDenied)throw new Error('Home denied')}}
 if(name==='@/lib/storage/files-storage')return {getFilesStorageProvider:()=> 'r2'}
 if(name==='@/lib/services/agreement-signing-ownership')return {reserveAgreementSigningDocument:async input=>{captured.reserves.push(input);return {id:id(8),source_file_id:id(9)}},publishOwnedAgreementDocument:async input=>{captured.publishes.push(input);return {documentId:id(8),envelopeId:id(10),reason:'Queued'}}}
 return {}
 }})
 return {tables,captured,run:()=>compiled.exports.resumePurchaseAgreementSigning({contractId:id(1),projectId:id(3)})}
}
test('recovery proves saved reservation and actual home before resuming the existing packet',async()=>{
 const f=service(),result=await f.run()
 assert.equal(result.documentId,id(8));assert.equal(f.captured.publishes.length,1)
 assert.equal(f.captured.reserves.length,1)
 assert.ok(f.captured.authorized.every(c=>c.projectId===id(3)&&c.permission==='sales.manage'))
 assert.ok(f.captured.reads.includes('lots')&&f.captured.reads.includes('lot_reservations'))
})
test('partial, duplicate, stale or unconfigured sale ownership cannot reach signing publication',async()=>{
 const changes=[f=>f.tables.lots[0].house_plan_elevation_id=id(99),f=>f.tables.lot_reservations[0].status='released',f=>f.tables.lot_reservations[0].lot_id=id(99),f=>f.tables.lot_reservations.push({...f.tables.lot_reservations[0],id:id(99),lot_id:id(99),status:'released'}),f=>f.tables.lots[0].status='closed',f=>f.tables.lot_reservations=[],f=>f.tables.lot_reservations.push({...f.tables.lot_reservations[0],id:id(20)}),f=>f.tables.lots[0].swing='right',f=>f.tables.lots[0].project_id=id(99),f=>f.tables.contracts[0].status='active',f=>f.tables.contracts[0].snapshot={},f=>f.tables.contracts[0].project_id=id(99)]
 for(const alter of changes){const f=service();alter(f);await assert.rejects(f.run());assert.equal(f.captured.publishes.length,0);assert.equal(f.captured.reserves.length,0)}
 for(const options of [{flag:false},{denied:true},{homeDenied:true},{failedTable:'lots'},{failedTable:'lot_reservations'},{race:true}]){const f=service(options);await assert.rejects(f.run());assert.equal(f.captured.publishes.length,0);assert.equal(f.captured.reserves.length,0)}
})

test('a saved non-null elevation uses the real lot column when resuming',async()=>{
 const f=service()
 f.tables.contracts[0].snapshot.purchase_agreement.configuration.elevation_id=id(40)
 f.tables.lots[0].house_plan_elevation_id=id(40)
 assert.equal((await f.run()).documentId,id(8))
 assert.equal(f.captured.publishes.length,1)
})
