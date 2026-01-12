-- Migration: Add image URLs to drawing_sheet_versions for performance optimization
-- This enables pre-rendered images instead of client-side PDF rendering
-- Target: Sub-300ms load times (10x improvement)

-- Add image URL columns to drawing_sheet_versions
ALTER TABLE drawing_sheet_versions
ADD COLUMN IF NOT EXISTS thumbnail_url text,
ADD COLUMN IF NOT EXISTS medium_url text,
ADD COLUMN IF NOT EXISTS full_url text,
ADD COLUMN IF NOT EXISTS image_width integer,
ADD COLUMN IF NOT EXISTS image_height integer,
ADD COLUMN IF NOT EXISTS images_generated_at timestamptz;

-- Index for quickly checking if images exist (for migration progress tracking)
CREATE INDEX IF NOT EXISTS idx_drawing_sheet_versions_has_images
ON drawing_sheet_versions(id)
WHERE thumbnail_url IS NOT NULL;

-- Index for finding sheets that need image generation
CREATE INDEX IF NOT EXISTS idx_drawing_sheet_versions_needs_images
ON drawing_sheet_versions(created_at)
WHERE thumbnail_url IS NULL;

-- Comments for documentation
COMMENT ON COLUMN drawing_sheet_versions.thumbnail_url IS 'WebP 400px wide - for grid/list view, ~30-50KB';
COMMENT ON COLUMN drawing_sheet_versions.medium_url IS 'WebP 1200px wide - for mobile/tablet viewing, ~150-250KB';
COMMENT ON COLUMN drawing_sheet_versions.full_url IS 'WebP 2400px wide - for desktop zoom, ~400-600KB';
COMMENT ON COLUMN drawing_sheet_versions.image_width IS 'Original image width in pixels (before resizing)';
COMMENT ON COLUMN drawing_sheet_versions.image_height IS 'Original image height in pixels (before resizing)';
COMMENT ON COLUMN drawing_sheet_versions.images_generated_at IS 'Timestamp when images were generated (null = not yet processed)';
