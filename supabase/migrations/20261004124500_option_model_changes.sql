-- Design Studio options can carry "model changes": what choosing the option
-- does to the house in the 3D model (a floor finish, a wall finish, or a piece
-- of furniture, scoped to rooms by label), priced from the model's own
-- quantities. The element shape is validated by `modelChangesSchema`
-- (lib/drawings/model-options.ts); the database only guarantees an array.
--
-- Column on an existing org-scoped table: selection_options already has RLS
-- enabled with its org policy, so no new policy or index is needed.

alter table public.selection_options
  add column if not exists model_changes jsonb not null default '[]'::jsonb;

alter table public.selection_options
  drop constraint if exists selection_options_model_changes_is_array;

alter table public.selection_options
  add constraint selection_options_model_changes_is_array
  check (jsonb_typeof(model_changes) = 'array');
