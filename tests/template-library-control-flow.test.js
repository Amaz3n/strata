const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const { redirect, notFound } = require("next/navigation")
const { unstable_rethrow } = require("next/dist/client/components/unstable-rethrow")
const { DynamicServerError } = require("next/dist/client/components/hooks-server-context")

function thrownBy(callback) {
  try { callback() } catch (error) { return error }
  throw Error("Expected a Next.js control-flow error")
}
async function render(section, failure) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync("app/(app)/settings/templates/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const modules = {
    "next/server": { connection: async () => {} },
    "next/navigation": { unstable_rethrow },
    "./sections": { resolveTemplateSection: value => value },
    "@/lib/services/budget-templates": { listBudgetTemplates: async () => { if (failure) throw failure; return [] } },
    "@/lib/services/schedule": { listTemplates: async () => { if (failure) throw failure; return [] } },
    "../cost-codes/actions": { listCostCodesAction: async () => [] },
  }
  new Function("exports", "require", code)(exports, name => {
    if (["react", "react/jsx-runtime"].includes(name)) return require(name)
    return modules[name] ?? new Proxy({}, { get: () => () => null })
  })
  const shell = exports.default({ searchParams: Promise.resolve({ section }) })
  assert.equal(shell.type, React.Suspense)
  const content = shell.props.children
  const library = await content.type(content.props)
  return library.type(library.props)
}
for (const section of ["budgets", "schedules"]) {
  test(`${section} keeps genuine empty results and propagates library failures and Next.js control flow`, async () => {
    assert.deepEqual((await render(section)).props.initialTemplates, [])
    const unavailable = Error("Library unavailable")
    await assert.rejects(render(section, unavailable), error => error === unavailable)
    const redirectError = thrownBy(() => redirect("/auth/signin"))
    for (const failure of [redirectError, thrownBy(notFound), new DynamicServerError("Interrupted prefetch"), Error("Wrapped redirect", { cause: redirectError })]) {
      await assert.rejects(render(section, failure), error => error === failure || error === failure.cause)
    }
  })
}

test('the template error boundary provides retry without showing database or authorization internals', () => {
  const exports = {}, code = ts.transpileModule(fs.readFileSync('app/(app)/settings/templates/error.tsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function('exports', 'require', code)(exports, name => name === 'react/jsx-runtime' ? require(name) : { Button: 'button' })
  let retried = false
  const tree = exports.default({ error: Error('private schema details'), retry: () => { retried = true } })
  const content = tree.props.children, button = React.Children.toArray(content.props.children).find(node => node.type === 'button')
  assert.equal(button.props.children, 'Try again')
  button.props.onClick()
  assert.equal(retried, true)
  assert.ok(!JSON.stringify(tree).includes('private schema details'))
})
