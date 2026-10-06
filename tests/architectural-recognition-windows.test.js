require('../scripts/register-ts-node-test');
const test=require('node:test'),assert=require('node:assert/strict');
const {planRecognitionWindows}=require('../lib/drawings/recognition-window-plan');
const p=(id,a,b)=>({id,kind:'stroke',commands:[['M',...a],['L',...b]],layer:[],opacity:1,color:[0],colorSpace:'DeviceGray',width:1,dashes:[],clips:[],groups:[],evenOdd:false});
const e=paths=>({version:1,paths,truncated:false});
const source=paths=>({evidence:e(paths),region:{x0:0,y0:0,x1:1,y1:1},targets:[[.2,.3]],sx:100,sy:100});
const assigned=plan=>plan.windows.flatMap(w=>w.pathIds);

test('complete-path supplementation fills sparse target holes exactly once without modifying source geometry',()=>{
 const input=source([p(1,[.2,.3],[.22,.3]),p(2,[.65,.3],[.67,.3]),p(3,[.655,.31],[.675,.31])]),before=JSON.stringify(input.evidence),plan=planRecognitionWindows(input);
 assert.equal(plan.eligiblePaths,3);assert.deepEqual(plan.unassignedPathIds,[]);
 assert.equal(assigned(plan).length,3);assert.equal(new Set(assigned(plan)).size,3);
 assert.ok(plan.windows.some(w=>w.supplemental));assert.equal(JSON.stringify(input.evidence),before);
});

test('an original-source budget admits a complete long path without clipping it to the default crop',()=>{
 const input={...source([p(1,[.1,.4],[.34,.4])]),sx:192,sy:128.26666666666668,maximumSpan:{x:4094/10800,y:4094/7215}};
 const plan=planRecognitionWindows(input),w=plan.windows.find(w=>w.pathIds.includes(1));
 assert.ok(w);assert.ok(w.supplemental);assert.deepEqual(plan.unassignedPathIds,[]);
 assert.ok(w.region.x0<=.1&&w.region.x1>=.34);
 assert.ok(w.region.x1-w.region.x0<=input.maximumSpan.x+1e-12);
 assert.ok(w.region.y1-w.region.y0<=input.maximumSpan.y+1e-12);
});

test('a path larger than source capacity stays explicitly unassigned and is never replaced by a cropped fragment',()=>{
 const input={...source([p(1,[.01,.4],[.99,.4]),p(2,[.2,.3],[.22,.3])]),maximumSpan:{x:.4,y:.4}},before=JSON.stringify(input.evidence);
 const plan=planRecognitionWindows(input);
 assert.deepEqual(plan.unassignedPathIds,[1]);assert.deepEqual(assigned(plan),[2]);
 assert.equal(JSON.stringify(input.evidence),before);
});

test('edge admission stays inside the selected view and respects unequal axis capacities',()=>{
 const input={...source([p(1,[.7,.5],[.71,.54]),p(2,[.704,.501],[.706,.502])]),region:{x0:.2,y0:.25,x1:.71,y1:.55},targets:[],maximumSpan:{x:.05,y:.08}};
 const plan=planRecognitionWindows(input);
 assert.deepEqual(plan.unassignedPathIds,[]);assert.equal(assigned(plan).length,2);
 for(const w of plan.windows){const r=w.region;assert.ok(r.x0>=.2&&r.y0>=.25&&r.x1<=.71&&r.y1<=.55);assert.ok(r.x1-r.x0<=.05+1e-12&&r.y1-r.y0<=.08+1e-12);}
});

test('planning is independent of source array order and rejects invalid frames and budgets',()=>{
 const input=source([p(9,[.65,.3],[.67,.3]),p(2,[.2,.3],[.22,.3])]);
 assert.deepEqual(planRecognitionWindows(input),planRecognitionWindows({...input,evidence:e([...input.evidence.paths].reverse())}));
 for(const bad of [{sx:NaN},{maximumSpan:{x:0,y:1}},{region:{x0:0,y0:0,x1:0,y1:1}}])assert.throws(()=>planRecognitionWindows({...input,...bad}),/Invalid recognition planning/);
});

test('path admission work is bounded and unscheduled source paths remain explicit',()=>{
 const input={...source(Array.from({length:2400},(_,id)=>p(id,[id/2400,.3],[id/2400+.000001,.3]))),sx:1000000,sy:1000000,targets:[]};
 const plan=planRecognitionWindows(input);
 assert.equal(plan.limited,true);assert.ok(plan.work<=2000001);
 assert.ok(plan.unassignedPathIds.length>0);assert.equal(assigned(plan).length+plan.unassignedPathIds.length,plan.eligiblePaths);
});
