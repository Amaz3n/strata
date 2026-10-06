const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(file, mocks) {
  const filename = path.resolve(__dirname, '..', file)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const workspaceModule = { exports: {} }
  Function('exports', 'require', 'module', code)(workspaceModule.exports, id => id in mocks ? mocks[id] : require(id), workspaceModule)
  return workspaceModule.exports
}
class MobileAPIError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const catalog = load('lib/mobile/workspace-catalog.ts', { '@/lib/mobile/workspace-estimate-fields': load('lib/mobile/workspace-estimate-fields.ts', {}) })
const task = catalog.workspaceModules.find(m => m.id === 'tasks')
function fixture({ permitted = true, rows = [{ id: 'task-a', status: 'todo' }] } = {}) {
  const calls = []
  const query = {
    update(value) { calls.push(['update', value]); return this },
    eq(key, value) { calls.push(['eq', key, value]); return this },
    select() { return this },
    async maybeSingle() { return { data: { id: 'task-a' }, error: null } },
  }
  const context = { orgId: 'org-a', user: { id: 'user-a' }, serviceContext: {}, serviceSupabase: { from(table) { calls.push(['from', table]); return query } } }
  const mocks = {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => permitted, requireModule: async () => task, loadRows: async () => rows },
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/services/audit': { recordAudit: async () => {} },
    '@/lib/services/events': { recordEvent: async () => {} },
  }
  return { context, calls, api: load('lib/mobile/workspace-edit.ts', mocks) }
}
const values = { title: 'Inspect roof', description: '', due_date: '', priority: 'normal', status: 'done' }

test('editing one task scopes the write by organization, project and record and preserves assignments', async () => {
  const { context, calls, api } = fixture()
  await api.editWorkspaceRecord(context, 'tasks', 'project-a', 'task-a', { ...values, assignee_id: 'untrusted', project_id: 'project-b' })
  assert.deepEqual(calls.filter(c => c[0] === 'eq'), [['eq', 'org_id', 'org-a'], ['eq', 'id', 'task-a'], ['eq', 'project_id', 'project-a']])
  assert.deepEqual(calls.filter(c => c[0] === 'from'), [['from', 'tasks']])
  const patch = calls.find(c => c[0] === 'update')[1]
  assert.equal(patch.assignee_id, undefined)
  assert.equal(patch.project_id, undefined)
  assert.equal(patch.due_date, null)
  assert.ok(patch.completed_at)
})

test('editing cannot reach a record outside the selected project', async () => {
  const { context, calls, api } = fixture({ rows: [] })
  await assert.rejects(api.editWorkspaceRecord(context, 'tasks', 'project-a', 'task-b', values), e => e.status === 404)
  assert.equal(calls.length, 0)
})

test('editing rechecks permission before reading or writing records', async () => {
  const { context, calls, api } = fixture({ permitted: false })
  await assert.rejects(api.editWorkspaceRecord(context, 'tasks', 'project-a', 'task-a', values), e => e.status === 403)
  assert.equal(calls.length, 0)
})

test('reopening a task clears completion while invalid states never write', async () => {
  const { context, calls, api } = fixture()
  await api.editWorkspaceRecord(context, 'tasks', 'project-a', 'task-a', { ...values, status: 'todo' })
  assert.equal(calls.find(c => c[0] === 'update')[1].completed_at, null)
  calls.length = 0
  await assert.rejects(api.editWorkspaceRecord(context, 'tasks', 'project-a', 'task-a', { ...values, status: 'invalid' }))
  assert.equal(calls.length, 0)
})

function detailFixture({ moduleId = 'inspections', canWrite = true, status = 'in_progress' } = {}) {
  const calls = []
  const workspaceModule = catalog.workspaceModules.find(m => m.id === moduleId)
  const context = { orgId: 'org-a', user: { id: 'user-a' }, serviceContext: {} }
  const api = load('lib/mobile/workspace-detail.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => canWrite, requireModule: async () => workspaceModule, loadRows: async () => [{ id: 'parent-a', status }] },
    '@/lib/mobile/workspace-catalog': catalog,
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/services/inspections': {
      getInspection: async () => ({ id: 'parent-a', status, items: [{ id: 'item-a', prompt: 'Roof flashing', response_type: 'pass_fail', response: null, note: null, is_deficient: false }] }),
      updateInspectionItem: async (...args) => { calls.push(args) },
    },
    '@/lib/mobile/payables': {
      getMobilePayable: async () => ({ coding: { lines: [], uncoded_cents: 0 }, holds: { reasons: [] }, evidence: {}, can_approve: true, updated_at: 'revision-new', status: 'pending' }),
      decideMobilePayable: async (...args) => { calls.push(args) },
    },
  })
  return { context, api, calls }
}

