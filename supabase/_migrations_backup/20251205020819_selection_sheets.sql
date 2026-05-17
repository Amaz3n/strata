CREATE TABLE IF NOT EXISTS selection_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_template BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selection_categories_org_idx ON selection_categories (org_id);
DO $$ BEGIN
  IF to_regproc('public.tg_set_updated_at') IS NOT NULL THEN
    CREATE TRIGGER selection_categories_set_updated_at BEFORE UPDATE ON selection_categories
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS selection_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER,
  price_type TEXT CHECK (price_type IN ('included','upgrade','downgrade')),
  price_delta_cents INTEGER,
  image_url TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  sku TEXT,
  vendor TEXT,
  lead_time_days INTEGER,
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selection_options_category_idx ON selection_options (category_id);
CREATE INDEX IF NOT EXISTS selection_options_org_idx ON selection_options (org_id);
DO $$ BEGIN
  IF to_regproc('public.tg_set_updated_at') IS NOT NULL THEN
    CREATE TRIGGER selection_options_set_updated_at BEFORE UPDATE ON selection_options
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS project_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  selected_option_id UUID REFERENCES selection_options(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','selected','confirmed','ordered','received')),
  due_date DATE,
  selected_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  selected_by_user_id UUID REFERENCES app_users(id),
  selected_by_contact_id UUID REFERENCES contacts(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, category_id)
);
CREATE INDEX IF NOT EXISTS project_selections_project_idx ON project_selections (project_id);
CREATE INDEX IF NOT EXISTS project_selections_org_idx ON project_selections (org_id);
DO $$ BEGIN
  IF to_regproc('public.tg_set_updated_at') IS NOT NULL THEN
    CREATE TRIGGER project_selections_set_updated_at BEFORE UPDATE ON project_selections
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE selection_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE selection_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_selections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY selection_categories_access ON selection_categories FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY selection_options_access ON selection_options FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY project_selections_access ON project_selections FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;;
