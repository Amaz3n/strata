-- Add enums for new project fields
do $$
begin
  create type project_property_type as enum ('residential', 'commercial');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type project_work_type as enum ('new_construction', 'remodel', 'addition', 'renovation', 'repair');
exception
  when duplicate_object then null;
end $$;

-- Add new columns to projects table
alter table projects 
add column if not exists total_value integer,
add column if not exists property_type project_property_type,
add column if not exists project_type project_work_type,
add column if not exists description text;

-- Update status to include bidding
do $$
begin
  create type project_status as enum ('planning', 'bidding', 'active', 'on_hold', 'completed', 'cancelled');
exception
  when duplicate_object then null;
end $$;

-- Change the status column to use the enum
alter table projects alter column status drop default;
alter table projects alter column status type project_status using 
  case 
    when status = 'planning' then 'planning'::project_status
    when status = 'active' then 'active'::project_status
    when status = 'on_hold' then 'on_hold'::project_status
    when status = 'completed' then 'completed'::project_status
    when status = 'cancelled' then 'cancelled'::project_status
    else 'active'::project_status
  end;
alter table projects alter column status set default 'active';;
