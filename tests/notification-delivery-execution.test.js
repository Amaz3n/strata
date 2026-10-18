require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {stubModule,ORG,ACTOR,PACKAGE,PROJECT}=require('./support/starts-harness')
const {FEATURE_FLAGS}=require('../lib/feature-flags/registry')
const {notificationDeliveryContext,authorizeNotificationDelivery}=require('../lib/services/notification-delivery-authorization')
const NOTE='00000000-0000-4000-8000-000000000011',DEVICE='00000000-0000-4000-8000-000000000012'
function harness({receipted=true,configured=true}={}){
 const source={id:NOTE,org_id:ORG,user_id:ACTOR,notification_type:'start_released',payload:{title:'House released',message:'Work may start',project_id:PROJECT},created_at:'2026-10-03T00:00:00Z'}
 const db=createFakeSupabase({notifications:[source],feature_flags:[{org_id:ORG,flag_key:FEATURE_FLAGS.notificationDeliveryReceipts,enabled:true}],device_tokens:[{id:DEVICE,user_id:ACTOR,token:'device-token'}],user_notification_prefs:[],app_users:[{id:ACTOR,email:'site@example.com',full_name:'Site manager'}],orgs:[{id:ORG,name:'Builder',slug:'builder'}]})
 const sends=[];let checks=0,result={ok:true,status:200,unregistered:false}
 db.rpc=async(name,args)=>{assert.equal(name,'authorize_start_notification_delivery');assert.equal(args.p_org_id,ORG);checks++;return {data:source,error:null}}
 stubModule('@/lib/services/apns',{isApnsConfigured:()=>configured,sendApnsNotification:async input=>{sends.push(input);return result}})
 delete require.cache[require.resolve('../lib/services/notification-push-delivery')]
 const service=require('../lib/services/notification-push-delivery')
 const job={id:'9007199254740993',org_id:ORG,job_type:'deliver_push',payload:{notificationId:NOTE,...(receipted?{deliveryReceiptId:PACKAGE}:{})}}
 return {db,source,job,sends,service,setResult:value=>{result=value},checks:()=>checks}
}
test('receipted push reauthorizes before each provider call and uses a stable collapse identity',async()=>{
 const h=harness();await h.service.deliverNotificationPush(h.db,h.job)
 assert.equal(h.checks(),2);assert.equal(h.sends.length,1);assert.equal(h.sends[0].collapseId,`notification-${NOTE}`)
 assert.equal(h.sends[0].body,h.source.payload.message)
})
test('revocation and changed source before send make zero provider calls',async()=>{
 for(const changed of [false,true]){
  const h=harness();let checks=0
  h.db.rpc=async()=>{checks++;return checks===1?{data:h.source,error:null}:changed?{data:{...h.source,payload:{title:'Changed source'}},error:null}:{data:null,error:{message:'Recipient revoked'}}}
  await assert.rejects(h.service.deliverNotificationPush(h.db,h.job),/changed before provider|Recipient revoked/)
  assert.equal(h.sends.length,0)
 }
})
test('APNs rejection is surfaced for queue retry; invalid devices are removed with checked writes',async()=>{
 const h=harness();h.setResult({ok:false,status:503,unregistered:false,reason:'ServiceUnavailable'})
 await assert.rejects(h.service.deliverNotificationPush(h.db,h.job),/APNs rejected/)
 h.setResult({ok:false,status:410,unregistered:true,reason:'Unregistered'})
 await h.service.deliverNotificationPush(h.db,h.job);assert.equal(h.db.store.device_tokens.length,0)
})
test('disabled receipt controls, unavailable APNs and device-read failures cannot complete delivery silently',async()=>{
 const h=harness();h.db.store.feature_flags[0].enabled=false
 await assert.rejects(h.service.deliverNotificationPush(h.db,h.job),/Restore non-expiring/);assert.equal(h.sends.length,0)
 const paused=harness({configured:false});await assert.rejects(paused.service.deliverNotificationPush(paused.db,paused.job),/APNs unavailable/)
 const unavailable=harness(),from=unavailable.db.from.bind(unavailable.db)
 unavailable.db.from=table=>{const q=from(table);if(table==='device_tokens')q.run=()=>({data:null,error:{message:'Devices unavailable'}});return q}
 await assert.rejects(unavailable.service.deliverNotificationPush(unavailable.db,unavailable.job),/Devices unavailable/)
 assert.equal(unavailable.sends.length,0)
})
test('malformed receipt context never downgrades to legacy; unreceipted jobs keep scoped delivery',async()=>{
 const h=harness()
 assert.throws(()=>notificationDeliveryContext({...h.job,payload:{...h.job.payload,deliveryReceiptId:null}}))
 const legacy=harness({receipted:false});await legacy.service.deliverNotificationPush(legacy.db,legacy.job)
 assert.equal(legacy.checks(),0);assert.equal(legacy.sends.length,1)
 await assert.rejects(legacy.service.deliverNotificationPush(legacy.db,{...legacy.job,org_id:PROJECT}),/missing source/)
})
test('authorization adapter rejects a foreign notification result',async()=>{
 const h=harness();h.db.rpc=async()=>({data:{...h.source,org_id:PROJECT},error:null})
 await assert.rejects(authorizeNotificationDelivery(h.db,notificationDeliveryContext(h.job)),/differs from this delivery/)
})
test('email sender rechecks after rendering before invoking the provider',async()=>{
 const h=harness();let sent=0
 // Exercise the authorized sender branch independently of the production
 // allowlist: start_released currently remains in-app/push by default.
 stubModule('@/lib/types/notifications',{EMAIL_NOTIFICATION_TYPES:[{key:'start_released'}]})
 stubModule('@/lib/services/mailer',{escapeHtml:value=>value,getOrgSenderEmail:()=>undefined,renderEmailTemplate:async()=>'',renderStandardEmailLayout:()=>{h.source.payload.message='Changed while rendering';return '<p>House released</p>'},sendEmail:async()=>{sent++;return true}})
 stubModule('@/lib/services/books/reconciliation',{loadReconciliationDigest:async()=>null})
 delete require.cache[require.resolve('../lib/services/notification-email-delivery')]
 const {deliverNotificationEmail}=require('../lib/services/notification-email-delivery')
 const context=notificationDeliveryContext({...h.job,job_type:'deliver_notification'})
  await assert.rejects(deliverNotificationEmail(NOTE,ORG,h.db,context),/changed before provider/)
  assert.equal(sent,0)
  await assert.rejects(deliverNotificationEmail(NOTE,PROJECT,h.db),/Notification not found/)
})
test('APNs sender emits a bounded collapse header without making a network call',async t=>{
 const http2=require('node:http2'),crypto=require('node:crypto'),{EventEmitter}=require('node:events')
 const original=http2.connect,fields=['APNS_KEY_ID','APNS_TEAM_ID','APNS_AUTH_KEY','APNS_BUNDLE_ID','APNS_ENVIRONMENT'],previous=Object.fromEntries(fields.map(field=>[field,process.env[field]]))
 const filename=require.resolve('../lib/services/apns'),cached=require.cache[filename];let headers
 t.after(()=>{http2.connect=original;for(const field of fields){if(previous[field]===undefined)delete process.env[field];else process.env[field]=previous[field]}require.cache[filename]=cached})
 const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'})
 Object.assign(process.env,{APNS_KEY_ID:'test-key',APNS_TEAM_ID:'test-team',APNS_AUTH_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}),APNS_BUNDLE_ID:'test.arc',APNS_ENVIRONMENT:'sandbox'})
 http2.connect=()=>{const client=new EventEmitter();client.close=()=>{};client.request=value=>{headers=value;const req=new EventEmitter();req.setEncoding=()=>{};req.write=()=>{};req.end=()=>{req.emit('response',{':status':200});req.emit('end')};return req};return client}
 delete require.cache[filename]
 const {sendApnsNotification}=require('../lib/services/apns')
 assert.equal((await sendApnsNotification({deviceToken:'test-device',title:'Start',body:'Released',collapseId:`notification-${NOTE}`})).ok,true)
 assert.equal(headers['apns-collapse-id'],`notification-${NOTE}`)
 await assert.rejects(sendApnsNotification({deviceToken:'test-device',title:'Start',body:'Released',collapseId:'😀'.repeat(17)}),/Invalid APNs collapse/)
})
