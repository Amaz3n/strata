require('../../scripts/register-ts-node-test')
const fs = require('node:fs'), ts = require('typescript')
function loadOwner(file, overrides = {}) {
  const source = fs.readFileSync(file, 'utf8'), modules = { react: require('react'), zod: require('zod'), crypto: require('node:crypto'), 'node:crypto': require('node:crypto') }
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const name = match[1]
    if (/^@\/lib\/(financials\/|product-tier$|receivables\/|validation\/)/.test(name)) modules[name] = require('../../' + name.slice(2))
    else if (!(name in modules)) modules[name] = {}
  }
  Object.assign(modules, overrides)
  const exports = {}
  new Function('exports', 'require', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(exports, name => {
    if (name in modules) return modules[name]
    throw Error('Unstubbed dependency: ' + name)
  })
  return exports
}
function preparationOwner() {
  return loadOwner('lib/services/reservation-conversion.ts', {
    '@/lib/services/projects': loadOwner('lib/services/projects.ts'),
    '@/lib/services/project-financial-setup': loadOwner('lib/services/project-financial-setup.ts'),
    '@/lib/services/invoices': loadOwner('lib/services/invoices.ts'),
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { throw Error('Pure preparation cannot call a privileged client') } },
  })
}
module.exports = { loadOwner, preparationOwner }
