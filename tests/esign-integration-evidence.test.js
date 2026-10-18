require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),{generateKeyPairSync}=require('node:crypto')
const {createEstimateEvidenceManifest}=require('../lib/esign/estimate-evidence'),{verifyESignEvidenceManifest}=require('../lib/esign/evidence')
const input={documentId:'document',envelopeId:'envelope',revision:2,sourceHash:'a'.repeat(64),executedHash:'b'.repeat(64),builder:{signature_id:'signature',signer_name:'Builder',signer_email:'builder@example.test',signed_at:'2026-01-01T12:00:00Z',consent_text:'Actual recorded consent',consent_version:'version-1',signature_image:'recorded-image'},earlierClient:{signer_name:'Client',source:'estimate_portal'}}
test('native evidence remains explicitly unsigned without a configured signing key',()=>{
 const prior=process.env.ESIGN_EVIDENCE_PRIVATE_KEY_PEM;delete process.env.ESIGN_EVIDENCE_PRIVATE_KEY_PEM
 try{assert.equal(createEstimateEvidenceManifest(input),null)}finally{if(prior!==undefined)process.env.ESIGN_EVIDENCE_PRIVATE_KEY_PEM=prior}
})
test('native manifest binds exact hashes and recorded builder consent without inventing earlier client consent',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),privatePem=privateKey.export({type:'pkcs8',format:'pem'}),publicPem=publicKey.export({type:'spki',format:'pem'})
 const manifest=createEstimateEvidenceManifest(input,privatePem)
 assert.equal(verifyESignEvidenceManifest(manifest,publicPem),true)
 assert.equal(manifest.payload.source_sha256,input.sourceHash);assert.equal(manifest.payload.executed_sha256,input.executedHash)
 assert.equal(manifest.payload.signatures[0].consent,'Actual recorded consent')
 assert.equal(manifest.payload.earlier_client_metadata.evidence_source,'earlier_client_metadata')
 assert.equal(manifest.payload.earlier_client_metadata.consent,null);assert.equal(manifest.payload.earlier_client_metadata.consent_accepted,null)
 const changed=structuredClone(manifest);changed.payload.executed_sha256='c'.repeat(64);assert.equal(verifyESignEvidenceManifest(changed,publicPem),false)
})
