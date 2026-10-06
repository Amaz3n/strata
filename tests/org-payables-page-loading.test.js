const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture({ failAt } = {}) {
  const calls = [], connection = deferred(), data = deferred(), rail = deferred(), permission = deferred(), failure = new Error("Payment read failed")
  const modules = {
    "next/server": { connection: () => connection.promise },
    "@/lib/services/context": { requireOrgContext: async () => { calls.push("context"); return {orgId:"org",userId:"viewer"} } },
    "@/lib/services/production-desk-scope": { resolveProductionDeskScope: async () => { calls.push("scope"); return {projectIds:["one"],communities:[],communityId:"community"} } },
    "@/lib/financials/payables-book": { parsePayablesBookQuery: params => ({queue:params.queue}) },
    "@/lib/services/org-payables": { loadOrgPayablesDesk: (...args) => { calls.push(["register", ...args]); return data.promise } },
    "@/lib/services/payment-rail-setup": { isVendorPayoutSetupOpen: id => { calls.push(["rail",id]); return rail.promise } },
    "@/lib/services/permissions": { hasAnyPermission: async permissions => { calls.push(["permission",permissions]); return permission.promise } },
    "@/lib/services/payment-approvers": { getPaymentApprovalRouting: async id => { calls.push(["routing",id]); if(failAt==="routing") throw failure; return {viewerMayApprove:true,approvers:[{id:"approver"}]} } },
    "@/lib/services/payment-risk": { listBlockedPaymentRuns: async () => { calls.push("blocked"); if(failAt==="risk") throw failure; return [{id:"blocked"}] } },
    "@/lib/services/payment-runs": { listPaymentRuns: async () => { calls.push("approvals"); if(failAt==="approvals") throw failure; return [{id:"pending",status:"pending_approval",can_approve:true},{id:"denied",status:"pending_approval",can_approve:false},{id:"done",status:"submitted",can_approve:true}] } },
  }
  const code = ts.transpileModule(fs.readFileSync("app/(app)/payables/page.tsx", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaf)
  const params = {community:"community",q:"fixture",page:"2",pageSize:"50",bill:"bill",queue:"active"}
  const shell = exports.default({searchParams:Promise.resolve(params)})
  return {calls,connection,data,rail,permission,failure,shell,result:shell.props.children.type(shell.props.children.props)}
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test("payables exposes a titled shell and keeps financial reads behind a live connection", async () => {
  const f = fixture()
  assert.equal(f.shell.type, React.Suspense)
  assert.equal(f.shell.props.fallback.props.title,"Payables")
  await tick()
  assert.deepEqual(f.calls,[])
  f.connection.resolve(); f.rail.resolve(false); f.data.resolve({rows:[]})
  await f.result
})
for (const allowed of [true,false]) {
  test(`payment routing and approvals overlap the pending register while risk permission is ${allowed ? "granted" : "denied"}`, async () => {
    const f = fixture()
    f.connection.resolve()
    await tick()
    assert.deepEqual(f.calls.find(call=>Array.isArray(call)&&call[0]==="register").slice(1), [["one"],{queue:"active",search:"fixture",page:2,pageSize:50,billId:"bill"}])
    f.rail.resolve(true)
    await tick()
    assert.ok(f.calls.includes("approvals"))
    assert.ok(f.calls.some(call=>Array.isArray(call)&&call[0]==="routing"))
    assert.equal(f.calls.includes("blocked"),false,"risk data must wait for permission")
    f.permission.resolve(allowed)
    await tick()
    assert.equal(f.calls.includes("blocked"),allowed)
    f.data.resolve({rows:[]})
    const desk = (await f.result).props.children[1]
    assert.deepEqual(desk.props.approvalRuns,[{id:"pending",status:"pending_approval",can_approve:true}])
    assert.deepEqual(desk.props.blockedRuns,allowed?[{id:"blocked"}]:[])
    assert.equal(desk.props.viewerMayApproveRuns,true)
    assert.equal(desk.props.approvalViewer.userId,"viewer")
  })
}
test("disabled payment setup skips routing, approval and risk reads", async () => {
  const f = fixture()
  f.connection.resolve(); f.rail.resolve(false); f.data.resolve({rows:[]})
  const desk = (await f.result).props.children[1]
  assert.equal(desk.props.railOpen,false)
  assert.deepEqual(desk.props.approvalRuns,[])
  assert.equal(f.calls.includes("approvals"),false)
  assert.equal(f.calls.includes("blocked"),false)
  assert.equal(f.calls.some(call=>Array.isArray(call)&&["routing","permission"].includes(call[0])),false)
})
for (const failAt of ["risk","approvals"]) {
  test(`failed ${failAt} reads reach the error boundary instead of an empty queue`, async () => {
    const f = fixture({failAt}), rejected = assert.rejects(f.result,error=>error===f.failure)
    f.connection.resolve(); f.rail.resolve(true); f.permission.resolve(true); f.data.resolve({rows:[]})
    await rejected
  })
}
test("optional approval routing failure retains the existing fallback without suppressing queues", async () => {
  const f = fixture({failAt:"routing"})
  f.connection.resolve(); f.rail.resolve(true); f.permission.resolve(true); f.data.resolve({rows:[]})
  const desk = (await f.result).props.children[1]
  assert.equal(desk.props.viewerMayApproveRuns,false)
  assert.deepEqual(desk.props.approvalViewer.approvers,[])
  assert.equal(desk.props.approvalRuns.length,1)
  assert.equal(desk.props.blockedRuns.length,1)
})
test("risk permission lookup failures do not expose a queue or render it as empty", async () => {
  const f = fixture(), failure = new Error("Permission unavailable")
  const rejected = assert.rejects(f.result,error=>error===failure)
  f.connection.resolve(); f.rail.resolve(true); f.permission.reject(failure); f.data.resolve({rows:[]})
  await rejected
  assert.equal(f.calls.includes("blocked"),false)
})
