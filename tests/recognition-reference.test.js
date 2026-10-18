const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process')
test('annotation templates contain no generated truth, verified calibration or independent-review claim',async()=>{
  const {referenceTemplate}=await import('../scripts/prepare-recognition-reference.mjs')
  const item={id:'set-1-page-1-original',set:1,sha256:'a'.repeat(64),page:1,file:'plan.pdf',split:'development',feetPerPdfPoint:.1}
  const r=referenceTemplate(item,[0,0,100,80])
  assert.equal(r.annotation.status,'not-started');assert.equal(r.annotation.reviewer,null);assert.equal(r.calibration.status,'unverified')
  assert.equal(r.independentAccuracyQualified,false);assert.equal(r.releaseReady,false)
  for(const key of ['walls','openings','rooms','floorVoids','eligibleViews','dimensionChecks']) assert.deepEqual(key==='dimensionChecks'?r.calibration[key]:r[key],[])
  for(const split of ['holdout','validation',undefined])assert.throws(()=>referenceTemplate({...item,split},[0,0,100,80]),/development/)
  assert.throws(()=>referenceTemplate({...item,sha256:'changed'},[0,0,100,80]),/identity/)
})
test('development runners reject holdouts before source access or output creation',async()=>{
  const {prepare}=await import('../scripts/prepare-recognition-reference.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-reference-test-'))
  try {
    const manifest=path.join(dir,'cases.json'),output=path.join(dir,'output')
    fs.writeFileSync(manifest,JSON.stringify({cases:[{id:'held-out',set:1,file:'/unavailable-source.pdf',split:'holdout',variant:'original'}]}))
    await assert.rejects(()=>prepare(manifest,output,[1]),/development/)
    assert.equal(fs.existsSync(output),false)
    const result=spawnSync(process.execPath,['scripts/benchmark-building-corpus.mjs',manifest,output],{encoding:'utf8'})
    assert.notEqual(result.status,0);assert.match(result.stderr,/held-out/);assert.equal(fs.existsSync(output),false)
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
