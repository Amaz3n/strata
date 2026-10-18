require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),React=require('react')
const {renderToStaticMarkup}=require('react-dom/server'),{createClient}=require('@supabase/supabase-js')
const lifecycle=require('../lib/inspections/lifecycle'),z=require('zod').z
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1),HOME=id(2),ACTOR=id(3),INSP=id(6),OBL=id(12)
const detail={id:INSP,org_id:ORG,project_id:HOME,title:'Final inspection',kind:'quality',template_id:null,location_id:null,company_id:null,schedule_item_id:null,notes:null,location:null,inspector_name:null,inspection_number:1,metadata:{},status:'completed',result:'pass',items:[]}
function declarations(file,names,bindings) {
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
 const nodes=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));assert.equal(nodes.length,names.length)
 const code=ts.transpileModule(nodes.map(n=>n.getText(source)).join('\n')+`\nexport {${names.join(',')}};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const exports={};new Function('exports','require',...Object.keys(bindings),code)(exports,require,...Object.values(bindings));return exports
}
function service({denied=false,response=null,error=null}={}) {
 const calls=[],gates=[]
 const supabase=createClient('https://inspection-lifecycle.invalid','isolated-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({name:new URL(url).pathname.split('/').pop(),body})
  return new Response(JSON.stringify(error??response??{obligationId:OBL,inspectionId:INSP,attemptNumber:1}),{status:error?400:200,headers:{'content-type':'application/json'}})
 }}})
 const context={supabase,orgId:ORG,userId:ACTOR}
 const bindings={...lifecycle,z,requireOrgContext:async()=>context,requirePermission:async()=>{},getInspection:async()=>detail,requireAuthorization:async input=>{gates.push(input);if(denied)throw new Error('Home denied')}}
 return {...declarations('lib/services/inspections.ts',['listInspectionObligations','mutateInspectionObligation','completeInspection'],bindings),calls,gates}
}
test('original lifecycle service binds exact request actor/home and separates review authority',async()=>{
 for(const operation of ['create','accept']) {
  const h=service(),request={operation,inspectionId:INSP,source:lifecycle.inspectionReviewSource(detail),...(operation==='accept'?{obligationId:OBL,reviewNote:'Independent field evidence verified'}:{})}
  await h.mutateInspectionObligation(HOME,{key:id(100),request})
  assert.equal(h.calls[0].body.p_actor,ACTOR);assert.equal(h.calls[0].body.p_home,HOME);assert.equal(h.calls[0].body.p_org,ORG)
  assert.deepEqual(h.calls[0].body.p_request,request);assert.equal(h.calls[0].body.p_key,id(100))
  assert.equal(h.gates[0].permission,operation==='accept'?'inspection.review':'inspection.write')
 }
})
test('wrong source home and denied home do not reach mutation transport',async()=>{
 const input={key:id(100),request:{operation:'create',inspectionId:INSP,source:lifecycle.inspectionReviewSource(detail)}}
 for(const options of [{denied:true}]) {const h=service(options);await assert.rejects(h.mutateInspectionObligation(HOME,input));assert.equal(h.calls.length,0)}
 const h=service();await assert.rejects(h.mutateInspectionObligation(id(99),input),/another home/);assert.equal(h.calls.length,0)
})
test('discovery applies bounded cursor and selected-attempt lookup and rejects returned foreign scope',async()=>{
 const h=service({response:{rows:[],nextCursor:null}})
 await h.listInspectionObligations(HOME,id(100),undefined,INSP)
 assert.equal(h.calls[0].body.p_limit,20);assert.equal(h.calls[0].body.p_after,id(100));assert.equal(h.calls[0].body.p_inspection,INSP)
 const row={id:OBL,org_id:id(99),project_id:HOME,title:'Final',source_inspection_id:INSP,accepted_inspection_id:null,required_for_closing:true,created_at:'2026-10-04',attempt_count:1,attempts:[]}
 await assert.rejects(service({response:{rows:[row],nextCursor:null}}).listInspectionObligations(HOME),/scope differs/)
})
test('known PostgreSQL abort is distinguished from uncertain transport outcome',async()=>{
 const input={key:id(100),request:{operation:'create',inspectionId:INSP,source:lifecycle.inspectionReviewSource(detail)}}
 await assert.rejects(service({error:{code:'P0001',message:'Source changed'}}).mutateInspectionObligation(HOME,input),e=>e.code==='INSPECTION_NOT_COMMITTED')
 await assert.rejects(service({error:{code:'FETCH_ERROR',message:'Connection lost'}}).mutateInspectionObligation(HOME,input),e=>e.code===undefined)
})
function components(overrides={}) {
 const bindings={useRef:React.useRef,useState:React.useState,useTransition:React.useTransition,useRouter:()=>({push(){},refresh(){}}),inspectionReviewSource:lifecycle.inspectionReviewSource,inspectionItemNeedsCorrection:lifecycle.inspectionItemNeedsCorrection,toast:{success(){},error(){}},crypto:require('node:crypto'),...overrides}
 bindings.Button=function StubButton({children,...props}){return React.createElement('button',props,children)}
 bindings.Textarea=function StubTextarea(props){return React.createElement('textarea',{...props,readOnly:true})}
 bindings.Badge=function StubBadge({children}){return React.createElement('span',null,children)}
 bindings.Link=function StubLink({children,href}){return React.createElement('a',{href},children)}
 return declarations('components/inspections/inspection-lifecycle-controls.tsx',['InspectionLifecycleControls','InspectionObligationsPanel'],bindings)
}
const obligation={id:OBL,accepted_inspection_id:null,attempts:[{inspection_id:INSP,attempt_number:1,review_decision:null}],attempt_count:1}
test('actual workbench exposes only applicable writer/reviewer operations',()=>{
 const {InspectionLifecycleControls:C}=components()
 const html=props=>renderToStaticMarkup(React.createElement(C,{inspection:detail,obligation:null,canWrite:false,canReview:false,...props}))
 assert.doesNotMatch(html({}),/Require before closing<\/button>|Accept inspection<\/button>|Start reinspection<\/button>/)
 assert.match(html({canWrite:true}),/Require before closing<\/button>/)
 assert.match(html({canReview:true,obligation}),/Accept inspection<\/button>/)
 assert.doesNotMatch(html({canWrite:true,obligation}),/Accept inspection<\/button>|Start reinspection<\/button>/)
 assert.match(html({canWrite:true,obligation,inspection:{...detail,result:'fail'}}),/Start reinspection<\/button>/)
 assert.match(html({canWrite:true,obligation:{...obligation,attempts:[{...obligation.attempts[0],review_decision:'reject'}]}}),/Start reinspection<\/button>/)
 assert.doesNotMatch(html({canWrite:true,canReview:true,obligation:{...obligation,accepted_inspection_id:INSP}}),/<button/)
})
function find(node,label){if(!node)return null;if(Array.isArray(node)){for(const child of node){const found=find(child,label);if(found)return found}return null}if(typeof node!=='object')return null;if(node.props?.children===label&&node.props.onClick)return node;return find(node.props?.children,label)}
test('lost reply retains and retries exact original request despite refreshed source',async()=>{
 const state=[],refs=[];let index=0,refIndex=0,work,mode='uncertain';const requests=[]
 const {InspectionLifecycleControls:C}=components({useState:initial=>{const i=index++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=value}]},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial})},useTransition:()=>[false,fn=>{work=fn()}],mutateInspectionObligationAction:async(home,input)=>{requests.push(structuredClone(input));if(mode==='uncertain')throw new Error('Reply lost');return{success:true,data:{obligationId:OBL,inspectionId:INSP}}}})
 const render=inspection=>{index=0;refIndex=0;return C({inspection,obligation:null,canWrite:true,canReview:false})}
 find(render(detail),'Require before closing').props.onClick();await work
 mode='success';find(render({...detail,title:'New live title'}),'Retry same request').props.onClick();await work
 assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.equal(requests[0].request.source.title,'Final inspection');assert.equal(refs[0].current,null)
})

test('completion cutover calls the atomic owner without duplicate service-side event/schedule writes',async()=>{
 const h=service({response:{inspectionId:INSP,result:'pass',existing:true,awaitingReview:true}})
 const result=await h.completeInspection(INSP)
 assert.equal(result.id,INSP);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'complete_inspection_attempt')
 assert.deepEqual(h.calls[0].body.p_source,lifecycle.inspectionReviewSource(detail))
 assert.equal(h.calls[0].body.p_home,HOME);assert.equal(h.calls[0].body.p_actor,ACTOR)
 await assert.rejects(service({response:{inspectionId:id(999),result:'pass',existing:false,awaitingReview:true}}).completeInspection(INSP),/another attempt/)
})
test('completed deficiency rows retain evidence while corrective actions require write authority',()=>{
 const bindings={inspectionItemNeedsCorrection:lifecycle.inspectionItemNeedsCorrection,useState:React.useState,cn:(...parts)=>parts.filter(Boolean).join(' '),ItemDeficiencyPhoto:function StubPhoto(){return null}}
 for(const name of ['Badge','Select','SelectTrigger','SelectValue','SelectContent','SelectItem']) bindings[name]=function StubContainer({children}){return React.createElement('div',null,children)}
 bindings.Input=function StubInput({disabled,value}){return React.createElement('input',{disabled,value,readOnly:true})}
 bindings.Button=function StubButton({disabled,children}){return React.createElement('button',{disabled},children)}
 bindings.Link=function StubLink({href,children}){return React.createElement('a',{href},children)}
 const {InspectionItemRow:C}=declarations('app/(app)/projects/[id]/inspections/inspections-client.tsx',['InspectionItemRow'],bindings)
 const item={id:id(7),inspection_id:INSP,prompt:'Guardrail',response_type:'pass_fail',response:'fail',is_deficient:true,note:'Original failure',punch_item_id:null,observation_id:null}
 for(const canCreateCorrective of [false,true]) {
  const html=renderToStaticMarkup(React.createElement(C,{projectId:HOME,item,companies:[],readOnly:true,canCreateCorrective,pending:false,onPatch(){},submit(){},onItemUpdated(){}}))
  assert.equal(html.includes('Create punch item'),canCreateCorrective)
  assert.equal(html.includes('Create observation'),canCreateCorrective)
  assert.match(html,/<input disabled/)
 }
})
