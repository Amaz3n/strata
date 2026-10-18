const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function harness(publication,labels=null){
 const slots=[],compiled={exports:{}};let cursor=0
 const props={publication,labels,canReadMargin:false,disabled:false}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/catalog-publication-review.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,require(name){
  if(name==='react')return {useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,value=>slots[n].value=typeof value==='function'?value(slots[n].value):value]}}
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  return new Proxy({},{get:(_,key)=>key})
 }})
 function nodes(tree,predicate,result=[]){if(!tree||typeof tree!=='object')return result;if(predicate(tree))result.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,result);return result}
 function text(tree){if(tree===null||tree===undefined||tree===false)return '';if(typeof tree!=='object')return String(tree);return [tree.props?.children].flat(Infinity).map(text).join('')}
 const render=()=>{cursor=0;return compiled.exports.CatalogPublicationReview(props)},button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0]
 return {props,render,nodes,text,button}
}
function prices(count=1){return {kind:'prices',attempt:{publicationKey:id(80),expectedOrgId:id(1),expectedActorId:id(2),communityId:null,items:Array.from({length:count},(_,n)=>({optionId:id(100+n),packageId:null,housePlanVersionId:id(900),priceCents:1200+n,costCents:9384777,expectedPrice:{id:id(1000+n),price_cents:1000+n,is_available:true,cost_cents:10000001},isAvailable:false}))}}}
test('recovered price review shows original public values, captured names and availability while hiding every cost without confirmed access',()=>{
 const publication=prices(),labels={kind:'prices',items:[{optionId:id(100),packageId:null,housePlanVersionId:id(900),subjectName:'Original cabinets',planName:'Alpha',versionLabel:'Release one'}]},f=harness(publication,labels),tree=f.render(),copy=f.text(tree)
 assert.match(copy,/Original cabinets/);assert.match(copy,/Alpha · Release one/);assert.match(copy,/\$10\.00 → \$12\.00/);assert.match(copy,/Available → Unavailable/)
 assert.ok(!copy.includes('$93,847.77'));assert.ok(!copy.includes('$100,000.01'));assert.ok(!f.nodes(tree,n=>n.type==='th'&&n.props.children==='Cost').length)
 assert.match(copy,/Names were captured/);assert.match(copy,/do not describe the current catalog/)
 f.props.canReadMargin=true;const revealed=f.text(f.render());assert.match(revealed,/\$100,000\.01 → \$93,847\.77/)
 f.props.canReadMargin=false;assert.ok(!f.text(f.render()).includes('$93,847.77'))
})
test('all 500 reviewed cells are reachable with at most 20 rendered rows and non-submit pagination controls',()=>{
 const f=harness(prices(500)),seen=new Set()
 for(let page=1;page<=25;page++){
  const tree=f.render(),rows=f.nodes(tree,n=>n.type==='tr').slice(1);assert.equal(rows.length,20)
  for(const row of rows){const ids=f.nodes(row,n=>n.type==='p'&&n.props.className==='font-mono text-xs text-muted-foreground');seen.add(ids[0].props.children)}
  const next=f.button(tree,'Next reviewed items');assert.equal(next.props.type,'button');assert.equal(next.props.disabled,page===25)
  if(page<25)next.props.onClick()
 }
 assert.equal(seen.size,500);assert.match(f.text(f.render()),/Showing 481–500 of 500/)
 f.button(f.render(),'Previous reviewed items').props.onClick();assert.match(f.text(f.render()),/Showing 461–480 of 500/)
})
test('package original header and all requested members remain readable without substituting current prices or leaking saved costs',()=>{
 const optionIds=Array.from({length:45},(_,n)=>id(100+n)),publication={kind:'package',attempt:{publicationKey:id(90),name:'Original kitchen package',description:'Original notes',priceCents:150000,costCents:null,isAvailable:true,optionIds,expectedPackage:{price_cents:100000,cost_cents:10000001,is_available:false,option_ids:[id(100)]}}},labels={kind:'package',options:optionIds.map((optionId,n)=>({optionId,name:`Original option ${n+1}`}))},f=harness(publication,labels)
 const first=f.text(f.render());assert.match(first,/Original kitchen package/);assert.match(first,/\$1,000\.00 → \$1,500\.00/);assert.match(first,/Unavailable → Available/);assert.match(first,/Original notes/);assert.ok(!first.includes('$100,000.01'));assert.match(first,/previously 1/)
 const seen=new Set();for(let page=1;page<=3;page++){const tree=f.render(),rows=f.nodes(tree,n=>n.type==='li');assert.ok(rows.length<=20);for(const row of rows)seen.add(f.text(row));if(page<3)f.button(tree,'Next reviewed items').props.onClick()}
 assert.equal(seen.size,45);f.props.canReadMargin=true;assert.match(f.text(f.render()),/\$100,000\.01 → Clear cost/)
})
test('missing captured labels are explicit, absent own-price baselines are not invented, and disabled navigation cannot change the review',()=>{
 const publication=prices(25);publication.attempt.items[0].expectedPrice=null;publication.attempt.items[0].costCents=undefined
 const f=harness(publication),first=f.render();assert.match(f.text(first),/Captured names are unavailable/);assert.match(f.text(first),/Option name unavailable/);assert.match(f.text(first),/Inherited \/ no scoped price → \$12\.00/)
 f.props.canReadMargin=true;assert.match(f.text(f.render()),/Unchanged/)
 f.props.disabled=true;f.button(f.render(),'Next reviewed items').props.onClick();assert.match(f.text(f.render()),/Showing 1–20 of 25/)
})

test('group original review reaches every selected/root definition in 20-row pages and shows an explicit empty assignment state',()=>{
 const versions=Array.from({length:200},(_,n)=>({id:id(100+n),definitionHash:'a'.repeat(64)})),publication={kind:'group',attempt:{publicationKey:id(190),communityId:null,name:'Original rule',scheduleTaskKey:'frame',cutoffOffsetDays:-14,cutoffAnchor:'start',categoryIds:versions.slice(0,100).map(v=>v.id),expectedGroup:null,expectedCategoryVersions:versions}},labels={kind:'group',categories:versions.map(v=>({...v,definition:{id:v.id,name:'Original '+v.id,description:'Original explanation',image_url:'/original.png',community_id:null,parent_category_id:null,sort_order:7,is_archived:false}}))},f=harness(publication,labels),seen=new Set()
 for(let page=1;page<=10;page++){const tree=f.render(),rows=f.nodes(tree,n=>n.type==='li');assert.equal(rows.length,20);for(const row of rows)seen.add(f.text(row));if(page<10)f.button(tree,'Next reviewed items').props.onClick()}
 assert.equal(seen.size,200);assert.match(f.text(f.render()),/Override root/);assert.match(f.text(f.render()),/Original explanation/);assert.match(f.text(f.render()),/Image \/original.png/);assert.ok(!f.text(f.render()).includes('Costs are hidden'))
 publication.attempt.categoryIds=[];publication.attempt.expectedCategoryVersions=[];const empty=f.text(f.render());assert.match(empty,/No category assignments/);assert.ok(!empty.includes('Showing 1–0'))
})
