const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const runtime = process.env.ARC_PGLITE_MODULE

test('daily log transactions preserve contribution invariants', { skip: !runtime }, async (t) => {
  const { PGlite } = require(runtime)
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create type task_status as enum ('todo','in_progress','done');
      create table projects(id uuid primary key,org_id uuid,name text,location jsonb);
      create table app_users(id uuid primary key,full_name text,email text,avatar_url text);
      create table project_members(org_id uuid,project_id uuid,user_id uuid,status text);
      create table daily_reports(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,report_date date,
        status text,weather jsonb,created_by uuid,unique(project_id,report_date));
      create table daily_logs(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,log_date date,summary text,
        weather jsonb,daily_report_id uuid references daily_reports,created_by uuid,created_at timestamptz default now(),updated_at timestamptz default now());
      create table project_locations(id uuid primary key,org_id uuid,project_id uuid,full_path text,is_active boolean);
      create table cost_codes(id uuid primary key,org_id uuid,is_active boolean);
      create table schedule_items(id uuid primary key,org_id uuid,project_id uuid,actual_hours numeric,progress integer,status text,
        inspection_result text,inspected_at timestamptz,inspected_by uuid);
      create table tasks(id uuid primary key,org_id uuid,project_id uuid,status task_status,completed_at timestamptz,metadata jsonb);
      create table punch_items(id uuid primary key,org_id uuid,project_id uuid,status text,resolved_at timestamptz,resolved_by uuid);
      create table daily_log_entries(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,daily_log_id uuid references daily_logs,
        entry_type text,description text,quantity numeric,hours numeric,progress integer,schedule_item_id uuid references schedule_items,
        task_id uuid references tasks,punch_item_id uuid references punch_items,cost_code_id uuid references cost_codes,
        location_id uuid references project_locations,location text,trade text,labor_type text,inspection_result text,metadata jsonb,created_at timestamptz default now());
      create table daily_log_mentions(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,daily_log_id uuid references daily_logs,
        daily_log_comment_id uuid,mentioned_user_id uuid references app_users,mentioned_by uuid,created_at timestamptz default now());
      create table events(id uuid primary key default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,created_at timestamptz default now());
      create table audit_log(id bigint generated always as identity,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,after_data jsonb);
      create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb,dedupe_key text,status text default 'pending');
    `)
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260907213753_daily_log_atomic_submission.sql'), 'utf8'))
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260908151828_daily_log_project_name_fix.sql'), 'utf8'))
    const org = randomUUID(), project = randomUUID(), actor = randomUUID(), member = randomUUID(), schedule = randomUUID(), task = randomUUID(), punch = randomUUID(), location = randomUUID()
    await db.query('insert into projects values ($1,$2,$3,$4)', [project, org, 'Job', JSON.stringify({address:'Site'})])
    await db.query('insert into app_users(id,full_name) values ($1,$2),($3,$4)', [actor,'Writer',member,'Reader'])
    await db.query("insert into project_members values ($1,$2,$3,'active')", [org,project,member])
    await db.query("insert into schedule_items(id,org_id,project_id,actual_hours,status) values ($1,$2,$3,2,'planned')", [schedule,org,project])
    await db.query("insert into tasks(id,org_id,project_id,status,metadata) values ($1,$2,$3,'todo','{\"preserve\":true}')", [task,org,project])
    await db.query("insert into punch_items(id,org_id,project_id,status) values ($1,$2,$3,'open')", [punch,org,project])
    await db.query("insert into project_locations values ($1,$2,$3,'Level 1 / Room A',true)", [location,org,project])
    const submit = async (id, input, mentions = []) => (await db.query('select create_daily_log_submission($1,$2,$3,$4,$5,$6) as result', [org, project, actor, id, JSON.stringify(input), mentions])).rows[0].result
    const count = async (table) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n)
    const input = { date:'2026-09-07',summary:'Done @Reader',weather:{conditions:'Sunny'},entries:[
      {entry_type:'work',schedule_item_id:schedule,hours:3,progress:50,location_id:location},
      {entry_type:'task_update',task_id:task,metadata:{mark_complete:true}},
      {entry_type:'punch_update',punch_item_id:punch,metadata:{mark_closed:true}},
    ]}
    let saved
    await t.test('commits linked changes, stable child IDs, audit and durable emails together', async () => {
      saved = await submit(randomUUID(), input, [member])
      assert.equal(saved.entries.length,3)
      assert.equal(saved.entries.find(e => e.entry_type === 'work').location,'Level 1 / Room A')
      assert.equal(saved.mentions[0].user.full_name,'Reader')
      assert.equal((await db.query('select actual_hours from schedule_items')).rows[0].actual_hours,'5')
      assert.equal((await db.query('select metadata from tasks')).rows[0].metadata.preserve,true)
      assert.equal((await db.query('select status from punch_items')).rows[0].status,'closed')
      assert.equal(await count('audit_log'),1)
      assert.equal(await count('outbox'),2)
      const email = (await db.query("select payload from outbox where job_type='send_daily_log_mention_email'")).rows[0].payload
      assert.match(email.message, /on Job:/)
      assert.equal(saved.events.length,4)
    })
    await t.test('retry returns the same records without repeating linked hours or outbox writes', async () => {
      const replay = await submit(saved.log.submission_id,input,[member])
      assert.equal(replay.log.id,saved.log.id)
      assert.equal(replay.replayed,true)
      assert.deepEqual(replay.entries.map(e=>e.id),saved.entries.map(e=>e.id))
      assert.equal(await count('daily_logs'),1)
      assert.equal(await count('outbox'),2)
      assert.equal(await count('events'),4)
      assert.equal((await db.query('select actual_hours from schedule_items')).rows[0].actual_hours,'5')
      await assert.rejects(submit(saved.log.submission_id,{...input,summary:'Changed'}), /different content/)
    })
    await t.test('cross-project references and inactive locations create no report or log', async () => {
      await db.query('update project_locations set is_active=false where id=$1',[location])
      await assert.rejects(submit(randomUUID(),{...input,date:'2026-09-06'}), /Location is unavailable/)
      const foreignSchedule = randomUUID()
      await db.query("insert into schedule_items(id,org_id,project_id,status) values ($1,$2,$3,'planned')",[foreignSchedule,randomUUID(),randomUUID()])
      await assert.rejects(submit(randomUUID(),{date:'2026-09-06',entries:[{entry_type:'work',schedule_item_id:foreignSchedule}]}), /Schedule item is unavailable/)
      assert.equal(await count('daily_reports'),1)
      assert.equal(await count('daily_logs'),1)
      await db.query('update project_locations set is_active=true where id=$1',[location])
    })
    await t.test('failure after inserting a parent rolls back all earlier writes', async () => {
      await db.exec("create function fail_entry() returns trigger language plpgsql as $$ begin raise exception 'entry failed'; end $$; create trigger fail_entry before insert on daily_log_entries for each row execute function fail_entry();")
      await assert.rejects(submit(randomUUID(),{...input,date:'2026-09-06'},[member]), /entry failed/)
      assert.equal(await count('daily_reports'),1)
      assert.equal(await count('daily_logs'),1)
      assert.equal(await count('outbox'),2)
      await db.exec('drop trigger fail_entry on daily_log_entries')
    })
    await t.test('submitted reports permit addenda while preserving locked weather', async () => {
      await db.query("update daily_reports set status='submitted'")
      const addendum = await submit(randomUUID(),{date:'2026-09-07',summary:'Addendum',weather:{conditions:'Rain'}})
      assert.equal(addendum.log.daily_report_id,saved.log.daily_report_id)
      const report = (await db.query('select status,weather from daily_reports')).rows[0]
      assert.equal(report.status,'submitted')
      assert.equal(report.weather.conditions,'Sunny')
    })
    await t.test('only the authorized server can execute the transaction RPC', async () => {
      const signature = 'public.create_daily_log_submission(uuid,uuid,uuid,uuid,jsonb,uuid[])'
      for (const role of ['anon','authenticated','service_role']) {
        const { rows } = await db.query('select has_function_privilege($1,$2,\'execute\') as allowed',[role,signature])
        assert.equal(rows[0].allowed,role === 'service_role')
      }
    })
  } finally { await db.close() }
})