test('an inspection action cannot target another inspection checklist item', async () => {
  const { context, api, calls } = detailFixture()
  await assert.rejects(api.performWorkspaceAction(context, 'inspections', 'project-a', 'parent-a', 'inspection-item:item-b', { response: 'fail' }), e => e.status === 403)
  assert.equal(calls.length, 0)
  await api.performWorkspaceAction(context, 'inspections', 'project-a', 'parent-a', 'inspection-item:item-a', { response: 'fail', note: 'Missing flashing' })
  assert.equal(calls[0][0], 'item-a')
  assert.equal(calls[0][1].is_deficient, undefined, 'the canonical service derives deficiency from the answer')
})

test('completed inspections and read-only users cannot change checklist answers', async () => {
  for (const options of [{ status: 'completed' }, { canWrite: false }]) {
    const { context, api, calls } = detailFixture(options)
    await assert.rejects(api.performWorkspaceAction(context, 'inspections', 'project-a', 'parent-a', 'inspection-item:item-a', { response: 'pass' }), e => e.status === 403)
    assert.equal(calls.length, 0)
  }
})

test('bill decisions require the revision the approver reviewed', async () => {
  const { context, api, calls } = detailFixture({ moduleId: 'payables' })
  await assert.rejects(api.performWorkspaceAction(context, 'payables', 'project-a', 'parent-a', 'approve-bill', {}, 'revision-old'), e => e.status === 409)
  assert.equal(calls.length, 0)
  await api.performWorkspaceAction(context, 'payables', 'project-a', 'parent-a', 'approve-bill', {}, 'revision-new')
  assert.equal(calls[0][2].expected_updated_at, 'revision-new')
})

test('signature reminders are limited to remindable recipients of the selected envelope', async () => {
  const calls = []
  const workspaceModule = catalog.workspaceModules.find(m => m.id === 'signatures')
  const context = { orgId: 'org-a', serviceContext: {} }
  const api = load('lib/mobile/workspace-detail.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => true, requireModule: async () => workspaceModule, loadRows: async () => [{ id: 'envelope-a', document_title: 'Agreement', recipient_statuses: [{ id: 'recipient-a', email: 'signer@example.com', can_remind: true }, { id: 'recipient-b', email: 'done@example.com', can_remind: false }], activity: [], can_download: false, can_void: false }] },
    '@/lib/mobile/workspace-catalog': catalog,
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/app/(app)/signatures/actions': { sendDocumentSigningReminderAction: async id => { calls.push(id); return { success: true, data: {} } } },
  })
  await assert.rejects(api.performWorkspaceAction(context, 'signatures', 'project-a', 'envelope-a', 'signature-reminder:recipient-b', {}), e => e.status === 403)
  await assert.rejects(api.performWorkspaceAction(context, 'signatures', 'project-a', 'envelope-a', 'signature-reminder:other-envelope-recipient', {}), e => e.status === 403)
  assert.deepEqual(calls, [])
  await api.performWorkspaceAction(context, 'signatures', 'project-a', 'envelope-a', 'signature-reminder:recipient-a', {})
  assert.deepEqual(calls, ['recipient-a'])
})

test('warranty first-response vocabulary matches the canonical schema and never fabricates a prior response', async () => {
  const calls = []
  let responded = false
  const workspaceModule = catalog.workspaceModules.find(m => m.id === 'warranty')
  const context = { orgId: 'org-a', serviceContext: {} }
  const api = load('lib/mobile/workspace-detail.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => true, requireModule: async () => workspaceModule, loadRows: async () => [{ id: 'request-a', project_id: 'project-a', title: 'Door', status: 'open', first_responded_at: responded ? '2026-10-01' : null }] },
    '@/lib/mobile/workspace-catalog': catalog,
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/services/warranty': { listWarrantyVisitsForProject: async () => [], acknowledgeWarrantyRequest: async input => { calls.push(input) } },
  })
  await api.performWorkspaceAction(context, 'warranty', 'project-a', 'request-a', 'acknowledge-warranty', { channel: 'text', note: 'Confirmed appointment' })
  assert.equal(calls[0].request_id, 'request-a')
  await assert.rejects(api.performWorkspaceAction(context, 'warranty', 'project-a', 'request-a', 'acknowledge-warranty', { channel: 'sms' }), e => e.status === 422)
  responded = true
  await assert.rejects(api.performWorkspaceAction(context, 'warranty', 'project-a', 'request-a', 'acknowledge-warranty', { channel: 'phone' }), e => e.status === 403)
  assert.equal(calls.length, 1)
})

