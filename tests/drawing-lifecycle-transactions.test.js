const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  createDatabase,
  migrate,
  id,
} = require("./fixtures/drawing-lifecycle/database.cjs");
const manifest = {
  Image: { Format: "webp", TileSize: 256, Size: { Width: 800, Height: 600 } },
  Levels: 4,
};
const taskMigrations = [
  "20261001121920_drawing_job_leases.sql",
  "20261001122054_drawing_upload_operations.sql",
  "20261001123000_drawing_page_artifacts.sql",
  "20261001124849_drawing_storage_cleanup.sql",
  "20261001124901_drawing_publication_receipts.sql",
  "20261001124910_drawing_current_register.sql",
  "20261001162622_drawing_artifact_guards.sql",
  "20261001162632_drawing_split_manifest.sql",
  "20261001164202_drawing_split_registration.sql",
];
async function fixture() {
  const db = await createDatabase();
  const old = fs.readFileSync(
    path.resolve(
      __dirname,
      "../supabase/migrations/20260610220000_drawing_revision_drafts.sql",
    ),
    "utf8",
  );
  await db.exec(old.slice(old.indexOf("CREATE MATERIALIZED VIEW")));
  for (const file of taskMigrations) await migrate(db, file);
  return db;
}
test("combined migrated upload → publication → current register → durable deletion", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const intent = {
    projectId: id(4),
    fileName: "plans.pdf",
    fileSize: 123,
    mimeType: "application/pdf",
    fingerprint: `sha256-chain-v1:123:${"a".repeat(64)}`,
  };
  const op = (
    await db.query("select reserve_drawing_upload($1,$2,$3,$4,$5) op", [
      id(10),
      id(1),
      id(4),
      id(3),
      intent,
    ])
  ).rows[0].op;
  const ready = (
    await db.query("select finalize_drawing_upload($1,$2,$3,$4,$5,$6,$7) op", [
      op.id,
      id(1),
      id(4),
      id(3),
      op.storage_path,
      op.generation,
      123,
    ])
  ).rows[0].op;
  await db.query("update drawing_revisions set total_pages=1 where id=$1", [
    ready.revision_id,
  ]);
  await db.query(
    "insert into drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number) values($1,$2,$3,$4,$5)",
    [id(20), id(1), id(4), ready.drawing_set_id, "A1"],
  );
  await db.query(
    "insert into drawing_sheet_versions(id,org_id,drawing_sheet_id,drawing_revision_id,page_index,tile_manifest,extracted_metadata) values($1,$2,$3,$4,0,$5,$6)",
    [
      id(21),
      id(1),
      id(20),
      ready.revision_id,
      manifest,
      {
        sheet_detection: { confidence: "low", vision_pending: true },
        proposed: { sheet_number: "A1" },
      },
    ],
  );
  await db.query(
    "insert into drawing_split_pages(org_id,revision_id,source_hash,page_index,version_id,storage_prefix,state) values($1,$2,$3,0,$4,$5,$6)",
    [
      id(1),
      ready.revision_id,
      "fixture",
      id(21),
      `${id(1)}/split/${id(50)}`,
      "emitted",
    ],
  );
  const publish = (edits) =>
    db.query("select publish_drawing_revision($1,$2,$3,p_sheet_edits=>$4)", [
      id(1),
      ready.revision_id,
      id(3),
      edits,
    ]);
  await assert.rejects(publish({}), /Confirm the identity/);
  const edits = { [id(20)]: { version_id: id(21), identity_reviewed: true } };
  await db.exec(
    `create function reject_carry_forward() returns trigger language plpgsql as $$begin if new.job_type='reanchor_takeoff_markups' then raise exception 'queue unavailable';end if;return new;end$$;create trigger reject_queue before insert on outbox for each row execute function reject_carry_forward()`,
  );
  await assert.rejects(publish(edits), /queue unavailable/);
  assert.equal(
    (
      await db.query("select status from drawing_revisions where id=$1", [
        ready.revision_id,
      ])
    ).rows[0].status,
    "processing",
  );
  assert.equal(
    (
      await db.query(
        "select current_revision_id from drawing_sheets where id=$1",
        [id(20)],
      )
    ).rows[0].current_revision_id,
    null,
  );
  await db.exec("drop trigger reject_queue on outbox");
  await publish(edits);
  // A lost-response retry may arrive after polling observed the committed timestamp.
  await publish({ ...edits, __expected_revision_updated_at: new Date().toISOString() });
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from outbox where job_type='reanchor_takeoff_markups'",
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    publish({ ...edits, [id(20)]: { ...edits[id(20)], sheet_number: "A9" } }),
    /differs/,
  );
  const live = (
    await db.query(
      "select current_version_id from drawing_current_register where org_id=$1 and project_id=$2",
      [id(1), id(4)],
    )
  ).rows;
  assert.deepEqual(live, [{ current_version_id: id(21) }]);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from drawing_current_register where org_id=$1",
        [id(2)],
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    db.query("select delete_drawings_transaction($1,$2,$3,$4,$5,$6)", [
      id(30),
      id(1),
      id(4),
      id(3),
      "discard",
      [ready.revision_id],
    ]),
    /Published revision history/,
  );
  const remove = () =>
    db.query("select delete_drawings_transaction($1,$2,$3,$4,$5,$6) receipt", [
      id(31),
      id(1),
      id(4),
      id(3),
      "sheets",
      [id(20)],
    ]);
  const receipt = (await remove()).rows[0].receipt;
  assert.deepEqual((await remove()).rows[0].receipt, receipt);
  assert.equal(
    (await db.query("select count(*)::int n from drawing_current_register"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select count(*)::int n from files")).rows[0].n,
    1,
    "source document retained",
  );
  await assert.rejects(
    db.query(
      "insert into drawing_sheet_versions(id,org_id,drawing_sheet_id,drawing_revision_id,page_index) values($1,$2,$3,$4,0)",
      [id(90), id(1), id(20), ready.revision_id],
    ),
    /page was deleted/,
  );
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('authenticated','publish_drawing_revision(uuid,uuid,uuid,text,text,date,text,text,text,jsonb,jsonb)','execute') ok",
      )
    ).rows[0].ok,
    false,
  );
});
module.exports = { fixture, manifest, taskMigrations };

