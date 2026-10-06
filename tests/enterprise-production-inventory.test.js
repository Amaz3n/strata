const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync('scripts/enterprise-production-inventory.cjs', 'utf8')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-inventory-contract-'))
  function write(name, content) {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const tracker = 'docs/enterprise-production/acceptance.json'
  write(tracker, JSON.stringify({ taskContracts: [{ id: 'F01', children: [] }], executionLog: [{ slice: 'preserved' }], baselineInventory: { surfaceCandidates: [] } }))
  write('app/(app)/sales/page.tsx', 'import { load } from "@/lib/services/sales"; export default async function Page() { return load() }')
  write('lib/services/sales.ts', 'export async function load() { await requirePermission("sales.read"); return process.env.ARC_SALES_ENABLED }')
  write('ios/Arc/HomeView.swift', 'struct HomeView {}')
  const read = () => JSON.parse(fs.readFileSync(path.join(root, tracker), 'utf8'))
  const save = value => write(tracker, JSON.stringify(value))
  function run(mode, filesystem = fs) {
    const output = [], processState = { argv: ['node', 'inventory', mode], pid: process.pid, exitCode: 0 }
    vm.runInNewContext(source, { __dirname: path.join(root, 'scripts'), require(name) { return name === 'node:fs' ? filesystem : require(name) }, process: processState, console: { log: value => output.push(JSON.parse(value)) } })
    return { output: output.at(-1), exitCode: processState.exitCode }
  }
  function accept() {
    const value = read()
    for (const item of [...value.baselineInventory.surfaceCandidates, ...value.baselineInventory.nativeSourceRegister]) Object.assign(item, { taskIds: ['F01'], accepted: true })
    save(value)
  }
  return { root, write, read, save, run, accept, tracker, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('static inventory retains history, follows service source without executing it and never grants acceptance', () => {
  const h = fixture()
  try {
    h.run('--refresh')
    const value = h.read()
    assert.equal(value.executionLog[0].slice, 'preserved')
    assert.equal(value.baselineInventory.sourceModules.length, 2)
    const service = value.baselineInventory.sourceModules.find(item => item.path === 'lib/services/sales.ts')
    assert.equal(service.directPermissionCalls[0].permission, 'sales.read')
    assert.deepEqual(service.featureFlags, ['ARC_SALES_ENABLED'])
    assert.equal(value.baselineInventory.surfaceCandidates[0].accepted, false)
    assert.equal(h.run('--check').exitCode, 1)
    h.accept()
    assert.equal(h.run('--check').exitCode, 0)
  } finally { h.cleanup() }
})

test('dependency changes invalidate prior acceptance even when the page bytes are unchanged', () => {
  const h = fixture()
  try {
    h.run('--refresh'); h.accept()
    h.write('lib/services/sales.ts', 'export async function load() { return "different owner" }')
    const check = h.run('--check')
    assert.equal(check.exitCode, 1)
    assert.deepEqual(check.output.drift, [])
    assert.ok(check.output.dependencyDrift.includes('lib/services/sales.ts'))
    h.run('--refresh')
    assert.equal(h.read().baselineInventory.surfaceCandidates[0].accepted, false)
    assert.equal(h.read().baselineInventory.nativeSourceRegister[0].accepted, false)
  } finally { h.cleanup() }
})

test('missing surfaces stay in the evidence record and cannot disappear into a passing check', () => {
  const h = fixture()
  try {
    h.run('--refresh'); h.accept()
    fs.unlinkSync(path.join(h.root, 'app/(app)/sales/page.tsx'))
    assert.equal(h.run('--check').exitCode, 1)
    h.run('--refresh')
    const value = h.read()
    assert.equal(value.baselineInventory.removedSurfaceCandidates[0].taskIds[0], 'F01')
    assert.equal(h.run('--check').output.unresolvedRemoved.length, 1)
    assert.equal(h.run('--check').exitCode, 1)
  } finally { h.cleanup() }
})

test('disk-full checkpoint failure preserves the original tracker bytes and removes only its own temporary file', () => {
  const h = fixture()
  try {
    const before = fs.readFileSync(path.join(h.root, h.tracker))
    const failedFs = { ...fs, writeFileSync() { const error = new Error('No space left'); error.code = 'ENOSPC'; throw error } }
    assert.throws(() => h.run('--refresh', failedFs), /No space left/)
    assert.deepEqual(fs.readFileSync(path.join(h.root, h.tracker)), before)
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(h.root, h.tracker))), ['acceptance.json'])
  } finally { h.cleanup() }
})

