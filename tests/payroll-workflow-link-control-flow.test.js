const assert=require("node:assert/strict")
const fs=require("node:fs")
const test=require("node:test")
const ts=require("typescript")
const {redirect,notFound}=require("next/navigation")
const {unstable_rethrow}=require("next/dist/client/components/unstable-rethrow")
const {DynamicServerError}=require("next/dist/client/components/hooks-server-context")
function thrown(callback){try{callback()}catch(error){return error}throw Error("Expected control-flow error")}
function load({failure,enabled=true,at="authorization"}={}){
  const exports={},calls=[]
  const code=ts.transpileModule(fs.readFileSync("components/time/payroll-correction-workflow-link.tsx","utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
  const modules={
    "next/navigation":{unstable_rethrow},
    "@/lib/services/context":{requireOrgContext:async()=>({orgId:"org",userId:"actor",supabase:{}})},
    "@/lib/services/books/access":{requireBooksAuthorization:async input=>{calls.push(input);if(failure&&at==="authorization")throw failure}},
    "@/lib/services/books/module":{isBooksWorkspaceEnabled:async orgId=>{calls.push(orgId);if(failure&&at==="module")throw failure;return enabled}},
  }
  new Function("exports","require",code)(exports,name=>name==="react/jsx-runtime"?require(name):modules[name]??new Proxy({},{get:()=>()=>null}))
  return {render:()=>exports.PayrollCorrectionWorkflowLink({projectId:"project"}),calls}
}
test("payroll workflow links retain fresh authorization and hide ordinary denials",async()=>{
  const allowed=load(),tree=await allowed.render()
  assert.equal(allowed.calls[0].permission,"books.adjust")
  assert.equal(allowed.calls[0].orgId,"org")
  assert.equal(allowed.calls[1],"org")
  assert.equal(tree.props.children.props.children.props.href,"/projects/project/time/payroll")
  assert.equal(await load({enabled:false}).render(),null)
  const denied=load({failure:Error("Denied")})
  assert.equal(await denied.render(),null)
  assert.equal(denied.calls.length,1)
})
for(const at of ["authorization","module"]){
  test(`payroll workflow ${at} fallback propagates framework control flow`,async()=>{
    const redirectError=thrown(()=>redirect("/auth/signin"))
    for(const failure of [redirectError,thrown(notFound),new DynamicServerError("Interrupted rendering"),Error("Wrapped",{cause:redirectError})]){
      await assert.rejects(load({failure,at}).render(),error=>error===failure||error===failure.cause)
    }
  })
}
