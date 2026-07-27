-- Acme Production demo seed
--
-- NOT a migration. This is dev/demo data for ONE org and must never run as part
-- of `supabase db push`. Every statement is scoped to
--   org_id = 7a427663-6fe8-4072-9a31-96e19ab3976d  ("Acme Production")
-- and is re-runnable: fixed UUIDs plus `on conflict do nothing` / `not exists`
-- guards mean a second run is a no-op rather than a duplicate.
--
-- Run with:  psql "$DATABASE_URL" -f supabase/seeds/acme-production.sql
--
-- Produces 17 sales deals spread across all seven lifecycle stages plus one
-- lost, 3 communities, 36 lots, 15 homes, 11 build schedules, 5 start packages
-- and 4 warranty requests.
--
-- Pre-existing fixtures this builds on (already in the org, not created here):
--   divisions   FL 6a0f45a8-7d58-458f-8aa8-c47e7df49bc0, CA cf3429f2-48f9-463a-ab1f-ff9d57b7522b
--   community   Cypress Landing 23b92164-6c95-4bfd-ab39-cd96d2a14f20
--   plans       CL1650 The Mangrove / CL1900 The Palmetto / CL2400 The Banyan
--   user        Agustin Zenuto 41740fb0-8a05-4a78-9be8-2314e0df7a4c

begin;

-- ---------------------------------------------------------------- geography --

update public.communities set division_id = '6a0f45a8-7d58-458f-8aa8-c47e7df49bc0'
where org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
  and id = '23b92164-6c95-4bfd-ab39-cd96d2a14f20' and division_id is null;

insert into public.communities (id, org_id, division_id, name, code, status, city, state, planned_lot_count) values
  ('c0000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','Saw Grass Pointe','SGP','active','Naples','FL',48),
  ('c0000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','Heron Preserve','HRP','active','Bonita Springs','FL',36)
on conflict (id) do nothing;

insert into public.community_phases (id, org_id, community_id, name, phase_number, status, target_open_date) values
  ('c1000000-0000-4000-8000-000000000021','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','Phase 1',1,'open','2026-01-15'),
  ('c1000000-0000-4000-8000-000000000022','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','Phase 2',2,'planned','2026-11-01'),
  ('c1000000-0000-4000-8000-000000000031','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','Phase 1',1,'open','2026-03-01')
on conflict (id) do nothing;

