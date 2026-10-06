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
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(view = "lost") {
  const calls = [], connected = deferred(), ambient = deferred(), deals = deferred(), roster = deferred(), reasons = deferred()
  const modules = {
    "next/server": { connection: () => connected.promise },
    "@/lib/services/desk-context": { getAmbientDeskContext: () => { calls.push("scope"); return ambient.promise } },
    "@/lib/services/team": { listTeamMembers: (...args) => { calls.push(["team",...args]); return roster.promise } },
    "@/lib/services/sales-deals": { listSalesDeals: params => { calls.push(["deals",params]); return deals.promise }, listLostReasons: ids => { calls.push(["reasons",ids]); return reasons.promise } },
    "@/lib/sales/board": { isDealView: value => ["open","lost","won"].includes(value) },
    "@/lib/sales/next-action": { isDealFilter: () => false },
  }
  const code = ts.transpileModule(fs.readFileSync("app/(app)/sales/page.tsx", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaf)
  const shell = exports.default({searchParams:Promise.resolve({view})})
  const content = shell.props.children.type(shell.props.children.props)
  const result = content.then(tree => tree.props.children.props.children.type(tree.props.children.props.children.props))
  return { calls, connected, ambient, deals, roster, reasons, shell, result }
}
const scope = {divisionId:"division",communityId:"community",communities:[{id:"community",name:"Fixture community"}]}
const rows = [{id:"lost",stage:"lost",prospectId:"prospect"},{id:"open",stage:"new_inquiry",prospectId:"other"},{id:"no-prospect",stage:"lost",prospectId:null}]
test("sales renders a titled shell before any live board reads begin", async () => {
  const f = fixture()
  assert.equal(f.shell.type,React.Suspense)
  assert.equal(f.shell.props.fallback.props.title,"Sales")
  await tick()
  assert.deepEqual(f.calls,[])
  f.connected.resolve(); f.ambient.resolve(scope); f.deals.resolve([]); f.roster.resolve([]); f.reasons.resolve(new Map())
  await f.result
})
test("sales roster starts before ambient scope resolves, and lost reasons start before the roster resolves", async () => {
  const f = fixture()
  f.connected.resolve()
  await tick()
  assert.deepEqual(f.calls,["scope",["team",undefined,{includeProjectCounts:false}]])
  f.ambient.resolve(scope)
  await tick()
  assert.deepEqual(f.calls.at(-1),["deals",{divisionId:"division",communityId:"community",includeClosed:true,limit:500}])
  f.deals.resolve(rows)
  await tick()
  assert.deepEqual(f.calls.at(-1),["reasons",["prospect"]])
  f.reasons.resolve(new Map([["prospect","Timing"]]))
  f.roster.resolve([{user:{id:"owner",full_name:"Fixture owner"}}])
  const board = await f.result
  assert.deepEqual(board.props.owners,{owner:"Fixture owner"})
  assert.deepEqual(board.props.lostReasons,{prospect:"Timing"})
  assert.deepEqual(board.props.communities,[{id:"community",name:"Fixture community"}])
  assert.equal(board.props.actions.props.defaultCommunityId,"community")
  assert.deepEqual(board.props.actions.props.teamMembers,[{id:"owner",name:"Fixture owner"}])
  assert.ok(board.props.now instanceof Date)
})
for (const view of ["open","won"]) {
  test(`${view} sales views skip lost-reason reads and retain the closed-deal selection`, async () => {
    const f = fixture(view)
    f.connected.resolve(); f.ambient.resolve(scope); f.deals.resolve(rows); f.roster.resolve([])
    const board = await f.result
    assert.deepEqual(board.props.lostReasons,{})
    assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==="reasons"),false)
    assert.equal(f.calls.find(call=>Array.isArray(call)&&call[0]==="deals")[1].includeClosed,view!=="open")
  })
}
test("optional roster failures retain deals and lost reasons", async () => {
  const f = fixture()
  f.connected.resolve(); f.ambient.resolve(scope); f.deals.resolve(rows); f.roster.reject(new Error("Roster unavailable")); f.reasons.resolve(new Map([["prospect","Timing"]]))
  const board = await f.result
  assert.deepEqual(board.props.owners,{})
  assert.deepEqual(board.props.lostReasons,{prospect:"Timing"})
  assert.deepEqual(board.props.actions.props.teamMembers,[])
})
for (const source of ["ambient","deals","reasons"]) {
  test(`sales ${source} failures retain their error state`, async () => {
    const f = fixture(), failure = new Error(`${source} unavailable`)
    const rejected = assert.rejects(f.result,error=>error===failure)
    f.connected.resolve(); f.roster.resolve([])
    for (const [name,value] of [["ambient",scope],["deals",rows],["reasons",new Map()]]) {
      if (source===name) { f[name].reject(failure); break }
      f[name].resolve(value)
    }
    await rejected
    if(source==="ambient") assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==="deals"),false)
    if(source!=="reasons") assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==="reasons"),false)
  })
}
