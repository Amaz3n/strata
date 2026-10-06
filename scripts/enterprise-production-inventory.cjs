// Static evidence only. This command never authenticates, runs app code or touches a database.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const trackerPath = path.join(root, 'docs/enterprise-production/acceptance.json')
const mode = process.argv[2]
if (!['--refresh', '--check'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/enterprise-production-inventory.cjs --refresh|--check')
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function files(directory) {
  const absolute = path.join(root, directory)
  if (!fs.existsSync(absolute)) return []
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(directory, entry.name)
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : []
  }).sort()
}
function resolveImport(source, specifier) {
  const base = specifier.startsWith('@/') ? specifier.slice(2)
    : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)) : null
  if (!base) return null
  return [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs'].map(suffix => base + suffix)]
    .find(candidate => fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()) ?? null
}
function inspect(source) {
  const bytes = fs.readFileSync(path.join(root, source))
  const ast = ts.createSourceFile(source, bytes.toString(), ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error(`Cannot inventory malformed source: ${source}`)
  const imports = [], exports = [], permissionCalls = [], featureFlags = [], links = [], serverActionDirectives = []
  function inspectDirectives(statements, scope) {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
      if (statement.expression.text === 'use server') serverActionDirectives.push({ scope, line: ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line + 1 })
    }
  }
  inspectDirectives(ast.statements, 'module')
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body && ts.isBlock(node.body)) {
      inspectDirectives(node.body.statements, node.name?.getText(ast) ?? `function@${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      imports.push({ kind: 'import', specifier, path: resolveImport(source, specifier), typeOnly: node.importClause?.isTypeOnly ?? false,
        symbols: node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements.map(item => ({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, typeOnly: item.isTypeOnly })) : [] })
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      imports.push({ kind: 'reexport', specifier, path: resolveImport(source, specifier), typeOnly: node.isTypeOnly,
        symbols: node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map(item => ({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, typeOnly: item.isTypeOnly })) : [] })
    }
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) exports.push(node.name?.text ?? 'default')
    if (ts.isVariableStatement(node) && node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) exports.push(declaration.name.getText(ast))
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast)
      if (/^(requirePermission|hasPermission|requirePermissionWithClient|requirePermissionGuard)$/.test(name)) permissionCalls.push({ helper: name, permission: node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : null,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
      if (name === 'requireAnyPermission' || name === 'hasAnyPermission' || name === 'requireAnyPermissionGuard' || name === 'requireAnyPlatformPermission' || name === 'hasAnyPlatformPermission') permissionCalls.push({ helper: name, permission: null,
        permissionOptions: node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0]) ? node.arguments[0].elements.map(item => ts.isStringLiteral(item) ? item.text : null) : null,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
      if (name === 'requireProjectPermission' || name === 'hasProjectPermission') permissionCalls.push({ helper: name, permission: node.arguments[2] && ts.isStringLiteral(node.arguments[2]) ? node.arguments[2].text : null,
        projectExpression: node.arguments[1]?.getText(ast) ?? null, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
      if (name === 'requireAuthorization' || name === 'authorize') {
        const options = node.arguments[0]
        const permission = options && ts.isObjectLiteralExpression(options) ? options.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === 'permission') : null
        permissionCalls.push({ helper: name, permission: permission && ts.isStringLiteral(permission.initializer) ? permission.initializer.text : null, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const specifier = node.arguments[0].text
        imports.push({ kind: 'dynamic-import', specifier, path: resolveImport(source, specifier), typeOnly: false, symbols: [] })
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'process.env' && node.name.text.startsWith('ARC_')) featureFlags.push(node.name.text)
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'href' && node.initializer && ts.isStringLiteral(node.initializer)) links.push(node.initializer.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { path: source, sha256: hash(bytes), imports, exportedFunctions: exports, directPermissionCalls: permissionCalls,
    serverActionDirectives, featureFlags: [...new Set(featureFlags)].sort(), literalLinks: [...new Set(links)].sort() }
}
const trackerBytes = fs.readFileSync(trackerPath)
const tracker = JSON.parse(trackerBytes)
const inventory = tracker.baselineInventory
if (!inventory || !Array.isArray(inventory.surfaceCandidates)) throw new Error('Canonical baseline inventory is missing')
// Route layouts and boundaries run outside page imports; actions are exposed by directives.
const appSourceFacts = new Map(files('app').filter(source => /\.(?:[jt]sx?|[cm]js)$/.test(source)).map(source => [source, inspect(source)]))
const surfaceFiles = [...appSourceFacts].filter(([source, facts]) => /\/(?:page|route|actions|layout|template|error|global-error|not-found|global-not-found|loading|default)\.(?:[jt]sx?)$/.test(source) || facts.serverActionDirectives.length > 0).map(([source]) => source)
const modulePaths = new Set(surfaceFiles)
const modules = new Map()
// Follow local imports, including type declarations, without executing any module.
for (const source of modulePaths) {
  const facts = appSourceFacts.get(source) ?? inspect(source)
  modules.set(source, facts)
  for (const dependency of facts.imports) if (dependency.path && /\.(?:[jt]sx?|[cm]js)$/.test(dependency.path)) modulePaths.add(dependency.path)
}
const nativeFiles = files('ios/Arc').filter(source => source.endsWith('.swift'))
const nativePrevious = new Map((inventory.nativeSourceRegister ?? []).map(item => [item.path, item]))
const previous = new Map(inventory.surfaceCandidates.map(item => [item.path, item]))
const drift = surfaceFiles.filter(source => previous.get(source)?.sourceSha256 !== modules.get(source).sha256)
const missing = [...previous.keys()].filter(source => !surfaceFiles.includes(source))
const unmapped = surfaceFiles.filter(source => !previous.get(source)?.taskIds?.length)
const unaccepted = surfaceFiles.filter(source => !previous.get(source)?.accepted)
const validTaskIds = new Set(tracker.taskContracts.flatMap(item => [item.id, ...(item.children ?? []).map(child => child.id)]))
const invalidTaskMappings = inventory.surfaceCandidates.filter(item => item.taskIds?.some(id => !validTaskIds.has(id))).map(item => item.path)
const graphPrevious = new Map((inventory.sourceModules ?? []).map(item => [item.path, item.sha256]))
const dependencyDrift = [...modules.values()].filter(item => graphPrevious.get(item.path) !== item.sha256).map(item => item.path)
const dependencyRemoved = [...graphPrevious.keys()].filter(source => !modules.has(source))
const unresolvedLocalImports = [...modules.values()].flatMap(item => item.imports.filter(dependency => dependency.path === null && (dependency.specifier.startsWith('@/') || dependency.specifier.startsWith('.'))).map(dependency => ({ source: item.path, specifier: dependency.specifier })))
if (mode === '--check') {
  const nativeDrift = nativeFiles.filter(source => nativePrevious.get(source)?.sha256 !== hash(fs.readFileSync(path.join(root, source))))
  const nativeUnmapped = nativeFiles.filter(source => !nativePrevious.get(source)?.taskIds?.length)
  const nativeUnaccepted = nativeFiles.filter(source => !nativePrevious.get(source)?.accepted)
  const nativeMissing = [...nativePrevious.keys()].filter(source => !nativeFiles.includes(source))
  const unresolvedRemoved = (inventory.removedSurfaceCandidates ?? []).filter(item => !item.removalReconciled).map(item => item.path)
  const unresolvedNativeRemoved = (inventory.removedNativeSources ?? []).filter(item => !item.removalReconciled).map(item => item.path)
  console.log(JSON.stringify({ mode, surfaces: surfaceFiles.length, sourceModules: modules.size, nativeFiles: nativeFiles.length,
    drift, dependencyDrift, dependencyRemoved, unresolvedLocalImports, nativeDrift, nativeMissing, nativeUnmapped, nativeUnaccepted, missing, unmapped, unaccepted, invalidTaskMappings, unresolvedRemoved, unresolvedNativeRemoved,
    limit: 'Static register consistency is not runtime/JWT/RLS, persona, concurrency or release acceptance.' }, null, 2))
  if ([drift, dependencyDrift, dependencyRemoved, unresolvedLocalImports, nativeDrift, nativeMissing, nativeUnmapped, nativeUnaccepted, missing, unmapped, unaccepted, invalidTaskMappings, unresolvedRemoved, unresolvedNativeRemoved].some(items => items.length)) process.exitCode = 1
} else {
  inventory.surfaceCandidates = surfaceFiles.map(source => {
    const facts = modules.get(source), prior = previous.get(source)
    return { ...(prior ?? { path: source, productionExposure: 'unassessed', taskIds: [], personaScopeAuthorization: 'unassessed', classification: 'unassessed', accepted: false }),
      kind: /\/page\.[jt]sx?$/.test(source) ? 'page' : /\/route\.[jt]s$/.test(source) ? 'api' : facts.serverActionDirectives.length || /\/actions\.[jt]sx?$/.test(source) ? 'actions' : 'route_boundary',
      sourceSha256: facts.sha256, sourceFacts: facts,
      accepted: prior?.accepted === true && prior.sourceSha256 === facts.sha256 && dependencyDrift.length === 0 && dependencyRemoved.length === 0 && unresolvedLocalImports.length === 0,
      sourceChangedSinceLastRegister: !!prior && prior.sourceSha256 !== facts.sha256 }
  })
  // Keep removed entries as evidence instead of erasing their historical mapping.
  inventory.removedSurfaceCandidates = [...(inventory.removedSurfaceCandidates ?? []), ...missing.map(source => ({ ...previous.get(source), accepted: false, missingFromSource: true }))]
  inventory.sourceModules = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path))
  inventory.unresolvedLocalImports = unresolvedLocalImports
  inventory.removedNativeSources = [...(inventory.removedNativeSources ?? []), ...[...nativePrevious.keys()].filter(source => !nativeFiles.includes(source)).map(source => ({ ...nativePrevious.get(source), accepted: false, missingFromSource: true }))]
  inventory.nativeSourceRegister = nativeFiles.map(source => {
    const prior = nativePrevious.get(source), sha256 = hash(fs.readFileSync(path.join(root, source)))
    return { ...(prior ?? { path: source, taskIds: [], classification: 'unassessed' }), sha256,
      accepted: prior?.accepted === true && prior.sha256 === sha256 && dependencyDrift.length === 0 && dependencyRemoved.length === 0 && unresolvedLocalImports.length === 0 }
  })
  inventory.staticRegisterCommand = 'node scripts/enterprise-production-inventory.cjs --check'
  inventory.staticRegisterLimits = ['Imports and direct declarations only; dynamic registrations and indirect authorization require review.',
    'Refresh never marks a surface accepted. Source/dependency drift reopens prior acceptance conservatively.',
    'All app surfaces remain candidates until their production/public/platform scope is reconciled. Swift enumeration alone does not establish native exposure.']
  tracker.executionLog.push({ date: new Date().toISOString().slice(0, 10), slice: 'F01.C01: static source register refreshed', command: 'node scripts/enterprise-production-inventory.cjs --refresh',
    surfaces: surfaceFiles.length, sourceModules: modules.size, nativeFiles: nativeFiles.length, changedSurfaces: drift, removedSurfaces: missing,
    implementationAcceptance: false, releaseAcceptance: false })
  // Fail on concurrent tracker mutation; use fsync and atomic replacement so ENOSPC cannot truncate history.
  if (!fs.readFileSync(trackerPath).equals(trackerBytes)) throw new Error('Tracker changed concurrently; re-read before refreshing')
  const temporary = `${trackerPath}.inventory-${process.pid}`
  let fd
  try {
    fd = fs.openSync(temporary, 'wx')
    fs.writeFileSync(fd, JSON.stringify(tracker, null, 2) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    JSON.parse(fs.readFileSync(temporary))
    if (!fs.readFileSync(trackerPath).equals(trackerBytes)) throw new Error('Tracker changed during refresh; retry with current evidence')
    fs.renameSync(temporary, trackerPath)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
  console.log(JSON.stringify({ mode, surfaces: surfaceFiles.length, sourceModules: modules.size, nativeFiles: nativeFiles.length, acceptedByThisCommand: 0 }))
}