insert into public.lots (id, org_id, community_id, community_phase_id, division_id, lot_number, status, premium_cents, house_plan_id, swing) values
  ('10000000-0000-4000-8000-000000000201','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','101','developed',2500000,'34773e0e-23a8-43d4-90fe-6de278b85dec','left'),
  ('10000000-0000-4000-8000-000000000202','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','102','developed',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','right'),
  ('10000000-0000-4000-8000-000000000203','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','103','developed',1200000,'929facc6-c31a-48ac-9e4f-3e9b02c8db48','either'),
  ('10000000-0000-4000-8000-000000000204','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','104','assigned',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','left'),
  ('10000000-0000-4000-8000-000000000205','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','105','assigned',1800000,'34773e0e-23a8-43d4-90fe-6de278b85dec','right'),
  ('10000000-0000-4000-8000-000000000206','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','106','started',0,'929facc6-c31a-48ac-9e4f-3e9b02c8db48','either'),
  ('10000000-0000-4000-8000-000000000207','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','107','started',2200000,'34773e0e-23a8-43d4-90fe-6de278b85dec','left'),
  ('10000000-0000-4000-8000-000000000208','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000021','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','108','started',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','right'),
  ('10000000-0000-4000-8000-000000000209','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000022','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','201','controlled',0,'929facc6-c31a-48ac-9e4f-3e9b02c8db48','either'),
  ('10000000-0000-4000-8000-000000000210','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000022','6a0f45a8-7d58-458f-8aa8-c47e7df49bc0','202','controlled',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','either'),
  ('10000000-0000-4000-8000-000000000301','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','1','developed',3500000,'34773e0e-23a8-43d4-90fe-6de278b85dec','left'),
  ('10000000-0000-4000-8000-000000000302','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','2','developed',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','right'),
  ('10000000-0000-4000-8000-000000000303','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','3','developed',0,'929facc6-c31a-48ac-9e4f-3e9b02c8db48','either'),
  ('10000000-0000-4000-8000-000000000304','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','4','assigned',2800000,'34773e0e-23a8-43d4-90fe-6de278b85dec','left'),
  ('10000000-0000-4000-8000-000000000305','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','5','started',0,'9bfef184-760e-47a0-9a22-51817a7f6dfb','right'),
  ('10000000-0000-4000-8000-000000000306','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000031','cf3429f2-48f9-463a-ab1f-ff9d57b7522b','6','started',1500000,'929facc6-c31a-48ac-9e4f-3e9b02c8db48','either')
on conflict (id) do nothing;

update public.lots l set division_id = c.division_id
from public.communities c
where l.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
  and c.id = l.community_id and l.division_id is distinct from c.division_id;

-- ------------------------------------------------------------------ pricing --
-- Without community_plan_availability every asking price collapses to the lot
-- premium, so this table is load-bearing for Sales, Inventory and the price sheet.

insert into public.community_plan_availability (org_id, community_id, house_plan_id, elevation_id, is_available, base_price_cents, effective_start)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, c.community_id::uuid, c.house_plan_id::uuid, c.elevation_id::uuid, true, c.base_price_cents, '2026-01-01'::date
from (values
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','929facc6-c31a-48ac-9e4f-3e9b02c8db48','a4cb7e47-36c9-4ba6-8a88-9b129ed91fa6',38500000),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','929facc6-c31a-48ac-9e4f-3e9b02c8db48','c11d5935-9e30-4403-b09d-408084cf9804',39300000),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','9bfef184-760e-47a0-9a22-51817a7f6dfb','f7d57a78-1e6a-4e8c-8d20-4b05f8cf9900',43200000),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','9bfef184-760e-47a0-9a22-51817a7f6dfb','631385ee-90ea-48c4-a996-d37fa738234a',44000000),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','34773e0e-23a8-43d4-90fe-6de278b85dec','bfe50e4c-4d63-422c-95d4-4dde7b265fcf',50500000),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','34773e0e-23a8-43d4-90fe-6de278b85dec','edde433d-6340-4658-83bb-224c1d421625',51300000),
  ('c0000000-0000-4000-8000-000000000002','929facc6-c31a-48ac-9e4f-3e9b02c8db48','a4cb7e47-36c9-4ba6-8a88-9b129ed91fa6',39900000),
  ('c0000000-0000-4000-8000-000000000002','929facc6-c31a-48ac-9e4f-3e9b02c8db48','c11d5935-9e30-4403-b09d-408084cf9804',40700000),
  ('c0000000-0000-4000-8000-000000000002','9bfef184-760e-47a0-9a22-51817a7f6dfb','f7d57a78-1e6a-4e8c-8d20-4b05f8cf9900',44900000),
  ('c0000000-0000-4000-8000-000000000002','9bfef184-760e-47a0-9a22-51817a7f6dfb','631385ee-90ea-48c4-a996-d37fa738234a',45700000),
  ('c0000000-0000-4000-8000-000000000002','34773e0e-23a8-43d4-90fe-6de278b85dec','bfe50e4c-4d63-422c-95d4-4dde7b265fcf',52400000),
  ('c0000000-0000-4000-8000-000000000002','34773e0e-23a8-43d4-90fe-6de278b85dec','edde433d-6340-4658-83bb-224c1d421625',53200000),
  ('c0000000-0000-4000-8000-000000000003','929facc6-c31a-48ac-9e4f-3e9b02c8db48','a4cb7e47-36c9-4ba6-8a88-9b129ed91fa6',42500000),
  ('c0000000-0000-4000-8000-000000000003','929facc6-c31a-48ac-9e4f-3e9b02c8db48','c11d5935-9e30-4403-b09d-408084cf9804',43300000),
  ('c0000000-0000-4000-8000-000000000003','9bfef184-760e-47a0-9a22-51817a7f6dfb','f7d57a78-1e6a-4e8c-8d20-4b05f8cf9900',47800000),
  ('c0000000-0000-4000-8000-000000000003','9bfef184-760e-47a0-9a22-51817a7f6dfb','631385ee-90ea-48c4-a996-d37fa738234a',48600000),
  ('c0000000-0000-4000-8000-000000000003','34773e0e-23a8-43d4-90fe-6de278b85dec','bfe50e4c-4d63-422c-95d4-4dde7b265fcf',55900000),
  ('c0000000-0000-4000-8000-000000000003','34773e0e-23a8-43d4-90fe-6de278b85dec','edde433d-6340-4658-83bb-224c1d421625',56700000)
) as c(community_id, house_plan_id, elevation_id, base_price_cents)
where not exists (
  select 1 from public.community_plan_availability a
  where a.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d'
    and a.community_id = c.community_id::uuid and a.house_plan_id = c.house_plan_id::uuid
    and a.elevation_id is not distinct from c.elevation_id::uuid);

update public.lots l set house_plan_elevation_id = e.id
from public.house_plan_elevations e
where l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d'
  and e.house_plan_id = l.house_plan_id and e.code = 'A' and l.house_plan_elevation_id is null;

insert into public.incentives (id, org_id, community_id, name, incentive_type, amount_cents, applies_to, status, effective_start, effective_end) values
  ('e0000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Summer Close-Out — $10,000 off','fixed_amount',1000000,'price','active','2026-06-01','2026-09-30'),
  ('e0000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000002','Design Studio Credit $7,500','fixed_amount',750000,'design_credit','active','2026-07-01','2026-12-31')
on conflict (id) do nothing;
insert into public.incentives (id, org_id, community_id, name, incentive_type, percent, applies_to, status, effective_start, effective_end) values
  ('e0000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','c0000000-0000-4000-8000-000000000003','Grand Opening — 2% off base','percent_of_base',2.00,'price','active','2026-03-01','2026-08-31')
on conflict (id) do nothing;

-- ------------------------------------------------------------------- buyers --
-- Only buyers who reached a hold or beyond earn a directory contact.

insert into public.contacts (id, org_id, full_name, email, phone, contact_type) values
  ('c2000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','Dana Reyes','dana.reyes@example.com','(239) 210-8890','client'),
  ('c2000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','Grant Whitfield','grant.whitfield@example.com','(239) 663-4420','client'),
  ('c2000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','Rachel Kim','rachel.kim@example.com','(239) 771-0355','client'),
  ('c2000000-0000-4000-8000-000000000004','7a427663-6fe8-4072-9a31-96e19ab3976d','Priya Nandakumar','priya.n@example.com','(239) 305-7712','client'),
  ('c2000000-0000-4000-8000-000000000005','7a427663-6fe8-4072-9a31-96e19ab3976d','Tom & Gail Brennan','brennan.family@example.com','(239) 889-3301','client'),
  ('c2000000-0000-4000-8000-000000000006','7a427663-6fe8-4072-9a31-96e19ab3976d','Marcus Hill','marcus.hill@example.com','(239) 190-4477','client'),
  ('c2000000-0000-4000-8000-000000000007','7a427663-6fe8-4072-9a31-96e19ab3976d','Ben & Rosa Alvarez','alvarez.home@example.com','(239) 224-6608','client'),
  ('c2000000-0000-4000-8000-000000000008','7a427663-6fe8-4072-9a31-96e19ab3976d','Sandra Pooley','sandra.pooley@example.com','(239) 556-8812','client'),
  ('c2000000-0000-4000-8000-000000000009','7a427663-6fe8-4072-9a31-96e19ab3976d','Victor Osei','victor.osei@example.com','(239) 447-1120','client'),
  ('c2000000-0000-4000-8000-000000000010','7a427663-6fe8-4072-9a31-96e19ab3976d','Helen Vasquez','helen.vasquez@example.com','(239) 332-9074','client')
on conflict (id) do nothing;

-- --------------------------------------------------------------- the funnel --
-- Dates are absolute so the board's urgency mix is reproducible: seeded against
-- "today" = 2026-07-25. Shift these if you re-seed much later.

insert into public.prospects (id, org_id, name, status, owner_user_id, community_id, source, budget_range, timeline_preference, tags, notes, next_follow_up_at, won_at, lost_at, lost_reason, created_at, updated_at) values
  ('40000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','Alicia Fontaine','new','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Web inquiry','$380k–$450k','6-12 months','{}','Wants single story, no stairs.',null,null,null,null,'2026-07-22 14:10:00+00','2026-07-22 14:10:00+00'),
  ('40000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','Marcus Webb','new','41740fb0-8a05-4a78-9be8-2314e0df7a4c','c0000000-0000-4000-8000-000000000002','Model walk-in','$450k–$520k','3-6 months','{}','Walked the Palmetto model Saturday.',null,null,null,null,'2026-07-25 13:00:00+00','2026-07-25 13:00:00+00'),
  ('40000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','Devon Okafor','contacted','41740fb0-8a05-4a78-9be8-2314e0df7a4c','c0000000-0000-4000-8000-000000000002','Realtor referral','$430k–$500k','3-6 months','{"realtor-co-op"}','Comparing Palmetto vs Banyan.','2026-07-24 16:00:00+00',null,null,null,'2026-06-30 11:00:00+00','2026-07-10 09:00:00+00'),
  ('40000000-0000-4000-8000-000000000004','7a427663-6fe8-4072-9a31-96e19ab3976d','Nina Castellanos','qualified','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Web inquiry','$500k+','0-3 months','{"pre-approved"}','Pre-approved to $560k with Summit Mortgage.','2026-07-25 19:00:00+00',null,null,null,'2026-07-02 15:30:00+00','2026-07-18 12:00:00+00'),
  ('40000000-0000-4000-8000-000000000005','7a427663-6fe8-4072-9a31-96e19ab3976d','Rob Iverson','contacted','41740fb0-8a05-4a78-9be8-2314e0df7a4c','c0000000-0000-4000-8000-000000000003','Sign / drive-by','$400k–$470k','6-12 months','{}','Relocating from Ohio in the spring.','2026-07-30 15:00:00+00',null,null,null,'2026-07-08 10:20:00+00','2026-07-19 14:00:00+00'),
  ('40000000-0000-4000-8000-000000000006','7a427663-6fe8-4072-9a31-96e19ab3976d','Marisol Duarte','qualified','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Model walk-in','$380k–$430k','3-6 months','{}','Needs to sell current home first.',null,null,null,null,'2026-05-14 13:45:00+00','2026-06-28 16:00:00+00'),
  ('40000000-0000-4000-8000-000000000007','7a427663-6fe8-4072-9a31-96e19ab3976d','Kenneth Pike','lost','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Web inquiry','$350k–$400k','0-3 months','{}',null,null,null,'2026-06-20 18:00:00+00','Bought resale','2026-04-02 09:00:00+00','2026-06-20 18:00:00+00'),
  ('40000000-0000-4000-8000-000000000008','7a427663-6fe8-4072-9a31-96e19ab3976d','Dana Reyes','qualified','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Model walk-in','$500k+','0-3 months','{"pre-approved"}','Wants side-entry garage, move-in before school year.',null,null,null,null,'2026-07-06 12:00:00+00','2026-07-20 17:00:00+00'),
  ('40000000-0000-4000-8000-000000000009','7a427663-6fe8-4072-9a31-96e19ab3976d','Grant Whitfield','qualified','41740fb0-8a05-4a78-9be8-2314e0df7a4c','c0000000-0000-4000-8000-000000000002','Model walk-in','$450k–$520k','0-3 months','{"pre-approved"}',null,null,null,null,null,'2026-07-11 15:00:00+00','2026-07-21 10:00:00+00'),
  ('40000000-0000-4000-8000-000000000010','7a427663-6fe8-4072-9a31-96e19ab3976d','Rachel Kim','qualified','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Web inquiry','$450k–$520k','0-3 months','{"pre-approved"}','Agreement sent 21 Jul, awaiting signature.',null,null,null,null,'2026-06-12 10:00:00+00','2026-07-21 16:00:00+00'),
  ('40000000-0000-4000-8000-000000000011','7a427663-6fe8-4072-9a31-96e19ab3976d','Priya Nandakumar','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Realtor referral','$500k+','0-3 months','{"realtor-co-op"}',null,null,'2026-07-14 15:00:00+00',null,null,'2026-05-20 11:00:00+00','2026-07-14 15:00:00+00'),
  ('40000000-0000-4000-8000-000000000012','7a427663-6fe8-4072-9a31-96e19ab3976d','Tom & Gail Brennan','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Repeat buyer','$500k+','0-3 months','{"repeat"}',null,null,'2026-04-08 14:00:00+00',null,null,'2026-02-26 09:30:00+00','2026-04-08 14:00:00+00'),
  ('40000000-0000-4000-8000-000000000013','7a427663-6fe8-4072-9a31-96e19ab3976d','Victor Osei','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','c0000000-0000-4000-8000-000000000002','Web inquiry','$450k–$520k','0-3 months','{}',null,null,'2026-05-02 16:00:00+00',null,null,'2026-03-15 13:00:00+00','2026-05-02 16:00:00+00'),
  ('40000000-0000-4000-8000-000000000014','7a427663-6fe8-4072-9a31-96e19ab3976d','Marcus Hill','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Realtor referral','$500k+','0-3 months','{"realtor-co-op"}',null,null,'2026-01-22 10:00:00+00',null,null,'2025-12-04 11:00:00+00','2026-01-22 10:00:00+00'),
  ('40000000-0000-4000-8000-000000000015','7a427663-6fe8-4072-9a31-96e19ab3976d','Ben & Rosa Alvarez','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Model walk-in','$450k–$520k','0-3 months','{}',null,null,'2026-01-09 15:00:00+00',null,null,'2025-11-18 14:00:00+00','2026-01-09 15:00:00+00'),
  ('40000000-0000-4000-8000-000000000016','7a427663-6fe8-4072-9a31-96e19ab3976d','Sandra Pooley','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Web inquiry','$380k–$450k','0-3 months','{}',null,null,'2025-10-30 12:00:00+00',null,null,'2025-09-12 10:00:00+00','2026-06-11 16:00:00+00'),
  ('40000000-0000-4000-8000-000000000017','7a427663-6fe8-4072-9a31-96e19ab3976d','Helen Vasquez','won','41740fb0-8a05-4a78-9be8-2314e0df7a4c','23b92164-6c95-4bfd-ab39-cd96d2a14f20','Model walk-in','$380k–$450k','0-3 months','{}',null,null,'2025-11-14 12:00:00+00',null,null,'2025-09-28 09:00:00+00','2026-05-22 16:00:00+00')
on conflict (id) do nothing;

insert into public.prospect_contacts (org_id, prospect_id, full_name, email, phone, is_primary)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, p.id, v.full_name, v.email, v.phone, true
from (values
  ('40000000-0000-4000-8000-000000000001','Alicia Fontaine','alicia.fontaine@example.com','(239) 448-2091'),
  ('40000000-0000-4000-8000-000000000002','Marcus Webb','marcus.webb@example.com','(239) 512-7734'),
  ('40000000-0000-4000-8000-000000000003','Devon Okafor','devon.okafor@example.com','(239) 900-1174'),
  ('40000000-0000-4000-8000-000000000004','Nina Castellanos','nina.castellanos@example.com','(239) 655-2210'),
  ('40000000-0000-4000-8000-000000000005','Rob Iverson','rob.iverson@example.com','(239) 774-8890'),
  ('40000000-0000-4000-8000-000000000006','Marisol Duarte','marisol.duarte@example.com','(239) 221-6643'),
  ('40000000-0000-4000-8000-000000000007','Kenneth Pike','kenneth.pike@example.com','(239) 388-0091'),
  ('40000000-0000-4000-8000-000000000008','Dana Reyes','dana.reyes@example.com','(239) 210-8890'),
  ('40000000-0000-4000-8000-000000000009','Grant Whitfield','grant.whitfield@example.com','(239) 663-4420'),
  ('40000000-0000-4000-8000-000000000010','Rachel Kim','rachel.kim@example.com','(239) 771-0355')
) as v(prospect_id, full_name, email, phone)
join public.prospects p on p.id = v.prospect_id::uuid and p.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d'
where not exists (select 1 from public.prospect_contacts pc where pc.prospect_id = p.id);

-- -------------------------------------------------------------------- homes --

create temp table seed_homes (
  community_id uuid, lot_number text, project_id uuid, status text,
  start_date date, end_date date, client_id uuid
) on commit drop;

insert into seed_homes values
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','10','50000000-0000-4000-8000-000000000001','active',null,'2026-12-18','c2000000-0000-4000-8000-000000000003'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','11','50000000-0000-4000-8000-000000000002','active',null,'2026-11-20','c2000000-0000-4000-8000-000000000004'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','12','50000000-0000-4000-8000-000000000003','active','2026-03-10','2026-09-19','c2000000-0000-4000-8000-000000000005'),
  ('c0000000-0000-4000-8000-000000000002','107','50000000-0000-4000-8000-000000000004','active','2026-04-01','2026-10-15','c2000000-0000-4000-8000-000000000009'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','13','50000000-0000-4000-8000-000000000005','active','2026-01-20','2026-07-29','c2000000-0000-4000-8000-000000000006'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','14','50000000-0000-4000-8000-000000000006','active','2026-02-05','2026-07-28','c2000000-0000-4000-8000-000000000007'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','18','50000000-0000-4000-8000-000000000007','completed','2025-08-15','2026-06-11','c2000000-0000-4000-8000-000000000008'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','19','50000000-0000-4000-8000-000000000008','completed','2025-09-01','2026-05-22','c2000000-0000-4000-8000-000000000010'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','15','50000000-0000-4000-8000-000000000009','active','2026-02-20',null,null),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','16','50000000-0000-4000-8000-000000000010','active','2026-05-10',null,null),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','17','50000000-0000-4000-8000-000000000011','active','2026-06-25',null,null),
  ('c0000000-0000-4000-8000-000000000002','106','50000000-0000-4000-8000-000000000012','active','2026-03-05',null,null),
  ('c0000000-0000-4000-8000-000000000002','108','50000000-0000-4000-8000-000000000013','active','2026-06-01',null,null),
  ('c0000000-0000-4000-8000-000000000003','5','50000000-0000-4000-8000-000000000014','active','2026-04-20',null,null),
  ('c0000000-0000-4000-8000-000000000003','6','50000000-0000-4000-8000-000000000015','active','2026-05-30',null,null);

-- property_type must be 'production' or listMyHouses/listMyHouseWork return nothing.
insert into public.projects (id, org_id, name, status, property_type, project_type, start_date, end_date, client_id, division_id, superintendent_id, created_by)
select h.project_id, '7a427663-6fe8-4072-9a31-96e19ab3976d',
       case c.code when 'SGP' then 'SGP' when 'HRP' then 'HRP' else 'CL' end || ' Lot ' || h.lot_number || ' — ' || hp.name,
       h.status::project_status, 'production'::project_property_type, 'new_construction'::project_work_type,
       h.start_date, h.end_date, h.client_id, c.division_id,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c', '41740fb0-8a05-4a78-9be8-2314e0df7a4c'
from seed_homes h
join public.communities c on c.id = h.community_id
join public.lots l on l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and l.community_id = h.community_id and l.lot_number = h.lot_number
join public.house_plans hp on hp.id = l.house_plan_id
on conflict (id) do nothing;

update public.lots l set project_id = h.project_id
from seed_homes h
where l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d'
  and l.community_id = h.community_id and l.lot_number = h.lot_number and l.project_id is null;

-- ------------------------------------------------------ holds & agreements --

create temp table seed_res (
  res_id uuid, community_id uuid, lot_number text, prospect_id uuid, buyer_contact_id uuid,
  status text, expires_at timestamptz, asking_cents bigint, deposit_cents bigint, converted_at timestamptz
) on commit drop;

insert into seed_res values
  ('60000000-0000-4000-8000-000000000001','23b92164-6c95-4bfd-ab39-cd96d2a14f20','9','40000000-0000-4000-8000-000000000008','c2000000-0000-4000-8000-000000000001','hold','2026-07-27 23:59:00+00',48750000,250000,null),
  ('60000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','104','40000000-0000-4000-8000-000000000009','c2000000-0000-4000-8000-000000000002','hold','2026-08-03 23:59:00+00',46200000,250000,null),
  ('60000000-0000-4000-8000-000000000003','23b92164-6c95-4bfd-ab39-cd96d2a14f20','10','40000000-0000-4000-8000-000000000010','c2000000-0000-4000-8000-000000000003','reserved',null,44900000,2500000,null),
  ('60000000-0000-4000-8000-000000000004','23b92164-6c95-4bfd-ab39-cd96d2a14f20','11','40000000-0000-4000-8000-000000000011','c2000000-0000-4000-8000-000000000004','converted',null,53700000,2500000,'2026-07-14 15:00:00+00'),
  ('60000000-0000-4000-8000-000000000005','23b92164-6c95-4bfd-ab39-cd96d2a14f20','12','40000000-0000-4000-8000-000000000012','c2000000-0000-4000-8000-000000000005','converted',null,41200000,2500000,'2026-04-08 14:00:00+00'),
  ('60000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000002','107','40000000-0000-4000-8000-000000000013','c2000000-0000-4000-8000-000000000009','converted',null,57800000,2500000,'2026-05-02 16:00:00+00'),
  ('60000000-0000-4000-8000-000000000007','23b92164-6c95-4bfd-ab39-cd96d2a14f20','13','40000000-0000-4000-8000-000000000014','c2000000-0000-4000-8000-000000000006','converted',null,45200000,2500000,'2026-01-22 10:00:00+00'),
  ('60000000-0000-4000-8000-000000000008','23b92164-6c95-4bfd-ab39-cd96d2a14f20','14','40000000-0000-4000-8000-000000000015','c2000000-0000-4000-8000-000000000007','converted',null,53500000,2500000,'2026-01-09 15:00:00+00'),
  ('60000000-0000-4000-8000-000000000009','23b92164-6c95-4bfd-ab39-cd96d2a14f20','18','40000000-0000-4000-8000-000000000016','c2000000-0000-4000-8000-000000000008','converted',null,40100000,2500000,'2025-10-30 12:00:00+00'),
  ('60000000-0000-4000-8000-000000000010','23b92164-6c95-4bfd-ab39-cd96d2a14f20','19','40000000-0000-4000-8000-000000000017','c2000000-0000-4000-8000-000000000010','converted',null,44900000,2500000,'2025-11-14 12:00:00+00');

insert into public.lot_reservations (id, org_id, community_id, lot_id, buyer_contact_id, prospect_id, status, expires_at, asking_price_cents, deposit_required_cents, converted_at, created_by, created_at)
select r.res_id, '7a427663-6fe8-4072-9a31-96e19ab3976d', r.community_id, l.id, r.buyer_contact_id, r.prospect_id,
       r.status, r.expires_at, r.asking_cents, r.deposit_cents, r.converted_at,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c', coalesce(r.converted_at - interval '21 days', now() - interval '5 days')
from seed_res r
join public.lots l on l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and l.community_id = r.community_id and l.lot_number = r.lot_number
on conflict (id) do nothing;

create temp table seed_pa (
  contract_id uuid, project_id uuid, res_id uuid, num text, title text, status text, signed_at timestamptz,
  base bigint, prem bigint, struct bigint, design bigint, incent bigint, total bigint
) on commit drop;

-- status 'draft' means out for signature; the e-sign callback flips it to 'active'.
insert into seed_pa values
  ('70000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000003','PA-2026-0101','Purchase Agreement — CL Lot 10','draft',null,43200000,0,1800000,900000,1000000,44900000),
  ('70000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000004','PA-2026-0102','Purchase Agreement — CL Lot 11','active','2026-07-14 15:00:00+00',50500000,1500000,1500000,1200000,1000000,53700000),
  ('70000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000005','PA-2026-0103','Purchase Agreement — CL Lot 12','active','2026-04-08 14:00:00+00',38500000,0,2200000,1500000,1000000,41200000),
  ('70000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000004','60000000-0000-4000-8000-000000000006','PA-2026-0104','Purchase Agreement — SGP Lot 107','active','2026-05-02 16:00:00+00',52400000,2200000,1900000,1300000,0,57800000),
  ('70000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000005','60000000-0000-4000-8000-000000000007','PA-2026-0105','Purchase Agreement — CL Lot 13','active','2026-01-22 10:00:00+00',43200000,0,1200000,800000,0,45200000),
  ('70000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000006','60000000-0000-4000-8000-000000000008','PA-2026-0106','Purchase Agreement — CL Lot 14','active','2026-01-09 15:00:00+00',50500000,0,2400000,1600000,1000000,53500000),
  ('70000000-0000-4000-8000-000000000007','50000000-0000-4000-8000-000000000007','60000000-0000-4000-8000-000000000009','PA-2025-0107','Purchase Agreement — CL Lot 18','active','2025-10-30 12:00:00+00',38500000,0,900000,700000,0,40100000),
  ('70000000-0000-4000-8000-000000000008','50000000-0000-4000-8000-000000000008','60000000-0000-4000-8000-000000000010','PA-2025-0108','Purchase Agreement — CL Lot 19','active','2025-11-14 12:00:00+00',43200000,0,1100000,600000,0,44900000);

-- Pricing keys are camelCase to match composePurchaseAgreementPricing.
insert into public.contracts (id, org_id, project_id, number, title, status, contract_type, total_cents, currency, signed_at, effective_date, snapshot, created_at)
select p.contract_id, '7a427663-6fe8-4072-9a31-96e19ab3976d', p.project_id, p.num, p.title, p.status, 'purchase_agreement',
       p.total::int, 'usd', p.signed_at, coalesce(p.signed_at::date, '2026-07-21'::date),
       jsonb_build_object('purchase_agreement', jsonb_build_object(
         'version', 1,
         'pricing', jsonb_build_object(
           'basePriceCents', p.base, 'lotPremiumCents', p.prem,
           'structuralOptions', '[]'::jsonb, 'designSelections', '[]'::jsonb, 'incentives', '[]'::jsonb,
           'structuralOptionsCents', p.struct, 'designSelectionsCents', p.design,
           'incentivesCents', p.incent, 'totalCents', p.total))),
       coalesce(p.signed_at - interval '10 days', '2026-07-21 00:00:00+00')
from seed_pa p
on conflict (id) do nothing;

update public.lot_reservations r set contract_id = p.contract_id
from seed_pa p where r.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and r.id = p.res_id and r.contract_id is null;

update public.projects j set total_contract_value_cents = p.total::int
from seed_pa p where j.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and j.id = p.project_id;

-- ----------------------------------------------------------------- closings --

create temp table seed_cl (
  closing_id uuid, project_id uuid, community_id uuid, lot_number text, status text,
  scheduled_date date, actual_date date, final_cents bigint
) on commit drop;

insert into seed_cl values
  ('80000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','23b92164-6c95-4bfd-ab39-cd96d2a14f20','11','projected',null,null,null),
  ('80000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000003','23b92164-6c95-4bfd-ab39-cd96d2a14f20','12','projected','2026-09-19',null,null),
  ('80000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000002','107','projected','2026-10-15',null,null),
  ('80000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000005','23b92164-6c95-4bfd-ab39-cd96d2a14f20','13','scheduled','2026-07-29',null,null),
  ('80000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000006','23b92164-6c95-4bfd-ab39-cd96d2a14f20','14','cleared_to_close','2026-07-28',null,null),
  ('80000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000007','23b92164-6c95-4bfd-ab39-cd96d2a14f20','18','closed','2026-06-11','2026-06-11',40100000),
  ('80000000-0000-4000-8000-000000000007','50000000-0000-4000-8000-000000000008','23b92164-6c95-4bfd-ab39-cd96d2a14f20','19','closed','2026-05-22','2026-05-22',44900000);

insert into public.closings (id, org_id, project_id, lot_id, community_id, status, scheduled_date, actual_date, settlement, created_by)
select s.closing_id, '7a427663-6fe8-4072-9a31-96e19ab3976d', s.project_id, l.id, s.community_id, s.status,
       s.scheduled_date, s.actual_date,
       case when s.final_cents is null then '{}'::jsonb else jsonb_build_object('final_price_cents', s.final_cents) end,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c'
from seed_cl s
join public.lots l on l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and l.community_id = s.community_id and l.lot_number = s.lot_number
on conflict (id) do nothing;

-- Marcus Hill (closing 004) keeps one gate open; that is what makes his the
-- urgent row on the board. Everyone further along is clear.
insert into public.closing_checklist_items (org_id, closing_id, title, status, is_gate, sort_order, completed_at, created_by)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, s.closing_id, v.title,
       case when s.status in ('cleared_to_close','closed') then 'complete'
            when s.status = 'scheduled' and v.sort_order >= 6 then 'open'
            when s.status = 'scheduled' then 'complete'
            else 'open' end,
       v.is_gate, v.sort_order,
       case when s.status in ('cleared_to_close','closed') then coalesce(s.actual_date, s.scheduled_date)::timestamptz
            when s.status = 'scheduled' and v.sort_order < 6 then '2026-07-15 12:00:00+00'::timestamptz
            else null end,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c'
from seed_cl s
cross join (values
  ('Purchase agreement executed', true, 0),
  ('Earnest money received', true, 1),
  ('Final inspection / certificate of occupancy', true, 2),
  ('Blue-tape walk complete', true, 3),
  ('Open punch items cleared', true, 4),
  ('Homeowner orientation complete', true, 5),
  ('Final settlement statement reconciled', true, 6),
  ('Warranty package delivered', false, 7),
  ('HOA and closing documents delivered', false, 8)
) as v(title, is_gate, sort_order)
where s.status in ('scheduled','cleared_to_close','closed')
  and not exists (select 1 from public.closing_checklist_items i where i.closing_id = s.closing_id);

-- ------------------------------------------------------------ build & field --
-- A nine-task build sequence per started home, dated off the project start so
-- some work always lands in the superintendent's current week.

insert into public.schedule_items (org_id, project_id, name, item_type, status, trade, phase, start_date, end_date, progress, sort_order, assigned_to)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, j.id, t.name, 'task',
  case when (j.start_date + t.off + t.dur) < current_date then 'completed'
       when (j.start_date + t.off) <= current_date then 'in_progress' else 'planned' end,
  t.trade, t.phase, j.start_date + t.off, j.start_date + t.off + t.dur,
  case when (j.start_date + t.off + t.dur) < current_date then 100
       when (j.start_date + t.off) <= current_date then 45 else 0 end,
  t.ord, '41740fb0-8a05-4a78-9be8-2314e0df7a4c'
from public.projects j
join public.lots l on l.org_id = j.org_id and l.project_id = j.id and l.status = 'started'
cross join (values
  ('Lot prep & footings','Sitework','Foundation',0,5,1),
  ('Slab pour','Concrete','Foundation',6,4,2),
  ('Framing','Framing','Structure',12,14,3),
  ('Roof dry-in','Roofing','Structure',27,6,4),
  ('Rough plumbing, electric & HVAC','Mechanical','Rough-in',34,12,5),
  ('Drywall','Drywall','Interior',48,10,6),
  ('Interior trim & paint','Finish Carpentry','Interior',60,14,7),
  ('Flooring & fixtures','Flooring','Interior',76,12,8),
  ('Final grade & punch','Sitework','Closeout',90,8,9)
) as t(name, trade, phase, off, dur, ord)
where j.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d' and j.start_date is not null
  and not exists (select 1 from public.schedule_items s where s.project_id = j.id);

-- target_week must be a Monday (start_packages_target_week_check).
insert into public.start_packages (org_id, lot_id, community_id, project_id, status, is_financed, target_week, scheduled_start_date, notes)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, l.id, l.community_id, l.project_id,
       v.status, v.financed, v.target_week::date, v.sched::date, v.notes
from (values
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','11','ready',   true, '2026-07-27','2026-07-29','Agreement executed, permits in hand.'),
  ('23b92164-6c95-4bfd-ab39-cd96d2a14f20','10','open',    true, '2026-08-03','2026-08-05','Waiting on buyer signature.'),
  ('c0000000-0000-4000-8000-000000000002','105','ready',  false,'2026-08-03','2026-08-06','Spec start — no buyer.'),
  ('c0000000-0000-4000-8000-000000000003','4','attention',false,'2026-08-10','2026-08-12','Plot plan revision pending from engineering.'),
  ('c0000000-0000-4000-8000-000000000002','104','open',   true, '2026-08-17','2026-08-19','Lot on hold; release when contract lands.')
) as v(community_id, lot_number, status, financed, target_week, sched, notes)
join public.lots l on l.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d'
  and l.community_id = v.community_id::uuid and l.lot_number = v.lot_number
where not exists (select 1 from public.start_packages sp where sp.lot_id = l.id);

-- ---------------------------------------------------------------- warranty --

insert into public.warranty_requests (org_id, project_id, request_number, title, description, status, severity, source, coverage_status, category, priority, assigned_user_id, scheduled_date, created_at, closed_at)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, v.project_id::uuid, v.num, v.title, v.descr, v.status, v.sev, 'office', v.cov, v.cat, v.pri,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c', v.sched::date, v.created::timestamptz, v.closed::timestamptz
from (values
  ('50000000-0000-4000-8000-000000000007',1,'Master bath faucet drips','Homeowner reports a steady drip at the master vanity.','open','routine_30','in_warranty','Plumbing','normal','2026-07-30','2026-07-18 14:00:00+00',null),
  ('50000000-0000-4000-8000-000000000007',2,'Drywall nail pops in hallway','Several nail pops after first summer.','scheduled','routine_60','in_warranty','Drywall','low','2026-08-06','2026-07-02 10:00:00+00',null),
  ('50000000-0000-4000-8000-000000000008',3,'AC not cooling upstairs','Second floor will not hold set temperature.','open','emergency','in_warranty','HVAC','high','2026-07-26','2026-07-24 08:30:00+00',null),
  ('50000000-0000-4000-8000-000000000008',4,'Garage door remote pairing','Remote lost pairing; homeowner re-paired with tech over phone.','closed','routine_30','in_warranty','Garage','low','2026-06-20','2026-06-15 16:00:00+00','2026-06-20 11:00:00+00')
) as v(project_id, num, title, descr, status, sev, cov, cat, pri, sched, created, closed)
where not exists (select 1 from public.warranty_requests w where w.org_id='7a427663-6fe8-4072-9a31-96e19ab3976d' and w.request_number = v.num);

-- ----------------------------------------------------------- design studio --
--
-- Option catalog, cutoff rules, and per-home selections. Cutoffs are derived
-- here the same way lib/selections/cutoff-math.ts derives them at runtime:
-- match a schedule item by its slugified name, then offset from its start date.

insert into public.selection_categories (id, org_id, name, description, sort_order) values
  ('d1000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','Elevation','Front elevation and masonry treatment',1),
  ('d1000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','Exterior colour','Body, trim and accent scheme',2),
  ('d1000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','Kitchen layout','Structural kitchen configuration',3),
  ('d1000000-0000-4000-8000-000000000004','7a427663-6fe8-4072-9a31-96e19ab3976d','Cabinetry','Door style and finish',4),
  ('d1000000-0000-4000-8000-000000000005','7a427663-6fe8-4072-9a31-96e19ab3976d','Countertops','Kitchen and bath surfaces',5),
  ('d1000000-0000-4000-8000-000000000006','7a427663-6fe8-4072-9a31-96e19ab3976d','Flooring','Main living areas',6),
  ('d1000000-0000-4000-8000-000000000007','7a427663-6fe8-4072-9a31-96e19ab3976d','Tile','Bath and backsplash',7),
  ('d1000000-0000-4000-8000-000000000008','7a427663-6fe8-4072-9a31-96e19ab3976d','Plumbing fixtures','Faucets, sinks and trim',8),
  ('d1000000-0000-4000-8000-000000000009','7a427663-6fe8-4072-9a31-96e19ab3976d','Lighting','Fixtures and switching',9)
on conflict (id) do nothing;

-- One standard grade per category (included, is_default) plus upgrades.
insert into public.selection_options
  (id, org_id, category_id, name, description, price_cents, price_type, cost_cents, sku, vendor, lead_time_days, sort_order, is_default, is_available, option_scope)
select v.id::uuid, '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, v.cat::uuid, v.name, v.descr,
       v.price, case when v.price = 0 then 'included' else 'upgrade' end, v.cost,
       v.sku, v.vendor, v.lead, v.ord, v.price = 0, true, v.scope
from (values
  ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','Elevation A — Coastal','Standard elevation',0,412000,'ELV-A','Acme Framing',0,1,'structural'),
  ('d2000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001','Elevation B — Craftsman','Gable detail and column wraps',780000,498000,'ELV-B','Acme Framing',0,2,'structural'),
  ('d2000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000001','Elevation C — Stone base','Stacked stone to sill height',1240000,742000,'ELV-C','Acme Framing',0,3,'structural'),

  ('d2000000-0000-4000-8000-000000000011','d1000000-0000-4000-8000-000000000002','Shell white / slate trim','Standard scheme',0,186000,'EXT-SHW','Coastal Paint',10,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000012','d1000000-0000-4000-8000-000000000002','Dune / bronze trim','Warm neutral body',94000,204000,'EXT-DUN','Coastal Paint',10,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000013','d1000000-0000-4000-8000-000000000002','Ironbark / white trim','Deep charcoal body',148000,228000,'EXT-IRN','Coastal Paint',14,3,'design_studio'),

  ('d2000000-0000-4000-8000-000000000021','d1000000-0000-4000-8000-000000000003','Standard kitchen','As-drawn layout',0,0,'KIT-STD','—',0,1,'structural'),
  ('d2000000-0000-4000-8000-000000000022','d1000000-0000-4000-8000-000000000003','Gourmet kitchen','Wall oven, gas cooktop, extended island',1480000,912000,'KIT-GRM','Gulf Appliance',35,2,'structural'),

  ('d2000000-0000-4000-8000-000000000031','d1000000-0000-4000-8000-000000000004','Shaker — Linen','Standard painted shaker',0,486000,'CAB-LIN','Bayside Cabinet',28,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000032','d1000000-0000-4000-8000-000000000004','Shaker — Harbour blue','Painted island accent',186000,540000,'CAB-HRB','Bayside Cabinet',28,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000033','d1000000-0000-4000-8000-000000000004','Slab — White oak','Rift-sawn veneer',420000,672000,'CAB-OAK','Bayside Cabinet',42,3,'design_studio'),

  ('d2000000-0000-4000-8000-000000000041','d1000000-0000-4000-8000-000000000005','Laminate — Sandbar','Standard surface',0,118000,'CTP-SND','Stoneworks',14,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000042','d1000000-0000-4000-8000-000000000005','Quartz — Calacatta Nuvo','Veined quartz, eased edge',590000,342000,'CTP-CAL','Stoneworks',21,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000043','d1000000-0000-4000-8000-000000000005','Quartz — Ironbark','Charcoal quartz, mitred edge',630000,388000,'CTP-IRN','Stoneworks',21,3,'design_studio'),
  ('d2000000-0000-4000-8000-000000000044','d1000000-0000-4000-8000-000000000005','Granite — Absolute black','Honed finish',675000,415000,'CTP-ABK','Stoneworks',28,4,'design_studio'),

  ('d2000000-0000-4000-8000-000000000051','d1000000-0000-4000-8000-000000000006','Carpet & vinyl plank','Standard package',0,264000,'FLR-STD','Gulf Flooring',14,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000052','d1000000-0000-4000-8000-000000000006','Luxury vinyl — Driftwood','Throughout main living',312000,398000,'FLR-DRW','Gulf Flooring',18,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000053','d1000000-0000-4000-8000-000000000006','Engineered oak — Natural','Throughout main living',684000,512000,'FLR-OAK','Gulf Flooring',35,3,'design_studio'),

  ('d2000000-0000-4000-8000-000000000061','d1000000-0000-4000-8000-000000000007','Ceramic 12x12 — Bone','Standard bath tile',0,96000,'TIL-BON','Stoneworks',14,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000062','d1000000-0000-4000-8000-000000000007','Porcelain 12x24 — Chalk','Stacked bath surround',168000,142000,'TIL-CHK','Stoneworks',18,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000063','d1000000-0000-4000-8000-000000000007','Zellige — Sea salt','Handmade backsplash',245000,178000,'TIL-ZEL','Stoneworks',45,3,'design_studio'),

  ('d2000000-0000-4000-8000-000000000071','d1000000-0000-4000-8000-000000000008','Brushed nickel','Standard trim package',0,88000,'PLM-BNK','Gulf Plumbing',10,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000072','d1000000-0000-4000-8000-000000000008','Matte black','Throughout',96000,124000,'PLM-MBK','Gulf Plumbing',14,2,'design_studio'),
  ('d2000000-0000-4000-8000-000000000073','d1000000-0000-4000-8000-000000000008','Unlacquered brass','Throughout',184000,168000,'PLM-BRS','Gulf Plumbing',28,3,'design_studio'),

  ('d2000000-0000-4000-8000-000000000081','d1000000-0000-4000-8000-000000000009','Builder lighting','Standard fixtures',0,72000,'LGT-STD','Coastal Electric',7,1,'design_studio'),
  ('d2000000-0000-4000-8000-000000000082','d1000000-0000-4000-8000-000000000009','Designer lighting','Upgraded fixtures throughout',214000,132000,'LGT-DSG','Coastal Electric',21,2,'design_studio')
) as v(id, cat, name, descr, price, cost, sku, vendor, lead, ord, scope)
on conflict (id) do nothing;

-- A package a buyer takes in one click: one option per covered category.
insert into public.selection_packages (id, org_id, name, description, price_cents, cost_cents, is_available, sort_order) values
  ('d3000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','Coastal Signature',
   'Harbour blue island, Calacatta quartz, driftwood plank and matte black trim.',1520000,1004000,true,1)
on conflict (id) do nothing;

insert into public.selection_package_items (org_id, package_id, option_id)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid,'d3000000-0000-4000-8000-000000000001'::uuid, v.option_id::uuid
from (values
  ('d2000000-0000-4000-8000-000000000032'),
  ('d2000000-0000-4000-8000-000000000042'),
  ('d2000000-0000-4000-8000-000000000052'),
  ('d2000000-0000-4000-8000-000000000072')
) as v(option_id)
where not exists (
  select 1 from public.selection_package_items i
  where i.package_id='d3000000-0000-4000-8000-000000000001' and i.option_id = v.option_id::uuid);

-- Cutoff rules. schedule_task_key matches the slugified schedule item name, the
-- same fallback deriveSelectionCutoff() uses when no template key is present.
insert into public.selection_groups (id, org_id, name, schedule_task_key, cutoff_offset_days, cutoff_anchor, sort_order) values
  ('d4000000-0000-4000-8000-000000000001','7a427663-6fe8-4072-9a31-96e19ab3976d','Structural','slab-pour',-10,'start',1),
  ('d4000000-0000-4000-8000-000000000002','7a427663-6fe8-4072-9a31-96e19ab3976d','Exterior','framing',-7,'start',2),
  ('d4000000-0000-4000-8000-000000000003','7a427663-6fe8-4072-9a31-96e19ab3976d','Interior finish','drywall',-14,'start',3),
  ('d4000000-0000-4000-8000-000000000004','7a427663-6fe8-4072-9a31-96e19ab3976d','Fixtures','flooring-fixtures',-10,'start',4)
on conflict (id) do nothing;

insert into public.selection_group_categories (org_id, group_id, category_id)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, v.grp::uuid, v.cat::uuid
from (values
  ('d4000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001'),
  ('d4000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003'),
  ('d4000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000002'),
  ('d4000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000004'),
  ('d4000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000005'),
  ('d4000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000006'),
  ('d4000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000007'),
  ('d4000000-0000-4000-8000-000000000004','d1000000-0000-4000-8000-000000000008'),
  ('d4000000-0000-4000-8000-000000000004','d1000000-0000-4000-8000-000000000009')
) as v(grp, cat)
where not exists (
  select 1 from public.selection_group_categories g where g.group_id = v.grp::uuid and g.category_id = v.cat::uuid);

-- Per-home group instances. Cutoff resolves off the home's own schedule; a
-- group whose cutoff is more than three weeks past is treated as settled and
-- locked, which is what keeps the runway showing live pressure rather than
-- every historical deadline.
insert into public.project_selection_groups
  (org_id, project_id, group_id, cutoff_date, cutoff_source, status, locked_at, matched_schedule_item_id)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, l.project_id, g.id,
       si.start_date + g.cutoff_offset_days,
       'schedule',
       case when si.start_date + g.cutoff_offset_days < current_date - 21 then 'locked' else 'open' end,
       case when si.start_date + g.cutoff_offset_days < current_date - 21
            then (si.start_date + g.cutoff_offset_days)::timestamptz end,
       si.id
from public.lots l
join public.selection_groups g on g.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d' and g.community_id is null
left join lateral (
  select s.id, s.start_date
  from public.schedule_items s
  where s.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
    and s.project_id = l.project_id
    and lower(regexp_replace(trim(s.name), '[^a-zA-Z0-9]+', '-', 'g')) = g.schedule_task_key
  order by s.start_date
  limit 1
) si on true
where l.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
  and l.project_id is not null
  and l.status in ('assigned', 'started')
on conflict (project_id, group_id) do nothing;

-- One selection row per category in each instantiated group.
insert into public.project_selections (org_id, project_id, category_id, group_id, status)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, psg.project_id, gc.category_id, psg.group_id, 'pending'
from public.project_selection_groups psg
join public.selection_group_categories gc on gc.group_id = psg.group_id
where psg.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
on conflict (project_id, category_id) do nothing;

-- Locked groups are fully chosen and confirmed, with a scattering of upgrades so
-- option revenue is not uniformly zero. The option is picked in a CTE because an
-- UPDATE ... FROM cannot reference its own target from a join condition.
with target as (
  select ps.id as selection_id, o.id as option_id, o.price_cents, o.cost_cents, psg.locked_at
  from public.project_selections ps
  join public.project_selection_groups psg
    on psg.org_id = ps.org_id and psg.project_id = ps.project_id and psg.group_id = ps.group_id
  join public.selection_options o
    on o.org_id = ps.org_id and o.category_id = ps.category_id
   and o.sort_order = 1 + (('x' || substr(md5(ps.id::text), 1, 8))::bit(32)::bigint % 2)
  where ps.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
    and psg.status = 'locked'
    and ps.selected_option_id is null
)
update public.project_selections ps
set selected_option_id = t.option_id,
    status = 'confirmed',
    selected_at = t.locked_at,
    confirmed_at = t.locked_at,
    price_cents_snapshot = t.price_cents,
    cost_cents_snapshot = t.cost_cents,
    locked_at = t.locked_at
from target t
where t.selection_id = ps.id;

-- Open groups are partly worked: roughly half the categories decided, spread
-- across the grades so a buyer's running total is not all standard.
with target as (
  select ps.id as selection_id, o.id as option_id, o.price_cents, o.cost_cents,
         row_number() over (partition by ps.id order by o.sort_order) as rn,
         count(*) over (partition by ps.id) as n,
         (('x' || substr(md5(ps.id::text || 'v2'), 1, 8))::bit(32)::bigint) as h
  from public.project_selections ps
  join public.project_selection_groups psg
    on psg.org_id = ps.org_id and psg.project_id = ps.project_id and psg.group_id = ps.group_id
  join public.selection_options o on o.org_id = ps.org_id and o.category_id = ps.category_id
  where ps.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d'
    and psg.status = 'open'
    and ps.selected_option_id is null
    and (('x' || substr(md5(ps.id::text), 1, 8))::bit(32)::bigint % 10) < 5
)
update public.project_selections ps
set selected_option_id = t.option_id,
    status = 'selected',
    selected_at = now() - interval '3 days',
    price_cents_snapshot = t.price_cents,
    cost_cents_snapshot = t.cost_cents
from target t
where t.selection_id = ps.id and t.rn = 1 + (t.h % t.n);

-- This week's appointments, anchored to Monday so the agenda is never empty.
-- Times are stored UTC but written as Naples local hours plus the EDT offset,
-- so the agenda reads 9:00 rather than 5:00 for the demo org.
insert into public.design_studio_appointments
  (org_id, community_id, project_id, coordinator_user_id, scheduled_at, duration_minutes, location, status, group_ids)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, l.community_id, l.project_id,
       '41740fb0-8a05-4a78-9be8-2314e0df7a4c',
       (date_trunc('week', current_date) + v.offset_days * interval '1 day' + v.at)::timestamptz,
       v.mins, 'Design studio — Naples', 'scheduled', array['d4000000-0000-4000-8000-000000000003']::uuid[]
from (values
  ('50000000-0000-4000-8000-000000000011', 1, interval '13 hours', 180),
  ('50000000-0000-4000-8000-000000000013', 2, interval '17 hours', 180),
  ('50000000-0000-4000-8000-000000000015', 3, interval '13 hours 30 minutes', 120),
  ('50000000-0000-4000-8000-000000000010', 5, interval '14 hours', 180)
) as v(project_id, offset_days, at, mins)
join public.lots l on l.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d' and l.project_id = v.project_id::uuid
where not exists (
  select 1 from public.design_studio_appointments a
  where a.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d' and a.project_id = v.project_id::uuid);

-- Plan-level pricing: the same quartz costs more in the larger plans.
insert into public.selection_catalog_prices (org_id, option_id, house_plan_version_id, price_cents, cost_cents, is_available)
select '7a427663-6fe8-4072-9a31-96e19ab3976d'::uuid, v.option_id::uuid, hpv.id,
       round(v.base * (case when hpv.name like '%Banyan%' then 1.28
                            when hpv.name like '%Palmetto%' then 1.12
                            else 1.0 end))::int,
       null, true
from (values
  ('d2000000-0000-4000-8000-000000000042', 590000),
  ('d2000000-0000-4000-8000-000000000043', 630000),
  ('d2000000-0000-4000-8000-000000000044', 675000),
  ('d2000000-0000-4000-8000-000000000053', 684000)
) as v(option_id, base)
cross join lateral (
  select hpv2.id, hp.name
  from public.house_plan_versions hpv2
  join public.house_plans hp on hp.id = hpv2.house_plan_id
  where hpv2.org_id = '7a427663-6fe8-4072-9a31-96e19ab3976d' and hpv2.status = 'released'
) hpv
where not exists (
  select 1 from public.selection_catalog_prices p
  where p.option_id = v.option_id::uuid and p.house_plan_version_id = hpv.id and p.community_id is null);

commit;
