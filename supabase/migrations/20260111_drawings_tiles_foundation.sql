-- Drawings Foundation v2: tiled images + public bucket
-- Adds tile metadata columns and reconciles image path columns used by the app.

-- 1) Public bucket for tiles (immutable, cacheable)
-- Note: storage.buckets is managed by Supabase Storage.
INSERT INTO storage.buckets (id, name, public)
VALUES ('drawings-tiles', 'drawings-tiles', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- 2) Tile + image path columns (additive)
ALTER TABLE drawing_sheet_versions
  -- Existing app code uses these canonical paths (public bucket) in addition to URL columns.
  ADD COLUMN IF NOT EXISTS thumb_path TEXT,
  ADD COLUMN IF NOT EXISTS medium_path TEXT,
  ADD COLUMN IF NOT EXISTS full_path TEXT,
  ADD COLUMN IF NOT EXISTS tile_manifest_path TEXT,
  ADD COLUMN IF NOT EXISTS tiles_base_path TEXT,
  -- New Foundation v2 columns (DZI tiles)
  ADD COLUMN IF NOT EXISTS tile_manifest JSONB,
  ADD COLUMN IF NOT EXISTS tile_base_url TEXT,
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS tile_levels INTEGER,
  ADD COLUMN IF NOT EXISTS tiles_generated_at TIMESTAMPTZ;

-- 3) Index to find versions needing tiles
CREATE INDEX IF NOT EXISTS idx_drawing_sheet_versions_needs_tiles
  ON drawing_sheet_versions(created_at)
  WHERE tile_manifest IS NULL;

COMMENT ON COLUMN drawing_sheet_versions.tile_manifest IS 'Deep Zoom Image (DZI) descriptor JSON for tile pyramid';
COMMENT ON COLUMN drawing_sheet_versions.tile_base_url IS 'Public base URL for tiles, e.g. .../drawings-tiles/{orgId}/{hash}';
COMMENT ON COLUMN drawing_sheet_versions.source_hash IS 'SHA256 (shortened) of source page content for content-addressed storage';
COMMENT ON COLUMN drawing_sheet_versions.tile_levels IS 'Number of zoom levels generated for this sheet';
COMMENT ON COLUMN drawing_sheet_versions.tiles_generated_at IS 'Timestamp when tiles were generated';

