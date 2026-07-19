-- Production expansion WS01: the enum value is isolated because PostgreSQL
-- cannot safely consume a newly-added enum value in the same transaction.
alter type public.project_property_type add value if not exists 'production';
