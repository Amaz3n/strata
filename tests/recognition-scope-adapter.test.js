const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const load=()=>import('../scripts/recognition-reference-adapter.mjs')
const reference=()=>({source:{pageBounds:[0,0,100,100]},calibration:{status:'verified_source_dimensions',pdfPointsPerFootX:10,pdfPointsPerFootY:10,dimensionChecks:[{axis:'x'},{axis:'y'}]},scope:{scoringRegions:[{id:'region',complete:true,polygon:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]],wallIds:['body-left','body-right'],wallRunIds:['host'],openingIds:['door'],roomIds:['room']}]},walls:[{id:'body-left',a:[.2,.3],b:[.4,.3],thicknessInches:6},{id:'body-right',a:[.6,.3],b:[.8,.3],thicknessInches:6}],wallRuns:[{id:'host',a:[.2,.3],b:[.8,.3],thicknessInches:6}],openings:[{id:'door',a:[.4,.3],b:[.6,.3],kind:'hinged_door',hostWallRunId:'host'}],rooms:[{id:'room',polygon:[[.3,.4],[.7,.4],[.7,.7],[.3,.7]],holes:[],adjacentRoomIds:['outside'],boundaryAdjacencyIds:['edge']}],boundaryAdjacencies:[{id:'edge',roomId:'room'}]})
const level=()=>({source:{imageWidth:100,imageHeight:100,feetPerImagePx:.1,originPxX:0,originPxY:0},walls:[{id:'w',x0:1,y0:3,x1:9,y1:3,thicknessFt:.5}],openings:[{id:'o',wallId:'w',kind:'door',offsetFt:3,widthFt:2}],rooms:[{id:'p',polygon:[[3,4],[7,4],[7,7],[3,7]],holes:[],label:'Room'}]})
test('scope clipping preserves gaps in concave polygons and boundary-collinear spans',async()=>{
 const {clipSegment}=await load(),p=[[0,0],[1,0],[1,1],[.7,1],[.7,.3],[.3,.3],[.3,1],[0,1]]
 assert.deepEqual(clipSegment([0,.5],[1,.5],p),[[0,.3],[.7,1]])
 const boundary=clipSegment([-.2,0],[1.2,0],p);assert.equal(boundary.length,1);assert.ok(Math.abs(boundary[0][0]-1/7)<1e-12);assert.ok(Math.abs(boundary[0][1]-6/7)<1e-12)
 assert.deepEqual(clipSegment([-.2,1.1],[1.2,1.1],p),[])
 assert.throws(()=>clipSegment([0,0],[0,0],p),/Zero-length/)
})
test('opaque bodies subtract apertures, host runs keep openings, and outside walls are excluded',async()=>{
 const {adaptReference,adaptPrediction}=await load(),r=adaptReference(reference(),'region'),p=adaptPrediction(level(),r)
 assert.equal(r.openings[0].kind,'door');assert.equal(r.openings[0].hostWallId,'host')
 assert.deepEqual(p.walls.map(w=>[w.a,w.b]),[[[2,3],[4,3]],[[6,3],[8,3]]])
 assert.deepEqual(p.hostRuns.map(w=>[w.a,w.b]),[[[2,3],[8,3]]]);assert.equal(p.hostRuns[0].semanticId,'w')
 assert.deepEqual(p.openings[0].a,[4,3]);assert.deepEqual(p.openings[0].b,[6,3])
 assert.equal(p.rooms[0].adjacentRoomIds,null);assert.match(p.adjacencyStatus,/unavailable/)
})
test('prediction calibration is never replaced with reference scale or best-fit alignment',async()=>{
 const {adaptReference,adaptPrediction}=await load(),r=adaptReference(reference(),'region'),l=level();l.source.feetPerImagePx=.2;l.walls[0]={...l.walls[0],x0:2,x1:18,y0:6,y1:6};l.openings[0]={...l.openings[0],offsetFt:6,widthFt:4};l.rooms=[]
 const p=adaptPrediction(l,r);assert.deepEqual(p.walls[0].a,[4,6]);assert.equal(p.calibration.xRelativeDifference,1);assert.equal(p.calibration.alignment,'none')
 assert.deepEqual(r.walls[0].a,[2,3])
})
test('rooms and apertures keep complete extent to expose merges and wrong opening widths',async()=>{
 const {adaptReference,adaptPrediction,scoreScopedRoomGeometry}=await load(),r=adaptReference(reference(),'region'),l=level();l.rooms[0].polygon=[[0,0],[10,0],[10,10],[0,10]];l.openings[0].offsetFt=0;l.openings[0].widthFt=8
 const p=adaptPrediction(l,r);assert.deepEqual(p.openings[0].a,[1,3]);assert.deepEqual(p.openings[0].b,[9,3]);assert.deepEqual(p.rooms[0].polygon,l.rooms[0].polygon)
 const scores=scoreScopedRoomGeometry(r.rooms,p.rooms);assert.equal(scores.nominalGeometryRecall,0);assert.equal(scores.correctlyReconstructedFraction,null);assert.deepEqual(scores.expectedAdjacency[0].adjacentRoomIds,['outside']);assert.equal(scores.overlaps[0].iou,.12)
})
test('incomplete references, bad calibration and invalid predicted hosts cannot silently score',async()=>{
 const {adaptReference,adaptPrediction}=await load(),r=reference();r.scope.scoringRegions[0].complete=false;assert.throws(()=>adaptReference(r,'region'),/complete/)
 r.scope.scoringRegions[0].complete=true;r.calibration.status='unverified';assert.throws(()=>adaptReference(r,'region'),/calibration/)
 r.calibration.status='verified_dimensions';r.calibration.dimensionChecks=[{axis:'x'}];assert.throws(()=>adaptReference(r,'region'),/Both/)
 const a=adaptReference(reference(),'region'),l=level();l.openings[0].wallId='missing';assert.throws(()=>adaptPrediction(l,a),/host\/extent/)
 l.openings[0].wallId='w';l.openings[0].widthFt=9;assert.throws(()=>adaptPrediction(l,a),/host\/extent/)
})
test('concave scope fragments have unique metric IDs without losing semantic hosts',async()=>{
 const {adaptReference,adaptPrediction}=await load(),r=adaptReference(reference(),'region');r.polygon=[[0,0],[1,0],[1,1],[.7,1],[.7,.3],[.3,.3],[.3,1],[0,1]]
 const l=level();l.walls[0]={...l.walls[0],x0:0,x1:10,y0:5,y1:5};l.openings=[];l.rooms=[]
 const p=adaptPrediction(l,r);assert.equal(p.hostRuns.length,2);assert.notEqual(p.hostRuns[0].id,p.hostRuns[1].id);assert.deepEqual(p.hostRuns.map(w=>w.semanticId),['w','w']);assert.equal(p.excludedCounts.walls,0)
})
test('frozen reference hashes reject mutation and future diagnostics reject holdouts before reading sources',async()=>{
 const {loadFrozenReference,sha256}=await load(),{validateManifest,score}=await import('../scripts/score-recognition-scopes.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-scoped-test-'))
 try{
  const file=path.join(dir,'reference.json');fs.writeFileSync(file,'{}');const item={split:'development',referenceFile:file,referenceSha256:sha256('{}')}
  fs.writeFileSync(file,'{"changed":true}');assert.throws(()=>loadFrozenReference(item),/changed/)
  assert.throws(()=>loadFrozenReference({...item,split:'holdout',referenceFile:'/missing'}),/development/)
  const manifest={protocolVersion:'1.0.0',cases:[{split:'holdout',referenceFile:'/missing'}]};assert.throws(()=>validateManifest(manifest),/development/)
  const mf=path.join(dir,'manifest.json'),out=path.join(dir,'out');fs.writeFileSync(mf,JSON.stringify(manifest));await assert.rejects(()=>score(mf,out),/development/);assert.equal(fs.existsSync(out),false)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('host association survives solid-body cuts and fragmented scope IDs',async()=>{
 const {adaptReference,adaptPrediction,scoreScopedOpeningGeometry}=await load(),r=adaptReference(reference(),'region'),p=adaptPrediction(level(),r)
 const score=scoreScopedOpeningGeometry(r,p);assert.equal(score.truePositives,1);assert.equal(score.recall,1);assert.equal(score.precision,1)
 p.openings[0].hostWallId='unrelated';assert.equal(scoreScopedOpeningGeometry(r,p).truePositives,0)
})
test('pre-scoring source-only freeze and all reviewer hashes are enforced',async()=>{
 const {loadFrozenReference,sha256}=await load(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-freeze-test-'))
 try{
  const source=path.join(dir,'source.pdf'),author=path.join(dir,'author.json'),blind=path.join(dir,'blind.json'),file=path.join(dir,'reference.json'),manifest=path.join(dir,'freeze.sha256')
  fs.writeFileSync(source,'source');fs.writeFileSync(author,'author');fs.writeFileSync(blind,'blind')
  const r={source:{file:source,sha256:sha256('source')},freeze:{phase:'source_annotation_frozen_before_scoring',scoringPerformed:false,manifestPath:manifest},provenance:{engineCodeSeen:false,enginePredictionsSeen:false,engineBenchmarksSeen:false,inputFiles:[{role:'source_only_author_json',path:author,sha256:sha256('author')},{role:'source_only_blind_json',path:blind,sha256:sha256('blind')}]}}
  const freeze=()=>{fs.writeFileSync(file,JSON.stringify(r));const hash=sha256(fs.readFileSync(file));fs.writeFileSync(manifest,`${hash}  ${file}\n`);return{split:'development',referenceFile:file,referenceSha256:hash}}
  const item=freeze();assert.deepEqual(loadFrozenReference(item),r)
  const blindInput=r.provenance.inputFiles.pop();assert.throws(()=>loadFrozenReference(freeze()),/Separate author and blind/);r.provenance.inputFiles.push(blindInput);freeze()
  fs.writeFileSync(blind,'modified');assert.throws(()=>loadFrozenReference(item),/changed/);fs.writeFileSync(blind,'blind')
  r.provenance.enginePredictionsSeen=true;assert.throws(()=>loadFrozenReference(freeze()),/attestation/);r.provenance.enginePredictionsSeen=false
  const latest=freeze();fs.writeFileSync(manifest,`${'a'.repeat(64)}  ${file}\n`);assert.throws(()=>loadFrozenReference(latest),/absent/)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
