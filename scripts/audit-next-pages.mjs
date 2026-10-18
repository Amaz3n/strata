import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const root = process.cwd(), app = path.join(root, "app"), modules = new Map()
const relative = file => path.relative(root, file).split(path.sep).join("/")
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file) : entry.name === "page.tsx" ? [file] : []
  })
}
function componentFile(importer, specifier) {
  const base = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(importer), specifier) : null
  if (!base) return null
  return [base, `${base}.tsx`, path.join(base, "index.tsx")].find(file => file.endsWith(".tsx") && existsSync(file)) ?? null
}
function inspect(file) {
  if (modules.has(file)) return modules.get(file)
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result = { client: false, asyncFunctions: [], connectionCalls: 0, cacheDirectives: [], suspenseElements: 0, componentImports: [] }
  modules.set(file, result)
  function visit(node) {
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)) {
      if (node.parent === source && node.expression.text === "use client") result.client = true
      if (node.expression.text.startsWith("use cache")) result.cacheDirectives.push(node.expression.text)
    }
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) result.asyncFunctions.push(node.name?.text ?? "default")
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "connection") result.connectionCalls++
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "Suspense") result.suspenseElements++
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const dependency = componentFile(file, node.moduleSpecifier.text)
      if (dependency) result.componentImports.push(dependency)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
function reachable(file, visited = new Set()) {
  if (visited.has(file)) return visited
  visited.add(file)
  for (const dependency of inspect(file).componentImports) reachable(dependency, visited)
  return visited
}
const pages = files(app).sort().map(file => {
  const direct = inspect(file), componentSources = [...reachable(file)]
  const loadingBoundaries = []
  for (let directory = path.dirname(file); directory.startsWith(`${app}${path.sep}`) || directory === app; directory = path.dirname(directory)) {
    const loading = path.join(directory, "loading.tsx")
    if (existsSync(loading)) loadingBoundaries.push(relative(loading))
  }
  return {
    page: relative(file), client: direct.client, asyncFunctions: direct.asyncFunctions,
    directConnectionCalls: direct.connectionCalls, directCacheDirectives: direct.cacheDirectives,
    directSuspenseElements: direct.suspenseElements, loadingBoundaries,
    importedComponentBoundarySources: componentSources.filter(source => inspect(source).connectionCalls || inspect(source).cacheDirectives.length).map(relative),
    componentSources: componentSources.map(relative),
  }
})
const report = {
  scope: "All app/page.tsx files and their local TSX import/export graph. Import reachability identifies review candidates, not proof that a boundary executes on a rendered path. Library TS code, ancestor layouts, runtime behavior and business correctness require separate review.",
  nextVersion: JSON.parse(readFileSync(path.join(root, "node_modules/next/package.json"), "utf8")).version,
  pageCount: pages.length, pages,
}
const outputIndex = process.argv.indexOf("--out")
if (outputIndex !== -1) {
  const output = process.argv[outputIndex + 1]
  if (!output) throw Error("--out requires a filename")
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify({ pageCount: pages.length, nextVersion: report.nextVersion, clientPages: pages.filter(page => page.client).length, pagesWithDirectConnection: pages.filter(page => page.directConnectionCalls).length, pagesWithDirectCache: pages.filter(page => page.directCacheDirectives.length).length, importedTsxSources: modules.size }))
