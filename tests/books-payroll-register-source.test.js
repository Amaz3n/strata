require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{createHash}=require('node:crypto')
const {payrollRegisterFields,payrollRunFromCsv}=require('../lib/services/books/payroll-register-csv')
const id=n=>'99500000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1)
const mapping={columns:Object.fromEntries(payrollRegisterFields.map(field=>[field,field])),amount_unit:'dollars',employee_row_value:'employee',control_row_value:'control'}
const workers=[{employee_reference:'W-1',worker_id:id(2),allocations:[{id:id(3),project_id:id(4),cost_code_id:id(5),cost_account_code:'5030',gross_cents:24000,employer_taxes_cents:2500,employer_benefits_cents:500,labor_evidence_ids:[]}]}]
const metadata=['Provider','RUN-1','2026-09-01','2026-09-15','2026-09-15','2026-09-18']
const makeRows=()=>[['employee',...metadata,'W-1','240.00','180.00','50.00','10.00','25.00','5.00',''],['control',...metadata,'','240.00','180.00','50.00','10.00','25.00','5.00','270.00']]
const csv=(rows=makeRows(),headers=payrollRegisterFields)=>[headers,...rows].map(row=>row.map(cell=>/[",\r\n]/.test(cell)?'"'+cell.replace(/"/g,'""')+'"':cell).join(',')).join('\r\n')+'\r\n'
const parse=(text=csv(),options={})=>payrollRunFromCsv({text,orgId:org,runId:id(6),checksum:'a'.repeat(64),mapping,workers,...options})
test('financial amounts and dates derive from source rows; exact dollars and independent funding totals remain intact',()=>{
 const run=parse('\uFEFF'+csv());assert.equal(run.employees[0].gross_cents,24000);assert.equal(run.controls.funding_cents,27000)
 assert.equal(run.provider_run_id,'RUN-1');assert.equal(run.org_id,org)
 const rows=makeRows();rows[0][8]='0.29';rows[1][8]='0.29';assert.equal(parse(csv(rows)).employees[0].gross_cents,29)
 rows[0][8]='90071992547409.91';rows[1][8]='90071992547409.91';assert.equal(parse(csv(rows)).controls.gross_cents,Number.MAX_SAFE_INTEGER)
 rows[0][8]='90071992547409.92';assert.throws(()=>parse(csv(rows)),/safe/)
})
test('column mapping supports provider names, quoted values and declared cents without losing fields',()=>{
 const headers=payrollRegisterFields.map(field=>'Provider '+field),custom={...mapping,amount_unit:'cents',columns:Object.fromEntries(payrollRegisterFields.map((field,i)=>[field,headers[i]]))}
 const rows=makeRows();for(const row of rows){row[1]='Provider, "quoted"';for(let i=8;i<15;i++)if(row[i])row[i]=String(Number(row[i])*100)}
 const run=parse(csv(rows,headers),{mapping:custom});assert.equal(run.provider,'Provider, "quoted"');assert.equal(run.controls.funding_cents,27000)
})
test('malformed widths, quotes, headers, mapping reuse and unsupported rows or columns never truncate payroll',()=>{
 for(const text of [csv(makeRows(),[...payrollRegisterFields,'fee']),csv().replace('employee,','employee,EXTRA,'),csv().replace('employee,','employee"bad,'),csv().replace('employee,','"employee,'),csv(makeRows(),[...payrollRegisterFields.slice(0,-1),'gross'])])assert.throws(()=>parse(text))
 const rows=makeRows();rows.push([...rows[0]]);rows[2][0]='fee';assert.throws(()=>parse(csv(rows)),/unsupported/)
 assert.throws(()=>parse(csv(),{mapping:{...mapping,columns:{...mapping.columns,net:'gross'}}}),/reuses/)
})
test('employee/control ownership, run dates and exact decimal formats cannot be invented from mappings',()=>{
 for(const value of ['1e2','-1','(1)','1,000.00','1.001','+1','0x10','9'.repeat(100)]){const rows=makeRows();rows[0][8]=value;assert.throws(()=>parse(csv(rows)))}
 for(const mutate of [rows=>rows.push([...rows[0]]),rows=>rows.push([...rows[1]]),rows=>rows[1][2]='DIFFERENT',rows=>rows[0][7]='unknown',rows=>rows[1][7]='W-1',rows=>rows[0][14]='240.00']){const rows=makeRows();mutate(rows);assert.throws(()=>parse(csv(rows)))}
 assert.throws(()=>parse(csv(),{workers:[...workers,{...workers[0],employee_reference:'W-2',worker_id:id(99)}]}),/every worker/)
})
const bytes=Buffer.from(csv()),checksum=createHash('sha256').update(bytes).digest('hex')
const version={id:id(7),org_id:org,file_id:id(8),storage_path:org+'/payroll/original.csv',file_name:'Original.csv',mime_type:'text/csv',size_bytes:bytes.length,checksum}
const chart=[['2200','liability','payroll_clearing'],['2230','liability','other_liability'],['5030','cogs','direct_labor']].map(([code,account_type,subtype],i)=>({id:id(30+i),org_id:org,code,account_type,subtype,active:true}))
const makeSnapshot=()=>({orgId:org,capturedAt:'2026-09-15T12:00:00Z',databaseSnapshot:'100:101:',tables:{files:[{id:id(8),org_id:org,current_version_id:id(9),storage_path:org+'/payroll/REPLACED.csv'}],doc_versions:[{...version}],projects:[{id:id(4),org_id:org}],cost_codes:[{id:id(5),org_id:org}],time_entries:[],job_cost_entries:[],accounting_facts:[],journal_entries:[],journal_lines:[],books_projection_receipts:[],gl_accounts:chart}})
let snapshot=makeSnapshot(),sourceBytes=bytes,calls=[],denied=false,members=[{user_id:id(2),org_id:org}],cancelled=0,preview
const service={rpc:async(name,args)=>{calls.push(['capture',name,args]);return {data:snapshot,error:null}},from(table){calls.push(['table',table]);const query={select(){return query},eq(key,value){calls.push([key,value]);return query},in(key,value){calls.push([key,value]);return query},limit:async()=>({data:members,error:null})};return query}}
const original=Module._load
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(50),supabase:{}})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async input=>{calls.push(['object',input.path]);return {body:new ReadableStream({start(controller){controller.enqueue(sourceBytes.subarray(0,10));controller.enqueue(sourceBytes.subarray(10));controller.close()},cancel(){cancelled++}})}}}
 return original.call(this,name,...args)
};preview=require('../lib/services/books/payroll-register-source').previewPayrollRegisterFile}finally{Module._load=original}
const args=()=>({runId:id(6),fileId:id(8),documentVersionId:id(7),mapping,workers})
test('actual source preview authorizes, verifies retained original bytes and derives provider controls before labor reconciliation',async()=>{
 calls=[];const result=await preview(args());assert.equal(result.providerSourceVerified,true);assert.equal(result.previewOnly,true)
 assert.equal(result.sourceProof.document_version_id,id(7));assert.equal(result.run.source_checksum,checksum)
 assert.equal(result.run.controls.gross_cents,24000);assert.equal(result.costVarianceCents,27000)
 assert.equal(result.constructionImpact.projectCostDeltaCents,27000)
 assert.ok(result.constructionImpact.allocations[0].blockers.includes('new_project_cost_requires_budget_and_gmp_allocation'))
 assert.equal(result.liabilityHistory.unpaidStatusProven,false)
 assert.deepEqual(calls[0],['authorize','books.adjust']);assert.equal(calls.filter(row=>row[0]==='capture').length,1)
 assert.ok(calls.some(row=>row[0]==='object'&&row[1]===version.storage_path));assert.ok(!calls.some(row=>row[1]===org+'/payroll/REPLACED.csv'))
})
test('authorization, source scope, worker/project mapping and unsupported amounts reject before a valid preview',async()=>{
 denied=true;calls=[];await assert.rejects(preview(args()),/Denied/);assert.equal(calls.length,1);denied=false
 for(const mutate of [s=>s.orgId=id(99),s=>s.tables.doc_versions[0].org_id=id(99),s=>s.tables.doc_versions[0].file_id=id(99),s=>s.tables.projects=[],s=>s.tables.doc_versions[0].size_bytes=17*1024*1024]){
  snapshot=makeSnapshot();mutate(snapshot);calls=[];await assert.rejects(preview(args()));assert.ok(!calls.some(row=>row[0]==='object'))
 }
 snapshot=makeSnapshot();members=[];await assert.rejects(preview(args()),/worker mapping/);members=[{user_id:id(2),org_id:org}]
 for(const content of [Buffer.from('x'.repeat(bytes.length)),bytes.subarray(1),Buffer.concat([bytes,Buffer.from('EXTRA')])]){sourceBytes=content;await assert.rejects(preview(args()),/bytes|size/)}
 sourceBytes=bytes
 const rows=makeRows();rows[1][8]='241.00';sourceBytes=Buffer.from(csv(rows));snapshot.tables.doc_versions[0].size_bytes=sourceBytes.length;snapshot.tables.doc_versions[0].checksum=createHash('sha256').update(sourceBytes).digest('hex')
 await assert.rejects(preview(args()),/control total/)
 sourceBytes=bytes;snapshot=makeSnapshot()
 await assert.rejects(preview({...args(),source_checksum:'0'.repeat(64)}),/Unrecognized/)
})

