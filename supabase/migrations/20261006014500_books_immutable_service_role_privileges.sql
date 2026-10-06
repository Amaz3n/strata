-- Supabase's default privileges give service_role ALL on new public tables.
-- Tables guarded by books_entity_immutable reject row UPDATE/DELETE, but
-- TRUNCATE bypasses row triggers, so the history was erasable by the server
-- role. Revoke DELETE and TRUNCATE; UPDATE stays because SELECT ... FOR UPDATE
-- (the entity and scope locks) requires it, and the trigger still rejects
-- every actual row update.
begin;
do $$
declare t regclass;
begin
 for t in
  select distinct tg.tgrelid::regclass from pg_trigger tg join pg_proc p on p.oid=tg.tgfoid
  where not tg.tgisinternal and p.proname='books_entity_immutable' and p.pronamespace='public'::regnamespace
 loop
  execute format('revoke delete,truncate on %s from service_role',t);
 end loop;
end $$;
commit;