test('a concurrent evidence writer is preserved instead of overwritten by refresh', () => {
  const h = fixture()
  try {
    let reads = 0
    const concurrentFs = { ...fs, readFileSync(name, ...args) {
      if (name === path.join(h.root, h.tracker) && ++reads === 3) { const value = h.read(); value.executionLog.push({ slice: 'concurrent evidence' }); h.save(value) }
      return fs.readFileSync(name, ...args)
    } }
    assert.throws(() => h.run('--refresh', concurrentFs), /Tracker changed during refresh/)
    assert.equal(h.read().executionLog.at(-1).slice, 'concurrent evidence')
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(h.root, h.tracker))), ['acceptance.json'])
  } finally { h.cleanup() }
})

test('malformed route source fails before changing the register', () => {
  const h = fixture()
  try {
    const before = fs.readFileSync(path.join(h.root, h.tracker))
    h.write('app/(app)/sales/page.tsx', 'export default function Page( {')
    assert.throws(() => h.run('--refresh'), /malformed source/)
    assert.deepEqual(fs.readFileSync(path.join(h.root, h.tracker)), before)
  } finally { h.cleanup() }
})

test('reexported and dynamically imported owners are traced, including arrow actions and object authorization', () => {
  const h = fixture()
  try {
    h.write('lib/services/sales.ts', 'export { load } from "./sales-owner"; export const other = async () => import("./background-owner")')
    h.write('lib/services/sales-owner.ts', 'export const load = async () => requireAuthorization({ permission: "sales.write" }); export const unknown = () => requirePermission(dynamicPermission)')
    h.write('lib/services/background-owner.ts', 'export function work() {}')
    h.run('--refresh')
    const modules = h.read().baselineInventory.sourceModules
    assert.equal(modules.length, 4)
    const owner = modules.find(item => item.path.endsWith('/sales-owner.ts'))
    assert.deepEqual(owner.exportedFunctions, ['load', 'unknown'])
    assert.deepEqual(owner.directPermissionCalls.map(item => item.permission), ['sales.write', null])
    assert.ok(modules.some(item => item.path.endsWith('/background-owner.ts')))
  } finally { h.cleanup() }
})

test('actual-home permission guards keep their permission and project arguments distinct from decision-only calls', () => {
  const h = fixture()
  try {
    h.write('lib/services/sales.ts', 'export async function load() { await requireProjectPermission(userId, homeId, "project.read"); const decision = await authorize({permission: "sales.write", projectId: homeId}); await requireProjectPermission(userId, homeId, dynamicPermission); await requireAnyPermission(["compliance.read", "org.member"]); await requirePermissionGuard("org.admin"); await requireAnyPermissionGuard([dynamicPermission]); await requireAnyPlatformPermission(["platform.billing.manage"]); await hasAnyPlatformPermission(["platform.support.write"]) }')
    h.run('--refresh')
    const calls = h.read().baselineInventory.sourceModules.find(item => item.path.endsWith('/sales.ts')).directPermissionCalls
    assert.deepEqual(calls.map(item => [item.helper, item.permission, item.projectExpression ?? null]), [['requireProjectPermission', 'project.read', 'homeId'], ['authorize', 'sales.write', null], ['requireProjectPermission', null, 'homeId'], ['requireAnyPermission', null, null], ['requirePermissionGuard', 'org.admin', null], ['requireAnyPermissionGuard', null, null], ['requireAnyPlatformPermission', null, null], ['hasAnyPlatformPermission', null, null]])
    assert.deepEqual(calls[3].permissionOptions, ['compliance.read', 'org.member'])
    assert.deepEqual(calls[5].permissionOptions, [null])
    assert.deepEqual(calls[6].permissionOptions, ["platform.billing.manage"])
    assert.deepEqual(calls[7].permissionOptions, ["platform.support.write"])
    assert.equal(h.run('--check').exitCode, 1)
  } finally { h.cleanup() }
})