test("set deletion wins against a reserved upload without resurrecting a canonical set", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.query(
    "insert into drawing_sets(id,org_id,project_id,title,status) values($1,$2,$3,$4,$5)",
    [id(40), id(1), id(4), "Existing", "ready"],
  );
  const op = (
    await db.query("select reserve_drawing_upload($1,$2,$3,$4,$5) op", [
      id(10),
      id(1),
      id(4),
      id(3),
      {
        projectId: id(4),
        fileName: "new.pdf",
        fileSize: 123,
        mimeType: "application/pdf",
      },
    ])
  ).rows[0].op;
  await db.query("select delete_drawings_transaction($1,$2,$3,$4,$5,$6)", [
    id(31),
    id(1),
    id(4),
    id(3),
    "set",
    [id(40)],
  ]);
  await assert.rejects(
    db.query("select finalize_drawing_upload($1,$2,$3,$4,$5,$6,$7)", [
      op.id,
      id(1),
      id(4),
      id(3),
      op.storage_path,
      op.generation,
      123,
    ]),
    /not active/,
  );
  assert.equal(
    (await db.query("select count(*)::int n from drawing_sets")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select count(*)::int n from drawing_abandoned_uploads"))
      .rows[0].n,
    1,
  );
});

test("live register uses scoped indexes with thousands of unrelated sheets and pins", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(`
 insert into drawing_sets(id,org_id,project_id,title,status) values('${id(40)}','${id(1)}','${id(4)}','Target','ready'),('${id(41)}','${id(2)}','${id(5)}','Unrelated','ready');
 insert into drawing_revisions(id,org_id,project_id,drawing_set_id,status,revision_label) values('${id(42)}','${id(1)}','${id(4)}','${id(40)}','published','Target'),('${id(43)}','${id(2)}','${id(5)}','${id(41)}','published','Other');
 insert into drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number,current_revision_id) values('${id(20)}','${id(1)}','${id(4)}','${id(40)}','A1','${id(42)}');
 insert into drawing_sheet_versions(id,org_id,drawing_sheet_id,drawing_revision_id,page_index) values('${id(21)}','${id(1)}','${id(20)}','${id(42)}',0);
 insert into drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number,current_revision_id) select gen_random_uuid(),'${id(2)}','${id(5)}','${id(41)}','X'||n,'${id(43)}' from generate_series(1,2000) n;
 insert into drawing_pins(id,org_id,drawing_sheet_id,status,entity_type) select gen_random_uuid(),org_id,id,'open','rfi' from drawing_sheets where org_id='${id(2)}';
 analyze;
 `);
  const query =
    "select id,current_version_id,open_pins_count from drawing_current_register where org_id=$1 and project_id=$2 order by sort_order,id limit 20";
  const rows = (await db.query(query, [id(1), id(4)])).rows;
  assert.deepEqual(rows, [
    { id: id(20), current_version_id: id(21), open_pins_count: 0 },
  ]);
  const plan = (
    await db.query("explain (format json,analyze,buffers) " + query, [
      id(1),
      id(4),
    ])
  ).rows[0]["QUERY PLAN"];
  const serialized = JSON.stringify(plan);
  assert.match(serialized, /drawing_live_project_sort/);
  assert.match(serialized, /Index Cond/);
  fs.writeFileSync(
    "/tmp/arc-drawing-register-explain.json",
    JSON.stringify(plan, null, 2),
  );
});
