require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const {extractWindowSchedules, resolveWindowScheduleMark, scheduleDimensionFt} = require('../lib/drawings/window-schedules')
const {encodeTextRuns, parseTextRuns} = require('../lib/drawings/text-runs')
const run = (text,x,y,w=.04,h=.01) => ({text,x,y,w,h})
function page() {
  return {sourceId:'revision-1:page-8',pageNumber:8,textRuns:[
    run('DOOR SCHEDULE',.1,.05,.18,.02),
    run('MARK',.1,.1),run('WIDTH',.2,.1),run('HEIGHT',.3,.1),
    run('A',.11,.125,.01),run(`9'-0"`,.2,.125),run(`8'-0"`,.3,.125),
    run('WINDOW SCHEDULE',.1,.3,.18,.02),
    run('MARK',.1,.35),run('WIDTH HEIGHT',.2,.35,.14),run('QTY.',.38,.35),run('TYPE',.45,.35),run('HEAD',.58,.35),
    run('A',.11,.375,.01),run(`5'-0"`,.2,.375),run(`6'-0"`,.3,.375),run('4',.395,.375,.01),run('SINGLE HUNG',.45,.375,.1),run('01/A8',.58,.375),
    run('C',.11,.39,.01),run(`2'-0"`,.2,.39),run(`5'-0"`,.3,.39),run('4',.395,.39,.01),run('CASEMENT',.45,.39,.08),
    run('G',.11,.405,.01),run('VAR',.2,.405),run(`2'-0"`,.3,.405),run('7',.395,.405,.01),run('AWNING',.45,.405,.07),
  ]}
}
test('window schedules use positioned rows rather than PDF reading order or adjacent door schedules',()=>{
  const p=page();p.textRuns=p.textRuns.filter((_,i)=>i%2).concat(p.textRuns.filter((_,i)=>!(i%2)).reverse())
  const before=structuredClone(p),out=extractWindowSchedules([p]);assert.deepEqual(out.issues,[])
  assert.deepEqual(out.rows.map(r=>[r.mark,r.scheduledWidthFt,r.scheduledHeightFt,r.quantity,r.cells.type.text]),[
    ['A',5,6,4,'SINGLE HUNG'],['C',2,5,4,'CASEMENT'],['G',null,2,7,'AWNING']])
  assert.equal(out.rows[2].issues.length,1);assert.deepEqual(p,before)
  for(const row of out.rows){
    assert.equal(row.sourceId,p.sourceId);assert.equal(row.pageNumber,8)
    assert.equal(p.textRuns[row.titleRunIndex].text,'WINDOW SCHEDULE')
    for(const c of Object.values(row.cells).filter(Boolean)) for(const i of c.runIndices){
      const r=p.textRuns[i];assert.ok(c.bounds.x0<=r.x&&c.bounds.x1>=r.x+r.w)
      assert.ok(c.bounds.y0<=r.y&&c.bounds.y1>=r.y+r.h)
    }
    assert.ok(!('sillFt' in row));assert.ok(!('headFt' in row))
  }
})
test('stored rounding and translated/scaled table layouts preserve supported values',()=>{
  for(const scale of [.45,.8,1]){
    const p=page();p.textRuns=parseTextRuns(encodeTextRuns(p.textRuns.map(r=>({...r,x:r.x*scale+.08,y:r.y*scale+.07,w:r.w*scale,h:r.h*scale}))))
    const rows=extractWindowSchedules([p]).rows
    assert.deepEqual(rows.map(r=>[r.mark,r.scheduledWidthFt,r.scheduledHeightFt]),[['A',5,6],['C',2,5],['G',null,2]])
  }
})
test('no explicit schedule title or incomplete columns cannot produce dimension rows',()=>{
  for(const removed of ['WINDOW SCHEDULE','WIDTH HEIGHT']){
    const p=page();p.textRuns=p.textRuns.filter(r=>r.text!==removed)
    const result=extractWindowSchedules([p]);assert.deepEqual(result.rows,[])
    if(removed==='WIDTH HEIGHT')assert.equal(result.issues.length,1)
  }
})
test('unit dimensions reject bare codes, variable values, competing readings and notes',()=>{
  for(const text of ['2040','3050','2','VAR','N/A','5 x 6',`5'-0" 4'-0"`,'5 ft verify',`5'-0" +/-`,'1500 mm']) assert.equal(scheduleDimensionFt(text),null,text)
  assert.equal(scheduleDimensionFt('5 ft 6 in'),5.5)
  assert.equal(scheduleDimensionFt('66″'),5.5)
  assert.equal(scheduleDimensionFt('5′-6½″'),5+6.5/12)
  assert.equal(scheduleDimensionFt(`2'-0"`),2)
})
test('conflicting cells remain unresolved and duplicate marks never resolve by first match',()=>{
  const p=page();p.textRuns.push(run(`4'-0"`,.2,.375))
  let rows=extractWindowSchedules([p]).rows
  assert.equal(rows[0].scheduledWidthFt,null);assert.ok(rows[0].issues.length)
  const other=page();other.sourceId='revision-2:page-8'
  rows=extractWindowSchedules([page(),other]).rows
  assert.equal(resolveWindowScheduleMark(rows,'A').status,'ambiguous')
  assert.ok(rows.every(r=>r.issues.some(i=>i.includes('more than once'))))
  assert.equal(resolveWindowScheduleMark(rows,'W99').status,'missing')
  assert.equal(resolveWindowScheduleMark(extractWindowSchedules([page()]).rows,' c ').row.scheduledHeightFt,5)
})
test('detail references, far-away rows, footer letters and invalid coordinates cannot become scheduled dimensions',()=>{
  const p=page();p.textRuns.push(run('X',.11,.65,.01),run(`9'-0"`,.2,.65),run(`9'-0"`,.3,.65),run('Z',NaN,.42))
  let rows=extractWindowSchedules([p]).rows
  assert.deepEqual(rows.map(r=>r.mark),['A','C','G'])
  p.textRuns.push(run('GENERAL NOTES',.1,.4,.2))
  rows=extractWindowSchedules([p]).rows
  assert.deepEqual(rows.map(r=>r.mark),['A','C'])
})
test('overlapping mark text is ambiguous even when the source duplicated an identical letter',()=>{
  const p=page();p.textRuns.push(run('A',.11,.375,.01))
  assert.equal(resolveWindowScheduleMark(extractWindowSchedules([p]).rows,'A').status,'ambiguous')
})
test('missing window columns cannot borrow the dimensions of a neighboring door table',()=>{
  const p=page();p.textRuns=p.textRuns.filter(r=>r.text!=='WIDTH HEIGHT')
  p.textRuns.push(run('DOOR SCHEDULE',.68,.3,.18,.02),run('WIDTH',.7,.35),run('HEIGHT',.8,.35),run(`3'-0"`,.7,.375),run(`7'-0"`,.8,.375))
  const result=extractWindowSchedules([p]);assert.equal(result.rows.length,0);assert.equal(result.issues.length,1)
})
test('rotated tables require alignment rather than interpreting vertical boxes as horizontal columns',()=>{
  const p=page();p.textRuns=p.textRuns.map(r=>({...r,x:r.y,y:r.x,w:r.h,h:r.w}))
  const result=extractWindowSchedules([p]);assert.equal(result.rows.length,0);assert.ok(result.issues.some(i=>i.message.includes('Rotated')))
})
test('centered schedules accept ID and grouped W/H without confusing the head height column',()=>{
  const p=page();p.textRuns=p.textRuns.filter(r=>r.y>=.3).map(r=>r.text==='WINDOW SCHEDULE'?{...r,x:.3}:r.text==='MARK'?{...r,text:'ID'}:r.text==='HEAD'?{...r,text:'HEIGHT'}:r)
  p.textRuns=p.textRuns.filter(r=>r.text!=='WIDTH HEIGHT')
  p.textRuns.push(run('W',.215,.35,.01),run('H',.315,.35,.01),run('UNIT SIZE',.2,.33,.14),run('HEAD',.58,.34))
  p.textRuns=p.textRuns.map(r=>r.text==='01/A8'?{...r,text:`10'-2"`}:r)
  const out=extractWindowSchedules([p]);assert.deepEqual(out.issues,[])
  assert.equal(out.rows.length,3);assert.equal(out.rows[0].scheduledHeightFt,6)
  assert.equal(out.rows[0].dimensionBasis,'unit-size')
  assert.equal(out.rows[0].cells.sizeBasis.text,'UNIT SIZE')
  assert.equal(out.rows[0].cells.headReference.text,`10'-2"`)
  assert.ok(!('headFt' in out.rows[0]))
})
test('combined size cells require explicit width/height labels and preserve the whole source cell',()=>{
  const p=page();p.textRuns=p.textRuns.filter(r=>r.y>=.3 && !(r.x===.3 && r.y>.35)).map(r=>r.text==='WIDTH HEIGHT'?{...r,text:'WINDOW SIZE'}:r.x===.2&&r.y>.35?{...r,text:`${r.text}w x 6'-0"h`,w:.14}:r)
  let out=extractWindowSchedules([p]);assert.equal(out.rows.length,3)
  assert.equal(out.rows[0].scheduledWidthFt,5);assert.equal(out.rows[0].scheduledHeightFt,6)
  assert.deepEqual(out.rows[0].cells.width,out.rows[0].cells.height)
  assert.equal(out.rows[2].scheduledWidthFt,null)
  p.textRuns=p.textRuns.map(r=>r.y===.375&&r.x===.2?{...r,text:`5'-0" x 6'-0"`}:r)
  out=extractWindowSchedules([p]);assert.equal(out.rows[0].scheduledWidthFt,null);assert.equal(out.rows[0].scheduledHeightFt,null)
})
test('size basis stays unspecified unless an explicit group identifies unit or rough opening size',()=>{
  assert.equal(extractWindowSchedules([page()]).rows[0].dimensionBasis,'unspecified')
  const p=page();p.textRuns.push(run('ROUGH OPENING',.2,.33,.14))
  assert.equal(extractWindowSchedules([p]).rows[0].dimensionBasis,'rough-opening')
  p.textRuns.push(run('UNIT SIZE',.2,.33,.14))
  const row=extractWindowSchedules([p]).rows[0];assert.equal(row.dimensionBasis,'unspecified');assert.ok(row.issues.some(i=>i.includes('size basis')))
})
test('long combination notes remain attached when their header uses the neighboring baseline',()=>{
  const p=page();p.textRuns.push(run('Note/Remarks',.7,.345,.08),run('COMBO W/ ENTRY DOOR; SEE ELEVATION',.7,.375,.28))
  const row=extractWindowSchedules([p]).rows[0]
  assert.equal(row.cells.notes.text,'COMBO W/ ENTRY DOOR; SEE ELEVATION')
  assert.equal(row.cells.notes.runIndices.length,1)
})
test('multiple dimension column groups require selection instead of using whichever comes first',()=>{
  const p=page();p.textRuns.push(run('WINDOW SIZE',.7,.35,.1),run(`4'-0"w x 7'-0"h`,.7,.375,.1))
  const out=extractWindowSchedules([p]);assert.equal(out.rows.length,0);assert.equal(out.issues.length,1)
})
test('left-aligned remarks under centered headers survive and source truncation stays visible',()=>{
  const p=page();p.textRuns.push(run('NOTES',.8,.35,.06),run('Two casements with fixed center; see…',.625,.375,.3))
  const row=extractWindowSchedules([p]).rows[0]
  assert.equal(row.cells.notes.text,'Two casements with fixed center; see…')
  assert.ok(row.issues.some(i=>i.includes('truncated')))
})
