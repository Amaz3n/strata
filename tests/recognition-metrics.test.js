const test=require('node:test'),assert=require('node:assert/strict')
const wall=(id,a,b)=>({id,a,b,thicknessFt:.5})
test('physical wall credit is segmentation invariant and duplicates cannot inflate precision',async()=>{
  const {scoreWalls}=await import('../scripts/recognition-metrics.mjs'),reference=[wall('r',[0,0],[10,0])]
  const a=scoreWalls(reference,[wall('a',[0,0],[4,0]),wall('b',[4,0],[10,0])])
  assert.equal(a.precision,1);assert.equal(a.recall,1)
  const duplicate=scoreWalls(reference,[wall('a',[0,0],[10,0]),wall('b',[10,0],[0,0])])
  assert.equal(duplicate.precision,.5);assert.equal(duplicate.recall,1);assert.equal(duplicate.inventedOrDuplicateFt,10)
  const miss=scoreWalls(reference,[wall('a',[0,0],[4,0]),wall('extra',[0,5],[6,5])])
  assert.equal(miss.precision,.4);assert.equal(miss.recall,.4);assert.equal(miss.missedFt,6)
  assert.throws(()=>scoreWalls([...reference,{...reference[0],id:'duplicate-reference'}],[]),/Reference wall spans overlap/)
})
test('physical tolerances reject parallel displacement, wrong thickness and diverging long walls',async()=>{
  const {scoreWalls}=await import('../scripts/recognition-metrics.mjs'),r=[wall('r',[0,0],[100,0])]
  for(const p of [wall('p',[0,.1],[100,.1]),{...wall('p',[0,0],[100,0]),thicknessFt:1},wall('p',[0,-.1],[100,.1])])assert.equal(scoreWalls(r,[p]).recall,0)
  assert.equal(scoreWalls(r,[wall('p',[0,.04],[100,.04])]).recall,1)
  assert.equal(scoreWalls([],[]).precision,null)
  assert.throws(()=>scoreWalls(r,[wall('bad',[0,0],[0,0])]),/segment/)
})
test('assignment maximizes cardinality before cost and can reassign a greedy first match',async()=>{
  const {oneToOneMatch}=await import('../scripts/recognition-metrics.mjs')
  const result=oneToOneMatch(2,2,[{left:0,right:0,cost:0},{left:0,right:1,cost:2},{left:1,right:0,cost:1}])
  assert.deepEqual(result.map(x=>[x.left,x.right]),[[0,1],[1,0]])
  const minimum=oneToOneMatch(2,2,[{left:0,right:0,cost:3},{left:0,right:1,cost:1},{left:1,right:0,cost:1},{left:1,right:1,cost:3}])
  assert.equal(minimum.reduce((s,x)=>s+x.cost,0),2)
  // Exhaustive independent oracle for small sparse/competing configurations.
  for(let mask=0;mask<512;mask+=7){
    const edges=[];for(let left=0;left<3;left++)for(let right=0;right<3;right++)if(mask&(1<<(left*3+right)))edges.push({left,right,cost:(left*7+right*3+mask)%5})
    let best={count:-1,cost:Infinity}
    const enumerate=(left,used,count,cost)=>{
      if(left===3){if(count>best.count||(count===best.count&&cost<best.cost))best={count,cost};return}
      enumerate(left+1,used,count,cost)
      for(const e of edges.filter(e=>e.left===left&&!used.has(e.right)))enumerate(left+1,new Set([...used,e.right]),count+1,cost+e.cost)
    }
    enumerate(0,new Set(),0,0)
    const actual=oneToOneMatch(3,3,edges)
    assert.equal(actual.length,best.count);assert.equal(actual.reduce((s,e)=>s+e.cost,0),best.cost)
  }
})
test('opening matches require geometry, type, host and one-to-one identity; duplicates remain false positives',async()=>{
  const {scoreOpenings}=await import('../scripts/recognition-metrics.mjs')
  const r={id:'r',kind:'window',a:[0,0],b:[4,0],hostWallId:'rw'},p={...r,id:'p',a:[4,0],b:[0,0],hostWallId:'pw'},hosts=[{referenceWallId:'rw',predictionWallId:'pw',referenceSpan:{a:[0,0],b:[4,0]}}]
  const exact=scoreOpenings([r],[p],hosts);assert.equal(exact.precision,1);assert.equal(exact.recall,1)
  const dup=scoreOpenings([r],[p,{...p,id:'duplicate'}],hosts);assert.equal(dup.falsePositives,1);assert.equal(dup.truePositives,1)
  for(const bad of [{...p,kind:'door'},{...p,hostWallId:'wrong'},{...p,b:[.2,0]}])assert.equal(scoreOpenings([r],[bad],hosts).truePositives,0)
  assert.equal(scoreOpenings([r],[p],[]).falseNegatives,1)
  assert.equal(scoreOpenings([r],[p],[{...hosts[0],referenceSpan:{a:[10,0],b:[20,0]}}]).falseNegatives,1)
})
test('opaque wall scoring and aperture host relationships use separate source-backed representations',async()=>{
  const {scoreWalls,matchOpeningHosts,scoreOpenings}=await import('../scripts/recognition-metrics.mjs')
  const bodies=[wall('left',[0,0],[3,0]),wall('right',[7,0],[10,0])]
  assert.equal(scoreWalls(bodies,bodies).precision,1)
  const hosts=matchOpeningHosts([wall('reference-run',[0,0],[10,0])],[wall('model-run',[0,0],[10,0])])
  const opening={id:'door',kind:'door',a:[3,0],b:[7,0],hostWallId:'reference-run'}
  assert.equal(scoreOpenings([opening],[{...opening,id:'prediction',hostWallId:'model-run'}],hosts).truePositives,1)
  assert.equal(scoreWalls(bodies,[wall('uncut-host',[0,0],[10,0])]).precision,.6)
})
test('polygon IoU preserves concavities and holes without bounding-box or sampling shortcuts',async()=>{
  const {polygonIoU}=await import('../scripts/recognition-metrics.mjs')
  const square={polygon:[[0,0],[10,0],[10,10],[0,10]],holes:[]},hole={...square,holes:[[[2,2],[4,2],[4,4],[2,4]]]}
  assert.ok(Math.abs(polygonIoU(square,hole).iou-.96)<1e-10)
  assert.equal(polygonIoU(hole,hole).iou,1)
  const l={polygon:[[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]],holes:[]}
  assert.equal(polygonIoU(l,l).referenceAreaSqft,7);assert.equal(polygonIoU(l,l).iou,1)
  assert.equal(polygonIoU(l,{polygon:[[2,2],[3,2],[3,3],[2,3]]}).intersectionSqft,0)
  assert.throws(()=>polygonIoU(square,{polygon:[[0,0],[4,4],[0,4],[4,0]]}),/polygon/)
  assert.throws(()=>polygonIoU(square,{...square,holes:[[[20,20],[21,20],[21,21],[20,21]]]}),/Hole/)
})
test('room correctness requires IoU and reciprocal mapped adjacency; splits and extras remain visible',async()=>{
  const {scoreRooms}=await import('../scripts/recognition-metrics.mjs')
  const room=(id,x,adjacentRoomIds=[])=>({id,polygon:[[x,0],[x+4,0],[x+4,4],[x,4]],holes:[],adjacentRoomIds})
  const r=[room('a',0,['b']),room('b',4,['a'])],p=[room('x',0,['y']),room('y',4,['x'])]
  assert.equal(scoreRooms(r,p).correctlyReconstructedFraction,1)
  assert.equal(scoreRooms(r,p.map(x=>({...x,adjacentRoomIds:[]}))).correctlyReconstructedFraction,0)
  const extras=scoreRooms(r,[...p,room('extra',10)])
  assert.deepEqual(extras.unmatchedPredictionIds,['extra'])
  assert.equal(extras.correctPredictionFraction,2/3)
  const halves=[{...room('half1',0),polygon:[[0,0],[2,0],[2,4],[0,4]]},{...room('half2',2),polygon:[[2,0],[4,0],[4,4],[2,4]]}]
  const split=scoreRooms([room('a',0)],halves);assert.equal(split.correctRooms,0);assert.equal(split.overlaps.length,2)
  assert.throws(()=>scoreRooms([room('a',0),room('b',1)],[]),/Reference rooms overlap/)
})
test('dimension gates preserve uncertainty, missing observations and physical-unit thresholds',async()=>{
  const {scoreDimensions}=await import('../scripts/recognition-metrics.mjs')
  const score=scoreDimensions([{id:'short',referenceFt:10,predictionFt:10.1,uncertaintyFt:.02},{id:'long',referenceFt:100,predictionFt:100.5,uncertaintyFt:.1}])
  assert.ok(score.buckets.every(b=>b.status==='pass'))
  assert.equal(scoreDimensions([{id:'uncertain',referenceFt:10,predictionFt:10.15,uncertaintyFt:.1}]).buckets[0].status,'unverified')
  assert.equal(scoreDimensions([{id:'miss',referenceFt:10,predictionFt:null,uncertaintyFt:.01}]).buckets[0].status,'fail')
  assert.equal(scoreDimensions([]).buckets[0].status,'unverified')
  assert.throws(()=>scoreDimensions([{id:'unknown',referenceFt:10,predictionFt:10}]),/uncertainty/)
})
test('confidence summaries use projects, preserve failures and disclose small samples',async()=>{
  const {wilsonInterval,projectBootstrap}=await import('../scripts/recognition-metrics.mjs')
  const interval=wilsonInterval(30,30);assert.ok(Math.abs(interval.upper-1)<1e-12);assert.ok(interval.lower<.9);assert.equal(wilsonInterval(0,0),null)
  const projects=[{id:'large',numerator:98,denominator:100},{id:'failed',numerator:0,denominator:1}]
  const result=projectBootstrap(projects)
  assert.equal(result.macroMean,.49);assert.equal(result.smallSampleWarning,true);assert.equal(result.projectCount,2)
  assert.deepEqual(result,projectBootstrap(projects));assert.ok(result.lower===0&&result.upper===.98)
  assert.throws(()=>projectBootstrap([projects[0],projects[0]]),/unique/)
})
