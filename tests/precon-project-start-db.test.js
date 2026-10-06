const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
let PGlite
try { ({ PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')) } catch {}
const org = '20000000-0000-0000-0000-000000000001', actor = '10000000-0000-0000-0000-000000000001'
const lead = '30000000-0000-0000-0000-000000000001', job = '50000000-0000-0000-0000-000000000001'
const other = '20000000-0000-0000-0000-000000000002'
const root = path.join(__dirname, '..')
test('legacy project start migration remains reproducible (superseded by executed-deal tests)', { skip: !PGlite }, async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/precon-handoff-schema.sql'), 'utf8'))
  for (const file of ['20260921121029_precon_workspace.sql', '20260921121038_precon_transactional_handoff.sql', '20260921121045_optional_preconstruction_project_start.sql', '20260922113919_precon_project_transition_conditions.sql']) await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'))
  const scalar = async sql => (await db.query(sql)).rows[0]
  const reset = async () => {
    await db.exec(`truncate public.events, public.precon_decisions, public.precon_workspaces, public.estimates, public.files, public.prospect_contacts, public.contacts, public.projects, public.prospects, public.orgs, public.app_users cascade;
      insert into public.orgs values ('${org}','Builder'),('${other}','Other'); insert into public.app_users values ('${actor}','builder@example.test');
      insert into public.prospects(id,org_id,name,status) values ('${lead}','${org}','Quick repair','new');`)
  }
  const start = async (expected = null, tenant = org) => (await db.query('select public.start_prospect_project($1,$2,$3,$4,$5) as result', [tenant, lead, actor, expected, 'residential'])).rows[0].result
  await t.test('name-only lead can become a project with no estimate, brief, budget, or signature', async () => {
    await reset(); const result = await start()
    assert.equal(result.alreadyStarted, false)
    assert.deepEqual(await scalar(`select phase,status from public.projects where id='${result.projectId}'`), {phase:'delivery',status:'active'})
    assert.equal((await scalar(`select status from public.prospects where id='${lead}'`)).status, 'won')
    for (const table of ['estimates','contracts','budgets']) assert.equal((await scalar(`select count(*)::int n from public.${table}`)).n, 0)
    assert.equal((await start(result.projectId)).alreadyStarted, true)
    assert.equal((await scalar('select count(*)::int n from public.events')).n, 1)
  })
  await t.test('existing precon project and unlinked artifacts carry forward with original signature status', async () => {
    await reset()
    await db.exec(`insert into public.projects(id,org_id,prospect_id,name,phase,status) values ('${job}','${org}','${lead}','Repair','precon','planning');
      insert into public.estimates(id,org_id,prospect_id,status) values ('40000000-0000-0000-0000-000000000001','${org}','${lead}','draft');
      insert into public.files(org_id,prospect_id,folder_path) values ('${org}','${lead}','/prospects/${lead}/plans');
      insert into public.prospect_contacts(org_id,prospect_id,full_name,email,is_primary) values ('${org}','${lead}','Client','client@example.test',true);`)
    await db.exec(`insert into public.bid_packages(org_id,prospect_id) values ('${org}','${lead}');
      alter table public.bid_packages add constraint test_single_parent check (num_nonnulls(project_id,prospect_id)=1);`)
    const result = await start(job); assert.equal(result.projectId, job)
    assert.deepEqual(await scalar('select project_id,prospect_id from public.bid_packages'), {project_id:job,prospect_id:null})
    await db.exec('alter table public.bid_packages drop constraint test_single_parent')
    assert.deepEqual(await scalar('select status,project_id from public.estimates'), {status:'draft',project_id:job})
    assert.deepEqual(await scalar('select project_id,folder_path from public.files'), {project_id:job,folder_path:`/projects/${job}/plans`})
    assert.ok((await scalar(`select client_id from public.projects where id='${job}'`)).client_id)
    assert.equal((await scalar('select count(*)::int n from public.projects')).n, 1)
  })
  await t.test('moving to delivery preserves open construction conditions without granting authorization', async () => {
    await reset()
    await db.exec(`insert into public.precon_decisions(org_id,prospect_id,title,kind,status,blocks_start,owner_user_id,created_by,updated_by) values ('${org}','${lead}','Permit condition','readiness','open',true,'${actor}','${actor}','${actor}')`)
    const result = await start()
    assert.equal((await scalar('select count(*)::int n from public.projects')).n, 1)
    assert.deepEqual(await scalar('select status,blocks_start from public.precon_decisions'), {status:'open',blocks_start:true})
    assert.equal((await scalar('select count(*)::int n from public.project_precon_handoffs')).n, 0)
    assert.equal((await start(result.projectId)).alreadyStarted, true)
  })
  await t.test('tenant mismatch, lost leads, and a changed linked project fail before writes', async () => {
    await reset(); await assert.rejects(start(null, other), /Prospect not found/)
    await assert.rejects(start(job), /linked project changed/)
    await db.exec(`update public.prospects set status='lost'`)
    await assert.rejects(start(), /Reopen/)
    assert.equal((await scalar('select count(*)::int n from public.projects')).n, 0)
  })
  await t.test('failure rolls back project, lead, and artifact changes together', async () => {
    await reset()
    await db.exec(`create function public.fail_project_start_event() returns trigger language plpgsql as $$begin raise exception 'injected failure'; end$$;
      create trigger fail_start before insert on public.events for each row execute function public.fail_project_start_event();`)
    await assert.rejects(start(), /injected failure/)
    assert.equal((await scalar('select count(*)::int n from public.projects')).n, 0)
    assert.equal((await scalar('select status from public.prospects')).status,'new')
    await db.exec('drop trigger fail_start on public.events'); await start()
  })
  await t.test('public API roles cannot invoke privileged project start', async () => {
    for (const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(start(), /permission denied/)
      await db.exec('reset role')
    }
  })
})