function workflowFixture(moduleId, { canWrite = true, status = 'in_review' } = {}) {
  const calls = []
  const parentId = '11111111-1111-4111-8111-111111111111'
  const childId = '22222222-2222-4222-8222-222222222222'
  const context = { orgId: 'org-a', user: { id: 'user-a' }, serviceContext: {} }
  const workspaceModule = catalog.workspaceModules.find(m => m.id === moduleId)
  const api = load('lib/mobile/workspace-detail.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => canWrite, requireModule: async () => workspaceModule, loadRows: async () => [{ id: parentId, status }] },
    '@/lib/mobile/workspace-catalog': catalog,
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/validation/submittals': load('lib/validation/submittals.ts', {}),
    '@/lib/validation/meetings': load('lib/validation/meetings.ts', {}),
    '@/lib/services/submittals': {
      listSubmittalItems: async () => [],
      listSubmittalReviewSteps: async () => [{ id: childId, role_label: 'Architect', status: 'in_review' }],
      decideSubmittalReviewStep: async input => { calls.push(input) },
    },
    '@/lib/services/meetings': {
      getMeeting: async () => ({ id: parentId, status, items: [], attendees: [{ id: childId, display_name: 'Alex', present: true }] }),
      updateMeetingAttendee: async (...args) => { calls.push(args) },
      finalizeMeeting: async (...args) => { calls.push(args) },
      distributeMeetingMinutes: async input => { calls.push(input) },
    },
  })
  return { api, context, calls, parentId, childId }
}

test('routed review requires route permission and a live step of this submittal', async () => {
  const { api, context, calls, parentId, childId } = workflowFixture('submittals')
  await assert.rejects(api.performWorkspaceAction(context, 'submittals', 'project-a', parentId, 'review-step:another-step', { decision: 'approved' }), e => e.status === 403)
  await api.performWorkspaceAction(context, 'submittals', 'project-a', parentId, `review-step:${childId}`, { decision: 'approved_as_noted', notes: 'Use updated spec' })
  assert.equal(calls[0].input.step_id, childId)
  assert.equal(calls[0].input.decision, 'approved_as_noted')
  for (const options of [{ canWrite: false }, { status: 'approved' }]) {
    const denied = workflowFixture('submittals', options)
    await assert.rejects(denied.api.performWorkspaceAction(denied.context, 'submittals', 'project-a', parentId, `review-step:${childId}`, { decision: 'approved' }), e => e.status === 403)
    assert.equal(denied.calls.length, 0)
  }
})

test('meeting attendance cannot target a different meeting or change finalized minutes', async () => {
  const { api, context, calls, parentId, childId } = workflowFixture('meetings', { status: 'draft' })
  await assert.rejects(api.performWorkspaceAction(context, 'meetings', 'project-a', parentId, 'attendance:another-attendee', { present: 'false' }), e => e.status === 403)
  await api.performWorkspaceAction(context, 'meetings', 'project-a', parentId, `attendance:${childId}`, { present: 'false' })
  assert.deepEqual(calls[0], [childId, { present: false }, 'org-a'])
  const finalized = workflowFixture('meetings', { status: 'finalized' })
  await assert.rejects(finalized.api.performWorkspaceAction(finalized.context, 'meetings', 'project-a', parentId, `attendance:${childId}`, { present: 'true' }), e => e.status === 403)
})

test('minutes distribution validates explicit recipients and never accepts raw headers', async () => {
  const { api, context, calls, parentId } = workflowFixture('meetings', { status: 'finalized' })
  await assert.rejects(api.performWorkspaceAction(context, 'meetings', 'project-a', parentId, 'distribute-minutes', { recipients: 'not an email' }))
  assert.equal(calls.length, 0)
  await api.performWorkspaceAction(context, 'meetings', 'project-a', parentId, 'distribute-minutes', { recipients: 'alex@example.com;pat@example.com' })
  assert.deepEqual(calls[0].recipients, [{ email: 'alex@example.com' }, { email: 'pat@example.com' }])
})

test('punch composer strips assignment injection and validates dates and workflow states', async () => {
  const calls = []
  const api = load('lib/mobile/workspace-punch.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/app/(app)/projects/[id]/actions': {
      createProjectPunchItemAction: async (...args) => { calls.push(args); return { success: true, data: { id: 'punch-a' } } },
      updateProjectPunchItemAction: async (...args) => { calls.push(args); return { success: true, data: { id: 'punch-a' } } },
    },
  })
  await api.saveWorkspacePunch('project-a', { title: 'Repair door', due_date: '', verification_required: 'false', assigned_company_id: 'other-org' })
  assert.equal(calls[0][1].assigned_company_id, undefined)
  assert.equal(calls[0][1].verification_required, false)
  assert.equal(calls[0][1].due_date, null)
  await assert.rejects(api.saveWorkspacePunch('project-a', { title: 'Repair door', status: 'invalid' }, 'punch-a'))
  await assert.rejects(api.saveWorkspacePunch('project-a', { title: 'Repair door', due_date: 'tomorrow' }))
  assert.equal(calls.length, 1)
})
