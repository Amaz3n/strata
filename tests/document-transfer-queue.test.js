require('../scripts/register-ts-node-test')
const { TransferQueue } = require('../lib/files/transfer-queue')
const { File } = require('node:buffer')
const assert = require('node:assert/strict')
const test = require('node:test')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(run, initial = []) {
  const journal = new Map(initial.map(entry => [entry.id, entry]))
  const queue = new TransferQueue({ load: async () => [...journal.values()], save: async entry => journal.set(entry.id, structuredClone(entry)), remove: async id => journal.delete(id), run }, 2)
  return { queue, journal }
}
const file = () => new File(['bytes'], 'same.pdf', { type: 'application/pdf' })
test('bounds cross-page transfers and gives same-name files independent identities', async () => {
  let active = 0, max = 0
  const release = []
  const { queue } = fixture(async entry => { active++; max = Math.max(max, active); await new Promise(resolve => release.push(resolve)); active--; return entry.id })
  await queue.start()
  const tickets = await Promise.all([1,2,3,4,5].map(() => queue.submit(file(), {})))
  assert.equal(new Set(tickets.map(ticket => ticket.id)).size, 5)
  assert.equal(active, 2)
  while (queue.getSnapshot().some(entry => entry.status !== 'completed')) { release.splice(0).forEach(resolve => resolve()); await tick() }
  await Promise.all(tickets.map(ticket => ticket.completion))
  assert.equal(max, 2)
})
test('a paused upload resumes with its original identity and completion waiter', async () => {
  let attempts = 0
  const { queue, journal } = fixture(async (entry, signal) => {
    if (++attempts === 1) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('paused')), { once: true }))
    return entry.id
  })
  await queue.start()
  const ticket = await queue.submit(file(), {})
  queue.pause(ticket.id)
  await tick()
  assert.equal(queue.getSnapshot()[0].status, 'paused')
  assert.equal(journal.get(ticket.id).status, 'paused')
  await queue.retry(ticket.id)
  assert.equal(await ticket.completion, ticket.id)
  assert.equal(journal.size, 0)
})
test('failed attachment retries reuse checkpointed upload instead of transferring again', async () => {
  let uploads = 0, links = 0
  const { queue } = fixture(async (entry, signal, update, checkpoint) => {
    const result = entry.result ?? { id: String(++uploads) }
    await checkpoint(result)
    if (++links === 1) throw Error('link unavailable')
    return result
  })
  await queue.start()
  const ticket = await queue.submit(file(), {})
  await assert.rejects(ticket.completion, /link unavailable/)
  await tick()
  await queue.retry(ticket.id)
  await tick()
  assert.equal(uploads, 1)
  assert.equal(queue.getSnapshot()[0].status, 'completed')
})
test('reloaded journals pause instead of uploading without an explicit resume', async () => {
  let calls = 0
  const saved = { id: 'saved', file: file(), options: {}, status: 'uploading', stage: 'uploading', progress: 30 }
  const { queue } = fixture(async () => { calls++; return 'done' }, [saved])
  await queue.start()
  assert.equal(calls, 0)
  assert.equal(queue.getSnapshot()[0].status, 'paused')
  await queue.retry('saved'); await tick()
  assert.equal(calls, 1)
})
test('cancelling queued work never runs it and removes its journal', async () => {
  const release = []
  const { queue, journal } = fixture(async () => { await new Promise(resolve => release.push(resolve)); return 'done' })
  await queue.start()
  const tickets = await Promise.all([1,2,3].map(() => queue.submit(file(), {})))
  await queue.cancel(tickets[2].id)
  await assert.rejects(tickets[2].completion, /cancelled/)
  assert.equal(journal.has(tickets[2].id), false)
  release.splice(0).forEach(resolve => resolve()); await tick()
  assert.equal(queue.getSnapshot()[2].status, 'cancelled')
})
test('local persistence failure never starts an unjournaled transfer', async () => {
  let calls = 0
  const queue = new TransferQueue({ load: async () => [], save: async () => { throw Error('quota') }, remove: async () => {}, run: async () => { calls++ } })
  await queue.start()
  await assert.rejects(queue.submit(file(), {}), /quota/)
  assert.equal(calls, 0)
  assert.equal(queue.getSnapshot().length, 0)
})
test('clearing a cancelled transfer before its worker settles is safe', async () => {
  let reject
  const { queue } = fixture(async () => await new Promise((resolve, fail) => { reject = fail }))
  await queue.start()
  const ticket = await queue.submit(file(), {})
  await queue.cancel(ticket.id)
  await assert.rejects(ticket.completion, /cancelled/)
  queue.dismissFinished()
  reject(Error('late abort'))
  await tick()
  assert.equal(queue.getSnapshot().length, 0)
})
test('failed linking can be discarded without cancelling committed bytes', async () => {
  let cancelled = 0
  const queue = new TransferQueue({ load: async () => [], save: async () => {}, remove: async () => {}, cancel: async () => { cancelled++ }, run: async (entry, signal, update, checkpoint) => {
    update({stage:'finalizing'});await checkpoint({id:'committed'});throw Error('link failed')
  } })
  await queue.start()
  const ticket = await queue.submit(file(), {})
  await assert.rejects(ticket.completion, /link failed/)
  await queue.cancel(ticket.id)
  assert.equal(queue.getSnapshot()[0].status, 'cancelled')
  assert.equal(cancelled, 0)
})
