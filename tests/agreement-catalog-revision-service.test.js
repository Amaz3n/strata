const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
function service(value,error=null){
 const calls=[],compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/agreement-catalog-revision.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require:()=>({})})
 const q={select(v){calls.push(['select',v]);return q},eq(k,v){calls.push(['eq',k,v]);return q},maybeSingle:async()=>({data:value===undefined?null:{revision:value},error})}
 const context={orgId:'org',supabase:{from(table){calls.push(['from',table]);return q}}}
 return {run:()=>compiled.exports.readAgreementCatalogRevision(context),calls}
}
test('catalog revision reads are tenant scoped and preserve exact PostgreSQL bigint evidence',async()=>{
 for(const value of [1,'1','9007199254740993','9223372036854775807']){
  const f=service(value);assert.equal(await f.run(),String(value));assert.deepEqual(f.calls,[['from','agreement_catalog_revisions'],['select','revision'],['eq','org_id','org']])
 }
})
test('missing, failed, unsafe-number, malformed and out-of-range revision reads fail closed',async()=>{
 for(const value of [undefined,null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'01','1.5','9223372036854775808','not-a-revision'])await assert.rejects(service(value).run())
 await assert.rejects(service(1,{message:'read failed'}).run(),/could not be verified/)
})
