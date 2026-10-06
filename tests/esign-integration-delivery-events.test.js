const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
function deliveryService(){const calls=[],exports={},db={rpc:async(name,args)=>{calls.push({name,args});return {error:null}}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/esign-delivery-events.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>n==='@/lib/supabase/server'?{createServiceSupabaseClient:()=>db}:{},Date,Error,Number});return {...exports,calls}}
test('delivery events retain provider/event keys and timestamp for deduplicated ordered reconciliation',async()=>{
 const h=deliveryService();await h.processSigningDeliveryWebhook({eventId:'svix-1',type:'email.bounced',createdAt:'2026-01-01T12:00:00Z',data:{email_id:'provider-1',bounce:{message:'private vendor details'}}})
 const args=h.calls[0].args;assert.equal(args.p_event_id,'svix-1');assert.equal(args.p_provider_id,'provider-1');assert.equal(args.p_status,'bounced');assert.equal(args.p_occurred_at,'2026-01-01T12:00:00.000Z');assert.ok(!args.p_error.includes('private'))
 assert.equal(await h.processSigningDeliveryWebhook({eventId:'other',type:'email.opened'}),false)
 await assert.rejects(h.processSigningDeliveryWebhook({eventId:'missing-date',type:'email.delivered',data:{email_id:'provider'}}),/timestamp/)
})
test('provider acceptance is not reported successful until its identifier is durably captured',async()=>{
 const source=fs.readFileSync('lib/services/mailer.ts','utf8'),start=source.indexOf('export async function sendEmail('),end=source.indexOf('\nfunction stripHtml',start),exports={}
 vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,RESEND_API_KEY:'test-only',RESEND_FROM_EMAIL:'test@example.test',isPlaceholderEmail:()=>false,stripHtml:x=>x,fetch:async()=>({ok:true,json:async()=>({id:'provider-1'})}),console:{error(){},warn(){}},Set,Error})
 const payload={to:['signer@example.test'],subject:'Signing',html:'Body'};let captured
 assert.equal(await exports.sendEmail({...payload,onAccepted:async id=>{captured=id}}),true);assert.equal(captured,'provider-1')
 assert.equal(await exports.sendEmail({...payload,onAccepted:async()=>{throw Error('db unavailable')}}),false)
})
