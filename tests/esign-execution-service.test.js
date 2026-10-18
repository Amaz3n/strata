const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), Module = require('node:module')
const { PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const { PDFDocument } = require('pdf-lib')
require('../scripts/register-ts-node-test')
let client, objects = new Map(), uploadFault = false, uploads = 0, invitationAttempts = []
const realLoad = Module._load
Module._load = function(request, parent, main) {
  if (request === '@/lib/supabase/server') return { createServiceSupabaseClient: () => client }
  if (request === '@/lib/storage/files-storage') return {
    getFilesStorageProvider: () => 'r2', buildOrgScopedPath: (...parts) => parts.join('/'),
    downloadFilesObject: async ({ path }) => { const bytes = objects.get(path); if (!bytes) throw new Error('Missing fixture object'); return bytes },
    uploadFilesObject: async ({ path, bytes }) => { if (uploadFault) { uploadFault = false; throw new Error('injected object-store failure') } uploads++; assert.equal(objects.has(path), false); objects.set(path, new Uint8Array(bytes)) },
  }
  if (request === '@/lib/services/signature-delivery') return { deliverSigningInvitation: async input => { invitationAttempts.push(input.requestId) } }
  if (request === '@/lib/services/estimate-portal') return { submitEstimateBuilderSignatureBySigningToken: () => { throw new Error('Native estimate not part of this fixture') } }
  if (request === 'next/cache') return { revalidatePath() {} }
  if (request === 'next/headers') return { headers: async () => new Headers(), cookies: async () => ({ get() { return undefined } }) }
  return realLoad.call(this, request, parent, main)
}
const { finalizeDocumentSigning, ensureFrozenSigningSource, signingDigest } = require('../lib/services/esign-execution')
const { submitDocumentSignatureAction } = require('../app/d/[token]/actions')
const { hashSigningToken } = require('../lib/esign/signing-tokens')
const { ELECTRONIC_SIGNATURE_CONSENT_TEXT } = require('../lib/esign/consent')
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const org=id(1), doc=id(2), env=id(3), request=id(4), field=id(5), sourceFile=id(6)

// Real SQL and PDF engines; only the Supabase transport and object store are
// replaced. Errors use the same {data,error} shape as production boundaries.
function sqlClient(db) {
  const clean = value => JSON.parse(JSON.stringify(value))
  return {
    rpc: async (name, params) => {
      try { const keys=Object.keys(params); const result=await db.query(`select public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')}) data`,Object.values(params)); return { data:clean(result.rows[0].data),error:null } }
      catch(error) { return {data:null,error:{message:error.message}} }
    },
    from(table) {
      let select='*', update=null, filters=[], order='', single=false, optional=false
      const q={
        select(columns) { select=columns;return q }, update(values) {update=values;return q},
        eq(column,value){filters.push([column,'=',value]);return q}, neq(column,value){filters.push([column,'<>',value]);return q},
        lt(column,value){filters.push([column,'<',value]);return q},
        in(column,value){filters.push([column,'in',value]);return q}, order(column,options={}){order=` order by ${column} ${options.ascending===false?'desc':'asc'}`;return q},
        single(){single=true;return q}, maybeSingle(){single=true;optional=true;return q},
        then(resolve,reject){return (async()=>{
          try {
            const args=[]; const bind=v=>{args.push(v);return `$${args.length}`}
            let prefix=update?`update public.${table} set ${Object.entries(update).map(([k,v])=>`${k}=${bind(v)}`).join(',')}`:`select ${select} from public.${table}`
            const where=filters.map(([col,op,value])=>op==='in'?(value.length?`${col} in (${value.map(bind).join(',')})`:'false'):`${col}${op}${bind(value)}`).join(' and ')
            const result=await db.query(prefix+(where?` where ${where}`:'')+(update?' returning *':order),args)
            // PostgREST JSON numeric columns arrive as numbers; PGlite retains decimal strings.
            if(table==='document_fields')for(const row of result.rows)for(const key of ['x','y','w','h'])if(row[key]!=null)row[key]=Number(row[key])
            if(single&&result.rows.length!==1&&!(optional&&result.rows.length===0))return {data:null,error:{message:'Expected one fixture row'}}
            return {data:clean(single?result.rows[0]??null:result.rows),error:null}
          }catch(error){return {data:null,error:{message:error.message}}}
        })().then(resolve,reject)},
      };return q
    },
  }
}

test('durable execution uses real SQL and PDFs across storage failures, retries and revocation',async t=>{
  const oldSecret=process.env.DOCUMENT_SIGNING_SECRET
  process.env.DOCUMENT_SIGNING_SECRET='local-fixture-only-not-a-production-secret'
  t.after(()=>{ if(oldSecret===undefined)delete process.env.DOCUMENT_SIGNING_SECRET;else process.env.DOCUMENT_SIGNING_SECRET=oldSecret })
  const db=new PGlite();t.after(()=>db.close());client=sqlClient(db)
  await db.exec(fs.readFileSync('tests/fixtures/esign-schema.sql','utf8'))
  await db.exec(fs.readFileSync('supabase/migrations/20261003004822_esign_durable_execution_and_evidence.sql','utf8'))
  const row=async(sql,args=[])=>(await db.query(sql,args)).rows[0]
  const reset=async({accept=true,legacy=false,freeze=true}={})=>{
    await db.exec('truncate public.orgs,public.documents,public.envelopes,public.document_fields,public.document_signing_requests,public.document_signatures,public.events,public.outbox,public.files,public.doc_versions,public.envelope_recipients,public.esign_executions cascade')
    objects=new Map();uploads=0;uploadFault=false;invitationAttempts=[]
    const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save();objects.set('fixture/source.pdf',bytes)
    const frozen={file_id:sourceFile,storage_path:'fixture/source.pdf',sha256:signingDigest(bytes),size_bytes:bytes.length}
    await db.query('insert into public.orgs(id) values($1)',[org])
    await db.query("insert into public.files(id,org_id,file_name,storage_path) values($1,$2,'source.pdf','fixture/source.pdf')",[sourceFile,org])
    await db.query("insert into public.documents(id,org_id,title,source_file_id,metadata) values($1,$2,'Fixture agreement',$3,$4)",[doc,org,sourceFile,JSON.stringify(freeze?{esign_source:frozen}:{})])
    await db.query('insert into public.envelopes(id,org_id,document_id) values($1,$2,$3)',[env,org,doc])
    await db.query("insert into public.document_fields(id,org_id,document_id,page_index,field_type,signer_role,x,y,w,h) values($1,$2,$3,0,'name','owner',.1,.1,.5,.1)",[field,org,doc])
    await db.query("insert into public.document_signing_requests(id,org_id,document_id,revision,token_hash,envelope_id,group_id,signer_role,sent_to_email) values($1,$2,$3,1,$4,$5,$6,'owner','owner@example.test')",[request,org,doc,hashSigningToken('fixture-token'),legacy?null:env,env])
    await db.query("insert into public.envelope_recipients(org_id,envelope_id,email,name) values($1,$2,'owner@example.test','Owner')",[org,env])
    await db.exec("update public.documents set status='sent';update public.envelopes set status='sent'")
    if(accept) await db.query('select public.record_document_signature_atomic($1,$2,$3,1,$4,$5,null,null,$6,$7,$8,now())',[org,request,doc,'José 张伟','owner@example.test','Fixture disclosure',JSON.stringify({[field]:'José 张伟'}),JSON.stringify({consent_version:'fixture'})])
    return frozen
  }

  await t.test('storage failure releases its lease and a retry publishes exactly one artifact and receipt job',async()=>{
    await reset();uploadFault=true
    await assert.rejects(finalizeDocumentSigning(org,request),/object-store failure/)
    assert.equal((await row('select status from public.esign_executions')).status,'pending')
    assert.equal((await row('select status from public.document_signing_requests')).status,'signed')
    await finalizeDocumentSigning(org,request)
    const completed=await row('select executed_file_id from public.documents')
    assert.ok(completed.executed_file_id)
    assert.equal((await row('select count(*)::int n from public.files')).n,2)
    assert.equal((await row("select count(*)::int n from public.outbox where job_type='send_esign_executed_email'")).n,1)
    const count=uploads;await finalizeDocumentSigning(org,request);assert.equal(uploads,count)
    assert.equal((await row('select executed_file_id from public.documents')).executed_file_id,completed.executed_file_id)
  })

  await t.test('publication failure rolls back database effects after upload and retries using stable file identity',async()=>{
    await reset();const execution=await row('select file_id from public.esign_executions')
    await db.exec("create function public.test_execution_failure() returns trigger language plpgsql as $$begin if new.job_type='process_esign_execution_side_effects' then raise exception 'injected publication failure';end if;return new;end$$;create trigger test_fail_publish before insert on public.outbox for each row execute function public.test_execution_failure()")
    try{await assert.rejects(finalizeDocumentSigning(org,request),/publication failure/)}finally{await db.exec('drop trigger test_fail_publish on public.outbox;drop function public.test_execution_failure()')}
    assert.equal((await row('select executed_file_id from public.documents')).executed_file_id,null)
    assert.equal((await row('select count(*)::int n from public.files')).n,1)
    await finalizeDocumentSigning(org,request)
    assert.equal((await row('select executed_file_id from public.documents')).executed_file_id,execution.file_id)
    assert.equal((await row('select count(*)::int n from public.doc_versions')).n,1)
  })

  await t.test('legacy group requests finalize and repeated acceptance returns its existing receipt without revalidating a replacement payload',async()=>{
    await reset({legacy:true});await finalizeDocumentSigning(org,request)
    const result=await submitDocumentSignatureAction({token:'fixture-token',signerName:'',signerEmail:'',consentText:'',values:{unexpected:'not a second signature'}})
    assert.equal(result.success,true);assert.match(result.executedDocumentUrl,/\/api\/esign\/executed\//)
    assert.equal((await row('select count(*)::int n from public.document_signatures')).n,1)
  })

  await t.test('revocation prevents publication and retry receipts do not reopen a cancelled document',async()=>{
    await reset();await db.query("select public.cancel_esign_envelope($1,$2,'Cancelled',null,null)",[org,env])
    await finalizeDocumentSigning(org,request)
    assert.equal((await row('select executed_file_id from public.documents')).executed_file_id,null)
    await assert.rejects(submitDocumentSignatureAction({token:'fixture-token',signerName:'',consentText:'',values:{}}),/no longer valid/)
  })

  await t.test('frozen object drift fails closed without consuming the retry or publishing replacement bytes',async()=>{
    await reset();objects.set('fixture/source.pdf',new Uint8Array([1,2,3]))
    await assert.rejects(finalizeDocumentSigning(org,request),/integrity check/)
    assert.equal((await row('select status from public.esign_executions')).status,'pending')
    assert.equal((await row('select executed_file_id from public.documents')).executed_file_id,null)
  })

  await t.test('legacy preview freezes once; already accepted legacy evidence cannot be retroactively bound to changed bytes',async()=>{
    await reset({accept:false,freeze:false})
    const first=await ensureFrozenSigningSource(org,doc);const next=await ensureFrozenSigningSource(org,doc)
    assert.equal(first.storage_path,next.storage_path);assert.equal(uploads,1)
    await reset({freeze:false})
    await assert.rejects(ensureFrozenSigningSource(org,doc),/new revision/)
    assert.equal((await row('select metadata from public.documents')).metadata.esign_source,undefined)
  })

  await t.test('real submission rejects foreign fields before acceptance and publishes a valid recipient submission',async()=>{
    await reset({accept:false})
    const input={token:'fixture-token',signerName:'José 张伟',signerEmail:'owner@example.test',consentText:ELECTRONIC_SIGNATURE_CONSENT_TEXT,values:{[field]:'José 张伟'}}
    await assert.rejects(submitDocumentSignatureAction({...input,values:{...input.values,[id(999)]:'Another signer'}}),/not assigned/)
    assert.equal((await row('select count(*)::int n from public.document_signatures')).n,0)
    const result=await submitDocumentSignatureAction(input)
    assert.equal(result.success,true)
    assert.match(result.executedDocumentUrl,/\/api\/esign\/executed\//)
    assert.equal((await row('select status from public.envelopes')).status,'executed')
    assert.equal((await row('select count(*)::int n from public.document_signatures')).n,1)
  })
})
