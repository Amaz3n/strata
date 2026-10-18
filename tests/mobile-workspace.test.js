const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
const source = fs.readFileSync(require('node:path').join(__dirname, '../lib/mobile/workspace-catalog.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleRecord = { exports: {} }
const fieldSource = fs.readFileSync(require('node:path').join(__dirname, '../lib/mobile/workspace-estimate-fields.ts'), 'utf8')
const fieldCode = ts.transpileModule(fieldSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const fieldModule = { exports: {} }
Function('exports', 'module', fieldCode)(fieldModule.exports, fieldModule)
Function('exports', 'require', 'module', compiled)(moduleRecord.exports, id => {
  if (id === '@/lib/mobile/workspace-estimate-fields') return fieldModule.exports
  return require(id)
}, moduleRecord)
const { workspaceModules, workspaceRecord, projectModuleVisible } = moduleRecord.exports

test('native details project only explicitly allowed fields', () => {
  const workspaceModule = workspaceModules.find(m => m.id === 'tasks')
  const record = workspaceRecord(workspaceModule, { id: 't1', title: 'Inspect roof', description: 'North wing', status: 'todo', org_id: 'secret', metadata: { private: true }, access_token: 'secret' }, 0)
  assert.equal(record.title, 'Inspect roof')
  assert.equal(record.fields.find(f => f.key === 'description').value, 'North wing')
  assert.ok(!JSON.stringify(record).includes('secret'))
})

test('native projection handles camel case service DTOs without losing dates', () => {
  const workspaceModule = workspaceModules.find(m => m.id === 'ledger')
  const record = workspaceRecord(workspaceModule, { id: 'j1', entryKind: 'adjustment', entryDate: '2026-10-01', memo: 'Correction' }, 0)
  assert.equal(record.fields.find(f => f.key === 'entry_date').value, '2026-10-01')
  assert.equal(record.fields.find(f => f.key === 'entry_kind').value, 'adjustment')
})

test('project posture, phase and explicit module overrides are respected', () => {
  const meetings = workspaceModules.find(m => m.id === 'meetings')
  assert.equal(projectModuleVisible(meetings, 'residential', 'construction'), false)
  assert.equal(projectModuleVisible(meetings, 'commercial', 'construction'), true)
  assert.equal(projectModuleVisible(meetings, 'commercial', 'construction', { meetings: false }), false)
  assert.equal(projectModuleVisible(meetings, 'residential', 'construction', { meetings: true }), true)
  assert.equal(projectModuleVisible(meetings, 'commercial', 'precon'), false)
})

test('budget values use the cents returned by the budget service', () => {
  const workspaceModule = workspaceModules.find(m => m.id === 'budget')
  const record = workspaceRecord(workspaceModule, { id: 'b1', description: 'Concrete', amount_cents: 12345 }, 0)
  assert.equal(record.fields.find(f => f.key === 'amount_cents').value, '12345')
})
