import { validateAreaGeometry, areasOverlap, proposalArea } from '../../lib/drawings/area-takeoff'
const fixture=JSON.parse(document.getElementById('fixture').textContent)
const byId=id=>document.getElementById(id)
let areas=[],draft=[],selected=-1,mode='area',dirty=false
function validateReferenceArea(area){
 if([area.points,...area.holes].some(r=>r.some(p=>p.length!==2||p.some(n=>!Number.isFinite(n)||n<0||n>1))))throw Error('Reference points must stay on the source sheet.')
 validateAreaGeometry(area)
}
const svg=byId('drawing'),ns='http://www.w3.org/2000/svg'
const tell=message=>{byId('status').textContent=message}
function render(){
 svg.replaceChildren()
 const path=(rings,color)=>{
  const node=document.createElementNS(ns,'path')
  node.setAttribute('d',rings.map(r=>r.map((p,i)=>`${i?'L':'M'}${p[0]*1000} ${p[1]*1000}`).join(' ')+'Z').join(' '))
  node.setAttribute('fill',color);node.setAttribute('fill-opacity','.15');node.setAttribute('stroke',color);node.setAttribute('stroke-width','1');node.setAttribute('fill-rule','evenodd');svg.append(node)
 }
 areas.forEach((a,i)=>path([a.points,...a.holes],i===selected?'#c44218':'#176773'))
 if(draft.length){const line=document.createElementNS(ns,'polyline');line.setAttribute('points',draft.map(p=>p.map(n=>n*1000).join(',')).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#c44218');line.setAttribute('stroke-width','1');svg.append(line);const start=document.createElementNS(ns,'circle');start.setAttribute('cx',draft[0][0]*1000);start.setAttribute('cy',draft[0][1]*1000);start.setAttribute('r','3');start.setAttribute('fill','#c44218');svg.append(start)}
 const list=byId('areas');list.replaceChildren()
 areas.forEach((a,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`${i+1}. ${a.label} · ${proposalArea(a,fixture.input.imageWidth,fixture.input.imageHeight,fixture.input.feetPerImagePx).toFixed(2)} SF · ${a.holes.length} deductions`;list.append(option)})
 list.value=String(selected);byId('count').textContent=`${areas.length} reference areas`
 byId('finish').disabled=draft.length<3;byId('hole').disabled=selected<0||draft.length>0;byId('remove').disabled=selected<0||draft.length>0
}
svg.addEventListener('click',event=>{
 const r=svg.getBoundingClientRect(),point=[(event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height]
 const near=p=>Math.hypot((point[0]-p[0])*r.width,(point[1]-p[1])*r.height)<=6
 // Clicking the start closes the draft; it must not insert a repeated vertex.
 if(draft.length>=3&&near(draft[0])){finish();return}
 // A double-click must not duplicate a corner or start an accidental new area.
 if(event.detail>1||(draft.length&&near(draft.at(-1))))return
 draft.push(point);dirty=true;render();tell(`${mode==='hole'?'Deduction':'Area'}: ${draft.length} points. Click the first point or press Enter to close.`)
})
function finish(){
 if(draft.length<3)return
 try{
  if(mode==='hole'){
   if(selected<0)throw Error('Choose the parent area first.')
   const candidate={...areas[selected],holes:[...areas[selected].holes,draft]};validateReferenceArea(candidate);areas[selected]=candidate
  }else{
   const label=byId('label').value.trim();if(!label)throw Error('Name the area before closing it.')
   const area={label,points:draft,holes:[]};validateReferenceArea(area)
   if(areas.some(a=>areasOverlap(a,area)))throw Error('Reference areas cannot overlap. Draw deductions before adding an area inside them.')
   areas.push(area);selected=areas.length-1
  }
  draft=[];mode='area';dirty=true;render();tell('Saved in this workspace. Export the review to keep it.')
 }catch(error){tell(error.message==='Area boundary is invalid'?'The boundary crosses or retraces itself. Use Undo point to remove the last corner, then continue around the room in order. Click the first point or press Enter to close.':error.message)}
}
byId('finish').onclick=finish
byId('undo').onclick=()=>{draft.pop();render()}
byId('cancel').onclick=()=>{draft=[];mode='area';render();tell('Draft discarded.')}
byId('hole').onclick=()=>{mode='hole';tell('Click around the deduction inside the selected area, then close it.')}
byId('remove').onclick=()=>{areas.splice(selected,1);selected=areas.length-1;dirty=true;render()}
byId('areas').onchange=()=>{selected=Number(byId('areas').value);render()}
byId('zoom').oninput=()=>{byId('canvas').style.width=byId('zoom').value+'%'}
document.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;if(event.key==='Enter'){event.preventDefault();finish();}if(event.key==='Escape')byId('cancel').click();if(event.key==='Backspace'){event.preventDefault();byId('undo').click()}})
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue=''}})
byId('save').onclick=()=>{
 try{
  if(draft.length)throw Error('Close or discard the current draft before exporting.')
  const annotator=byId('author').value.trim(),scope=byId('scope').value.trim(),category=byId('category').value
  if(!annotator||!scope||!category||!areas.length)throw Error('Add reference areas, your name, the finish convention, and the source category.')
  areas.forEach(validateReferenceArea)
  const result={...fixture,sourceCategory:category,annotationStatus:'human-annotated',annotation:{annotator,createdAt:new Date().toISOString(),method:'manual-source-tracing-without-detector-prefill',scope,completeness:byId('completeness').value},truth:{areas}}
  const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`area-review-page-${fixture.source.page}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);dirty=false;tell('Exported human annotation. Independent checking is still required before release qualification.')
 }catch(error){tell(error.message)}
}
byId('resume').onchange=async()=>{
 try{
  if(areas.length||draft.length)throw Error('Open a fresh workspace before resuming a saved review; existing work will not be replaced.')
  const file=byId('resume').files[0];if(!file)return
  const saved=JSON.parse(await file.text())
  if(saved.source?.sha256!==fixture.source.sha256||saved.source?.page!==fixture.source.page||saved.input?.feetPerImagePx!==fixture.input.feetPerImagePx||saved.input?.imageWidth!==fixture.input.imageWidth||saved.input?.imageHeight!==fixture.input.imageHeight)throw Error('This review belongs to another source page or calibration.')
  if(!Array.isArray(saved.truth?.areas)||saved.truth.areas.length>1000)throw Error('Invalid reference areas.')
  const restored=saved.truth.areas.map(a=>{if(typeof a.label!=='string'||!Array.isArray(a.points)||!Array.isArray(a.holes))throw Error('Invalid reference area.');validateReferenceArea(a);return {label:a.label,points:a.points,holes:a.holes}})
  for(let i=0;i<restored.length;i++)for(let j=0;j<i;j++)if(areasOverlap(restored[i],restored[j]))throw Error('Reference areas overlap.')
  areas=restored;selected=areas.length-1;byId('author').value=saved.annotation?.annotator??'';byId('scope').value=saved.annotation?.scope??'';byId('category').value=saved.sourceCategory??'';byId('completeness').value=saved.annotation?.completeness??'partial';render();tell('Saved annotation restored. Source evidence and calibration remain those of this workspace.')
 }catch(error){tell(error.message)}
}
render()
