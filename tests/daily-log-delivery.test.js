require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { deliverDailyLogOutboxEmails } = require('../lib/services/daily-log-delivery')

function database(rows) {
  return { from() {
    let patch, filters = []
    const query = {
      select() { return query },
      update(value) { patch = value; return query },
      eq(key,value) { filters.push(row => row[key] === value); return query },
      lte(key,value) { filters.push(row => row[key] <= value); return query },
      contains(key,value) { filters.push(row => Object.entries(value).every(([k,v]) => row[key][k] === v)); return query },
      maybeSingle() { return query.then(result => ({...result,data:result.data[0] ?? null})) },
      then(resolve) {
        const found = rows.filter(row => filters.every(filter => filter(row)))
        const data = found.map(row => { if (patch) Object.assign(row,patch); return {...row} })
        return Promise.resolve({data,error:null}).then(resolve)
      },
    }
    return query
  } }
}
const job = (id, extras = {}) => ({ id,org_id:'org',job_type:'send_daily_log_mention_email',status:'pending',retry_count:0,
  run_at:'2026-01-01',payload:{daily_log_id:'log',project_id:'project',user_id:String(id),title:'Mention',message:'Hello'},...extras })

test('two immediate drains atomically claim each email once', async () => {
  const rows = [job(1),job(2)]
  const db = database(rows)
  const sent = []
  const send = async (email) => { sent.push(email.userId); await new Promise(resolve => setImmediate(resolve)); return true }
  await Promise.all([deliverDailyLogOutboxEmails(db,'org','log',send),deliverDailyLogOutboxEmails(db,'org','log',send)])
  assert.deepEqual(sent.sort(),['1','2'])
  assert.ok(rows.every(row => row.status === 'completed'))
})

test('provider failure preserves a delayed durable retry without failing other recipients', async () => {
  const rows = [job(1),job(2)]
  await deliverDailyLogOutboxEmails(database(rows),'org','log',async ({userId}) => userId !== '1')
  assert.equal(rows[0].status,'pending')
  assert.equal(rows[0].retry_count,1)
  assert.ok(Date.parse(rows[0].run_at) > Date.now())
  assert.equal(rows[1].status,'completed')
})

test('drain ignores another contribution, organization, active lease and future retry', async () => {
  const rows = [job(1,{org_id:'other'}),job(2,{status:'processing'}),job(3,{run_at:'2999-01-01'}),job(4,{payload:{daily_log_id:'other'}})]
  let count = 0
  await deliverDailyLogOutboxEmails(database(rows),'org','log',async () => { count++; return true })
  assert.equal(count,0)
})

test('large mentions bound concurrent email-provider calls', async () => {
  const rows = Array.from({length:12},(_,i)=>job(i))
  let current=0,max=0
  await deliverDailyLogOutboxEmails(database(rows),'org','log',async () => {
    current++; max=Math.max(current,max)
    await new Promise(resolve=>setImmediate(resolve)); current--; return true
  })
  assert.equal(max,4)
  assert.ok(rows.every(row=>row.status === 'completed'))
})