test('a deleted service cannot vanish from the dependency graph and make an unchanged accepted route pass', () => {
  const h = fixture()
  try {
    h.run('--refresh'); h.accept()
    fs.unlinkSync(path.join(h.root, 'lib/services/sales.ts'))
    const check = h.run('--check')
    assert.equal(check.exitCode, 1)
    assert.ok(check.output.dependencyRemoved.includes('lib/services/sales.ts'))
    assert.equal(check.output.unresolvedLocalImports[0].specifier, '@/lib/services/sales')
    h.run('--refresh')
    assert.equal(h.read().baselineInventory.surfaceCandidates[0].accepted, false)
    assert.equal(h.run('--check').exitCode, 1)
    assert.equal(h.read().baselineInventory.unresolvedLocalImports.length, 1)
  } finally { h.cleanup() }
})

test('named server action modules and inline server actions are independent surfaces regardless of filename', () => {
  const h = fixture()
  try {
    h.write('app/(app)/settings/payment-actions.ts', '"use server"; import { load } from "@/lib/services/sales"; export async function save() { return load() }')
    h.write('app/(app)/settings/accounting-actions.ts', '\'use strict\'; \'use server\'; export const save = async () => {}')
    h.write('app/(app)/settings/template-editor.tsx', 'export function Editor() { async function save() { "use server"; return 1 }; return save }')
    h.write('app/(app)/settings/client-helper.ts', '// "use server"\nexport function unrelated() { return "use server" }')
    h.write('app/(app)/settings/not-a-directive.ts', 'const label = "use server"; "use server"; export function unrelated() {}')
    h.run('--refresh')
    const surfaces = h.read().baselineInventory.surfaceCandidates
    for (const name of ['payment-actions.ts', 'accounting-actions.ts', 'template-editor.tsx']) {
      const item = surfaces.find(item => item.path.endsWith(name))
      assert.ok(item, name)
      assert.equal(item.kind, 'actions')
      assert.equal(item.accepted, false)
      assert.ok(item.sourceFacts.serverActionDirectives.length)
    }
    assert.ok(!surfaces.some(item => /client-helper|not-a-directive/.test(item.path)))
    assert.equal(h.run('--check').exitCode, 1)
  } finally { h.cleanup() }
})

test('an unimported named action cannot be omitted from an otherwise passing register', () => {
  const h = fixture()
  try {
    h.run('--refresh'); h.accept()
    assert.equal(h.run('--check').exitCode, 0)
    h.write('app/(app)/settings/funding-actions.ts', '"use server"; export async function fund() {}')
    const check = h.run('--check')
    assert.equal(check.exitCode, 1)
    assert.ok(check.output.unmapped.includes('app/(app)/settings/funding-actions.ts'))
    h.run('--refresh')
    const action = h.read().baselineInventory.surfaceCandidates.find(item => item.path.endsWith('funding-actions.ts'))
    assert.equal(action.accepted, false)
    assert.deepEqual(action.taskIds, [])
  } finally { h.cleanup() }
})

test('route layouts and loading/error/parallel boundaries are audited even without page imports', () => {
  const h = fixture()
  try {
    for (const name of ['layout', 'template', 'error', 'global-error', 'not-found', 'global-not-found', 'loading', 'default']) {
      h.write(`app/(app)/settings/${name}.tsx`, `export default function Boundary() { return null }`)
    }
    h.run('--refresh')
    const surfaces = h.read().baselineInventory.surfaceCandidates
    assert.equal(surfaces.filter(item => item.kind === 'route_boundary').length, 8)
    assert.ok(surfaces.filter(item => item.kind === 'route_boundary').every(item => !item.accepted))
    h.accept()
    h.write('app/(app)/settings/layout.tsx', 'import { load } from "@/lib/services/sales"; export default async function Layout() { return load() }')
    const check = h.run('--check')
    assert.equal(check.exitCode, 1)
    assert.ok(check.output.drift.includes('app/(app)/settings/layout.tsx'))
  } finally { h.cleanup() }
})
