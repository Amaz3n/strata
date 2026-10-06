const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

function load(file, modules = {}) {
  const exports = {}, leaves = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
  return exports
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const cases = [["d", "Document signing"], ["e", "Estimate"], ["f", "Shared file"], ["i", "Invoice"], ["t", "Time and materials ticket"], ["b", "Bid invitation"], ["proposal", "Proposal"]]
for (const [route, title] of cases) {
  test(`${title} exposes a neutral shell and waits for a live request before token work`, async () => {
    const live = deferred(), calls = []
    const page = load(`app/${route}/[token]/page.tsx`, { "next/server": { connection: () => { calls.push("live"); return live.promise } } }).default
    const props = { params: Promise.resolve({ token: "private-token" }), searchParams: Promise.resolve({}) }
    const shell = page(props)
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    assert.equal(JSON.stringify(shell.props.fallback.props).includes("private-token"), false)
    assert.deepEqual(calls, [])
    const content = shell.props.children
    let contentParamReads = 0
    const contentProps = { ...content.props, params: { then(resolve) { contentParamReads++; resolve({ token: "private-token" }) } } }
    const result = content.type(contentProps)
    const failure = new Error("Request aborted"), rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    assert.equal(contentParamReads, 0, "no token or lookup is consumed while prefetch is suspended")
    live.reject(failure); await rejected
  })
}

test("a named public skeleton visibly identifies its destination and announces loading", () => {
  const { PageLoadingSkeleton } = load("components/layout/page-loading-skeleton.tsx", { "@/components/ui/skeleton": { Skeleton: props => React.createElement("div", props) } })
  const html = renderToStaticMarkup(React.createElement(PageLoadingSkeleton, { title: "Invoice" }))
  assert.match(html, /role="status"/)
  assert.match(html, /aria-label="Loading Invoice"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /<h1[^>]*>Invoice<\/h1>/)
  const legacy = renderToStaticMarkup(React.createElement(PageLoadingSkeleton))
  assert.match(legacy, /aria-label="Loading page"/)
  assert.doesNotMatch(legacy, /<h1/)
})

for (const [route, moduleName, lookup, audit] of [
  ["i", "@/lib/services/invoices", "getInvoiceByToken", "recordInvoiceViewed"],
  ["f", "@/lib/services/file-share-links", "getFileShareLinkByToken", "recordShareLinkView"],
]) {
  test(`${route} keeps invalid tokens as 404s without recording a view`, async () => {
    const live = deferred(), calls = []
    const page = load(`app/${route}/[token]/page.tsx`, {
      "next/server": { connection: () => live.promise },
      "next/navigation": { notFound: () => { throw new Error("404") } },
      [moduleName]: { [lookup]: async token => { calls.push(["lookup", token]); return null }, [audit]: async () => { calls.push("audit") } },
    }).default
    const content = page({ params: Promise.resolve({ token: "invalid" }) }).props.children
    const result = content.type(content.props), rejected = assert.rejects(result, /404/)
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [])
    live.resolve(); await rejected
    assert.deepEqual(calls, [["lookup", "invalid"]])
  })
}
