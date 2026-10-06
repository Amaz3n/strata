const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
let PGlite
try { ({ PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')) } catch {}
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260929113927_drawing_revision_sheet_number_conflicts.sql'), 'utf8')
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

test('drawing publish preserves pages when detected sheet numbers collide', { skip: !PGlite }, async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role service_role;
    create table drawing_revisions (id uuid primary key, org_id uuid, project_id uuid, drawing_set_id uuid,
      status text, processing_stage text, published_at timestamptz, published_by uuid, revision_label text,
      issuance_type text, issued_date date, issued_by text, received_from text, notes text);
    create table drawing_sheets (id uuid primary key, org_id uuid, project_id uuid, drawing_set_id uuid,
      current_revision_id uuid, sheet_number text not null, sheet_title text, discipline text, updated_at timestamptz);
    create unique index drawing_sheets_project_sheet_number_key on drawing_sheets(project_id,sheet_number) where sheet_number is not null;
    create table drawing_sheet_versions (id uuid primary key, org_id uuid, drawing_sheet_id uuid references drawing_sheets,
      drawing_revision_id uuid, extracted_metadata jsonb, page_index int, created_at timestamptz default now(),
      unique(drawing_sheet_id,drawing_revision_id));
    create function refresh_drawing_sheets_list() returns void language plpgsql as $$begin end$$;
  `)
  await db.exec(migration)
  const reset = async () => {
    await db.exec(`truncate drawing_sheet_versions, drawing_sheets, drawing_revisions;
      insert into drawing_revisions(id,org_id,project_id,drawing_set_id,status) values('${id(1)}','${id(2)}','${id(3)}','${id(4)}','draft');
      insert into drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number) values
        ('${id(10)}','${id(2)}','${id(3)}','${id(4)}','A1'),
        ('${id(11)}','${id(2)}','${id(3)}','${id(4)}','A7');
      insert into drawing_sheet_versions(id,org_id,drawing_sheet_id,drawing_revision_id,page_index,extracted_metadata) values
        ('${id(20)}','${id(2)}','${id(10)}','${id(1)}',0,'{"proposed":{"sheet_number":"A1","sheet_title":"Cover"}}'),
        ('${id(21)}','${id(2)}','${id(11)}','${id(1)}',1,'{"proposed":{"sheet_number":"A1","sheet_title":"Details"},"calibration":{"scale":12}}');`)
  }
  const publish = (edits = {}, decisions = {}) => db.query('select publish_drawing_revision($1,$2,$3,p_sheet_edits => $4::jsonb,p_decisions => $5::jsonb)', [id(2),id(1),id(5),JSON.stringify(edits),JSON.stringify(decisions)])
  const rows = async sql => (await db.query(sql)).rows
  await t.test('existing conflicting draft publishes both pages and retains version metadata', async () => {
    await reset(); await publish()
    assert.deepEqual(await rows('select sheet_number,sheet_title,current_revision_id from drawing_sheets order by id'), [
      {sheet_number:'A1',sheet_title:'Cover',current_revision_id:id(1)},
      {sheet_number:'A7',sheet_title:'Details',current_revision_id:id(1)},
    ])
    const versions = await rows('select id,extracted_metadata from drawing_sheet_versions order by id')
    assert.equal(versions.length,2)
    assert.equal(versions[1].id,id(21))
    assert.equal(versions[1].extracted_metadata.proposed.sheet_number,'A7')
    assert.deepEqual(versions[1].extracted_metadata.calibration,{scale:12})
    assert.equal((await rows('select status from drawing_revisions'))[0].status,'published')
  })
  await t.test('manual collision explains correction and rolls back the entire publish', async () => {
    await reset()
    await assert.rejects(publish({[id(11)]:{sheet_number:'A1'}}), /Sheet number "A1" is already in use/)
    assert.equal((await rows('select status from drawing_revisions'))[0].status,'draft')
    assert.ok((await rows('select current_revision_id from drawing_sheets')).every(r => r.current_revision_id === null))
    await publish({[id(11)]:{sheet_number:'A8'}})
    assert.equal((await rows(`select sheet_number from drawing_sheets where id='${id(11)}'`))[0].sheet_number,'A8')
  })
  await t.test('non-conflicting detection still renames the sheet', async () => {
    await reset()
    await db.exec(`update drawing_sheet_versions set extracted_metadata='{"proposed":{"sheet_number":"A8"}}' where id='${id(21)}'`)
    await publish()
    assert.equal((await rows(`select sheet_number from drawing_sheets where id='${id(11)}'`))[0].sheet_number,'A8')
  })
  await t.test('declined duplicate is excluded and cleaned up', async () => {
    await reset(); await publish({}, {[id(11)]:false})
    assert.equal((await rows('select * from drawing_sheet_versions')).length,1)
    assert.equal((await rows('select * from drawing_sheets')).length,1)
  })
  await t.test('unrelated unique violations are not swallowed', async () => {
    await reset()
    await db.exec(`create unique index test_unique_title on drawing_sheets(sheet_title);
      update drawing_sheet_versions set extracted_metadata='{"proposed":{"sheet_number":"A8","sheet_title":"Cover"}}' where id='${id(21)}'`)
    await assert.rejects(publish(), /test_unique_title/)
    assert.equal((await rows('select status from drawing_revisions'))[0].status,'draft')
    await db.exec('drop index test_unique_title')
  })
})
