require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDraftSaveQueue } = require('../lib/financials/draft-save-queue');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('autosave and explicit save share one creation and drain newer edits', async () => {
  const gate = deferred(); const calls = [];
  const queue = createDraftSaveQueue({ onState() {}, save: async (input, previous) => {
    calls.push({ input, previous });
    if (calls.length === 1) await gate.promise;
    return { id: 'same-draft', updated_at: String(calls.length) };
  }});
  queue.update({ title: 'A' }); const first = queue.flush();
  queue.update({ title: 'AB' }); const explicit = queue.flush();
  gate.resolve(); await Promise.all([first, explicit]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].previous, undefined);
  assert.equal(calls[1].previous.id, 'same-draft');
  assert.equal(calls[1].input.title, 'AB');
  await queue.flush(); assert.equal(calls.length, 2);
});

test('failed saves stay retryable and do not claim success', async () => {
  const states = []; let calls = 0;
  const queue = createDraftSaveQueue({ onState: state => states.push(state), save: async () => {
    if (++calls === 1) throw new Error('offline'); return { id: 'draft' };
  }});
  queue.update({ title: 'A' });
  await assert.rejects(queue.flush(), /offline/);
  assert.equal(states.at(-1), 'error');
  assert.equal(queue.getSaved(), undefined);
  await queue.flush(); assert.equal(queue.getSaved().id, 'draft'); assert.equal(states.at(-1), 'saved');
});

test('incomplete fields stop queued server writes while an older save settles', async () => {
  const gate = deferred(); const states = []; let calls = 0;
  const queue = createDraftSaveQueue({ onState: state => states.push(state), save: async () => {
    calls++; await gate.promise; return { id: 'draft' };
  }});
  queue.update({ title: 'A' }); const saving = queue.flush(); queue.update(null);
  gate.resolve(); await saving; await queue.flush();
  assert.equal(calls, 1); assert.equal(states.at(-1), 'idle');
});

test('recovered drafts update the existing document with its revision token', async () => {
  let previous;
  const queue = createDraftSaveQueue({ onState() {}, save: async (_, saved) => { previous = saved; return { ...saved, updated_at: 'new' }; }});
  queue.restore({ id: 'existing', updated_at: 'old' });
  queue.update({ title: 'Recovered edit' }); await queue.flush();
  assert.deepEqual(previous, { id: 'existing', updated_at: 'old' });
  assert.equal(queue.getSaved().updated_at, 'new');
});
