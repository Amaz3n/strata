const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
test('reminder planning keyset-pages beyond 250 envelopes and queues durable work',async()=>{
 const source=fs.readFileSync('app/api/jobs/esign/route.ts','utf8'),start=source.indexOf('function getReminderSettings'),end=source.indexOf('async function handler',start)
 const envelopes=Array.from({length:251},(_,i)=>({id:String(i).padStart(4,'0'),org_id:'org',metadata:{reminder_settings:{enabled:true,interval_days:1}}})),queued=[],filters=[]
 let pageReads=0
 const db={from(table){let cursor='',envelope;const q={select(){return q},in(){return q},eq(k,v){filters.push([table,k,v]);if(k==='envelope_id')envelope=v;return q},order(){return q},limit(){return q},gt(k,v){cursor=v;return q},maybeSingle(){return q},then(resolve){let data;if(table==='envelopes'){pageReads++;data=envelopes.filter(e=>e.id>cursor).slice(0,250)}else if(table==='document_signing_requests')data=[{id:'request-'+envelope,sequence:1,required:true,sent_to_email:'signer@example.test',sent_at:'2020-01-01T00:00:00Z'}];else data=null;return Promise.resolve({data,error:null}).then(resolve)}};return q}}
 const exports={};vm.runInNewContext(ts.transpileModule(source.slice(start,end)+'\nexports.run=sendAutomaticReminders',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Error,Math,Number,enqueueOutboxJob:async input=>{queued.push(input);return {enqueued:true}}})
 const result=await exports.run(db)
 assert.equal(pageReads,2);assert.equal(queued.length,251);assert.equal(result.queued,251)
 assert.ok(filters.some(([,key,value])=>key==='metadata->reminder_settings->>enabled'&&value==='true'))
 assert.ok(queued.every(job=>job.jobType==='send_esign_reminder'&&job.dedupeByPayloadKeys[0]==='delivery_key'))
})