test('invalid UTF-8 rejects even when source identity was captured',async()=>{
 sourceBytes=Buffer.from([0xff,0xfe,0xfd]);snapshot=makeSnapshot()
 snapshot.tables.doc_versions[0].size_bytes=sourceBytes.length;snapshot.tables.doc_versions[0].checksum=createHash('sha256').update(sourceBytes).digest('hex')
 await assert.rejects(preview(args()),/encoded data|encoding|UTF/i)
 sourceBytes=bytes;snapshot=makeSnapshot()
})
test('verified provider source does not hide prior native withholding movements or claim unpaid wages',async()=>{
 snapshot=makeSnapshot()
 snapshot.tables.journal_entries=[{id:id(70),org_id:org,source_type:'payroll_settlement',source_id:null,entry_date:'2026-09-18',status:'posted'}]
 snapshot.tables.journal_lines=[{id:id(71),org_id:org,entry_id:id(70),account_id:id(30),project_id:null,debit_cents:6000,credit_cents:0,dimensions:{payment_reference:'Prior withholding'}},
  {id:id(72),org_id:org,entry_id:id(70),account_id:id(31),project_id:null,debit_cents:0,credit_cents:6000,dimensions:{}}]
 try{
  const result=await preview(args())
  assert.equal(result.providerSourceVerified,true);assert.equal(result.liabilityHistory.requiresSettlementAttribution,true)
  assert.equal(result.liabilityHistory.organizationWagesMovementCents,-6000);assert.equal(result.liabilityHistory.unpaidStatusProven,false)
 }finally{snapshot=makeSnapshot()}
})
