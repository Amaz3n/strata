require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module')
let status = 'new', updateError = null, changed = false, updates = [], events = []
const db = { from() { let write = false; const query = {
  select() { return query }, eq() { return query },
  update(input) { write = true; updates.push(input); return query },
  async maybeSingle() { return write ? { data: changed ? null : { id: 'lead' }, error: updateError } : { data: { id: 'lead', status } } },
}; return query } }
const original = Module._load
Module._load = function(name, ...args) { return ({
  "@/lib/services/prospect-write-access": { assertProspectWriteAccess: async () => {}, assertProspectOwner: async () => {} },
  '@/lib/services/context': { requireOrgContext: async () => ({ supabase: db, orgId: 'org', userId: 'user' }) },
  '@/lib/services/permissions': { requirePermission: async () => {} },
  '@/lib/services/party-promotion': {}, '@/lib/services/audit': {}, '@/lib/services/community-traffic': {},
  '@/lib/services/events': { recordEvent: async input => events.push(input) },
})[name] ?? original.call(this, name, ...args) }
const { logProspectContact } = require('../lib/services/prospects')
Module._load = original
test.beforeEach(() => { status = 'new'; updateError = null; changed = false; updates = []; events = [] })
test('internal notes retain the inquiry stage while conversations advance it', async () => {
  await logProspectContact({ prospectId: 'lead', input: { kind: 'note', note: 'Internal planning' } })
  assert.equal(updates[0].status, undefined)
  assert.deepEqual(events.map(event => event.eventType), ['prospect_contact_logged'])
  events = []
  await logProspectContact({ prospectId: 'lead', input: { kind: 'call' } })
  assert.equal(updates[1].status, 'contacted')
  assert.deepEqual(events.map(event => event.eventType), ['prospect_contact_logged', 'prospect_status_changed'])
})
test('contact on an issued deal does not regress its stage', async () => {
  status = 'estimate_sent'
  await logProspectContact({ prospectId: 'lead', input: { kind: 'email' } })
  assert.equal(updates[0].status, undefined)
  assert.equal(events.length, 1)
})
test('failed updates and concurrent stage changes do not create false activity', async () => {
  updateError = { message: 'Write failed' }
  await assert.rejects(logProspectContact({ prospectId: 'lead', input: { kind: 'call' } }), /Write failed/)
  updateError = null; changed = true
  await assert.rejects(logProspectContact({ prospectId: 'lead', input: { kind: 'call' } }), /deal changed/)
  assert.equal(events.length, 0)
})

test('contact validation rejects empty notes, unsupported kinds and oversized content', () => {
  const { logProspectContactInputSchema } = require('../lib/validation/prospects')
  for (const input of [{ kind: 'note', note: ' ' }, { kind: 'unsupported' }, { kind: 'call', note: 'a'.repeat(2001) }]) {
    assert.equal(logProspectContactInputSchema.safeParse(input).success, false)
  }
  assert.equal(logProspectContactInputSchema.safeParse({ kind: 'call' }).success, true)
})
