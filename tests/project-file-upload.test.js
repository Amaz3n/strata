require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { persistProjectUpload, uploadRequestFingerprint, UploadRecordInsertError } = require('../lib/services/project-file-upload')

function options(overrides={}) {
  return { retrySafe:true,storagePath:'attempt',findExisting:async()=>null,
    validateExisting:()=>{},uploadObject:async()=>{},insertRecord:async()=>({storage_path:'attempt'}),cleanupObject:async()=>{},...overrides }
}

test('a completed retry returns existing metadata without another upload or insert', async()=>{
  const saved = {storage_path:'winner',id:'stable'}
  const result = await persistProjectUpload(options({findExisting:async()=>saved,
    uploadObject:async()=>assert.fail('re-uploaded'),insertRecord:async()=>assert.fail('reinserted')}))
  assert.equal(result.record,saved)
  assert.equal(result.created,false)
})

test('a lost insert response recovers its committed row without deleting its object', async()=>{
  let saved = null
  const result = await persistProjectUpload(options({findExisting:async()=>saved,
    insertRecord:async()=>{saved={storage_path:'attempt'};throw new UploadRecordInsertError('response lost')},
    cleanupObject:async()=>assert.fail('deleted winning storage')}))
  assert.equal(result.record,saved)
  assert.equal(result.created,true)
})

test('a concurrent losing attempt cleans only its unique storage object', async()=>{
  let saved = null,cleaned=0
  const result = await persistProjectUpload(options({findExisting:async()=>saved,
    insertRecord:async()=>{saved={storage_path:'different-winner'};throw new UploadRecordInsertError('duplicate','23505')},
    cleanupObject:async()=>{cleaned++}}))
  assert.equal(result.record.storage_path,'different-winner')
  assert.equal(result.created,false)
  assert.equal(cleaned,1)
})

test('an ambiguous failure with no visible row preserves storage for a delayed commit', async()=>{
  await assert.rejects(persistProjectUpload(options({insertRecord:async()=>{throw new UploadRecordInsertError('network')},
    cleanupObject:async()=>assert.fail('deleted potentially committed storage')})),/network/)
})

test('a definitive database rejection cleans the orphan attempt', async()=>{
  let cleaned=0
  await assert.rejects(persistProjectUpload(options({insertRecord:async()=>{throw new UploadRecordInsertError('denied','42501')},
    cleanupObject:async()=>{cleaned++}})),/denied/)
  assert.equal(cleaned,1)
})

test('an ID collision with changed content rejects before a second upload', async()=>{
  await assert.rejects(persistProjectUpload(options({findExisting:async()=>({storage_path:'winner'}),
    validateExisting:()=>{throw new Error('different content')},
    uploadObject:async()=>assert.fail('uploaded collision')})),/different content/)
})

test('legacy callers remain ordinary new uploads without an id lookup', async()=>{
  const result = await persistProjectUpload(options({retrySafe:false,findExisting:async()=>assert.fail('looked up undefined ID')}))
  assert.equal(result.created,true)
})

test('fingerprint binds equal-length bytes and attachment metadata', ()=>{
  const attributes={dailyLogId:'first',name:'photo.jpg',type:'image/jpeg',size:3}
  const fingerprint=uploadRequestFingerprint(Buffer.from('one'),attributes)
  assert.equal(fingerprint,uploadRequestFingerprint(Buffer.from('one'),attributes))
  assert.notEqual(fingerprint,uploadRequestFingerprint(Buffer.from('two'),attributes))
  assert.notEqual(fingerprint,uploadRequestFingerprint(Buffer.from('one'),{...attributes,dailyLogId:'second'}))
})
