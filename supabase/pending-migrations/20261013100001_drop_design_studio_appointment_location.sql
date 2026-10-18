-- Drop design_studio_appointments.location.
--
-- GATED, DESTRUCTIVE: this deletes a column. It lives in pending-migrations and
-- must not be applied, moved into migrations/, or swept in by a blanket db push
-- until a human approves it, after
-- 20261013100000_design_studio_capacity_and_approvals.sql is applied and the
-- application that no longer reads the column is deployed.
--
-- A session's place was a free-text label. It is now a studio and a room
-- (location_id, room_id), and 20261013100000 moved every existing appointment
-- into its org's "Design studio". No code reads or writes the label. Whatever
-- was typed there is kept on the appointment's notes before the column goes.

update public.design_studio_appointments
set notes = concat_ws(E'\n', nullif(btrim(notes), ''), 'Location: ' || btrim(location))
where nullif(btrim(location), '') is not null;

alter table public.design_studio_appointments drop column if exists location;
