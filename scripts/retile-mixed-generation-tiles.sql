-- Repair: re-tile sheet versions whose tile directory holds mixed render
-- generations (pre-generation-segmented paths, 2026-07).
--
-- Background: tile paths used to be `{org}/{sourceHash}/page-N` for every
-- render generation, while tiles are served `immutable, max-age=1y`. When the
-- render resolution changed (3456×2304 → 5400×3600), re-tiles overwrote R2
-- but CDN/browser caches kept serving old-geometry tiles under new manifests
-- — sheets rendered with white padding / at the wrong scale. Paths are now
-- generation-segmented (`{org}/{sourceHash}/r{dpi}-{tile}-{fmt}/page-N`), so
-- re-tiling affected versions moves them onto clean, never-cached paths.
--
-- Run AFTER deploying the generation-segmented path change (the force flag on
-- generate_drawing_tiles ships with it). Idempotent via dedupe_key.
-- Affected at time of writing: 9 tile paths, 78 version rows.

-- 1) Queue a forced re-tile for every version sharing a mixed-geometry path.
INSERT INTO outbox (org_id, job_type, status, run_at, payload, dedupe_key)
SELECT
  v.org_id,
  'generate_drawing_tiles',
  'pending',
  now(),
  jsonb_build_object('sheetVersionId', v.id, 'force', true),
  'retile-mixed-gen:' || v.id
FROM drawing_sheet_versions v
WHERE v.tiles_base_path IN (
  SELECT tiles_base_path
  FROM drawing_sheet_versions
  WHERE tiles_base_path IS NOT NULL
    AND tile_manifest IS NOT NULL
  GROUP BY tiles_base_path
  HAVING count(DISTINCT (tile_manifest -> 'Image' -> 'Size')::text) > 1
)
AND NOT EXISTS (
  SELECT 1 FROM outbox o WHERE o.dedupe_key = 'retile-mixed-gen:' || v.id
);

-- 2) One vectors sweep afterwards: the forced re-tile clears vector_stats on
-- those rows, and this job re-extracts vectors.bin onto the new paths.
INSERT INTO outbox (org_id, job_type, status, run_at, payload, dedupe_key)
SELECT DISTINCT
  v.org_id,
  'extract_drawing_vectors',
  'pending',
  now() + interval '10 minutes',
  '{}'::jsonb,
  'retile-mixed-gen-vectors:' || v.org_id
FROM drawing_sheet_versions v
WHERE v.tiles_base_path IN (
  SELECT tiles_base_path
  FROM drawing_sheet_versions
  WHERE tiles_base_path IS NOT NULL
    AND tile_manifest IS NOT NULL
  GROUP BY tiles_base_path
  HAVING count(DISTINCT (tile_manifest -> 'Image' -> 'Size')::text) > 1
)
AND NOT EXISTS (
  SELECT 1 FROM outbox o WHERE o.dedupe_key = 'retile-mixed-gen-vectors:' || v.org_id
);
