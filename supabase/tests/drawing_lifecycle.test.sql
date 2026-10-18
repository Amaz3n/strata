-- Disposable migrated database only; the transaction rolls back every fixture.
begin;
select plan(6);
insert into public.orgs(id,name) values
 ('a0000000-0000-4000-8000-000000000001','Drawing lifecycle fixture'),
 ('a0000000-0000-4000-8000-000000000002','Other tenant fixture');
insert into public.projects(id,org_id,name) values
 ('a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','Drawing fixture');
insert into public.drawing_sets(id,org_id,project_id,title,status) values
 ('a0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','Fixture','ready');
insert into public.drawing_revisions(id,org_id,project_id,drawing_set_id,revision_label,status) values
 ('a0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000004','Fixture','draft');
select throws_ok($$insert into public.drawing_revisions(org_id,project_id,drawing_set_id,revision_label,status) values
 ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000004','Duplicate','processing')$$,'23505',null,'one pending draft per project');
insert into public.drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number) values
 ('a0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000004','A1'),
 ('a0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000004','A2');
insert into public.drawing_sheet_versions(id,org_id,drawing_sheet_id,drawing_revision_id,page_index) values
 ('a0000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000005',0),
 ('a0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000005',1);
update public.drawing_revisions set total_pages=2 where id='a0000000-0000-4000-8000-000000000005';
update public.drawing_sheet_versions set tile_manifest='{"Image":{"Format":"webp","TileSize":256,"Size":{"Width":800,"Height":600}},"Levels":4}',extracted_metadata='{"sheet_detection":{"confidence":"high","vision_pending":false}}' where drawing_revision_id='a0000000-0000-4000-8000-000000000005';
select throws_ok($$select public.publish_drawing_revision('a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000005',null)$$,'P0001',null,'publication cannot cross tenant boundary');
select throws_ok($$select public.publish_drawing_revision('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000005',null,p_sheet_edits=>' {"a0000000-0000-4000-8000-000000000007":{"sheet_number":"A1"}}'::jsonb)$$,'P0001',null,'conflicting edit rolls back publication');
select is((select status from public.drawing_revisions where id='a0000000-0000-4000-8000-000000000005'),'draft','revision remains draft after failed transaction');
select is((select count(*) from public.drawing_sheets where project_id='a0000000-0000-4000-8000-000000000003' and current_revision_id is not null),0::bigint,'no partial current pointers after rollback');
select public.publish_drawing_revision('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000005',null);
select is((select count(*) from public.drawing_sheets s join public.drawing_sheet_versions v on v.drawing_sheet_id=s.id and v.drawing_revision_id=s.current_revision_id where s.project_id='a0000000-0000-4000-8000-000000000003'),2::bigint,'published current pointers select each intended version');
select * from finish();
rollback;
