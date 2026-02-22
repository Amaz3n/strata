import { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { Job } from '../worker';
import { buildTilesBaseUrl, deleteTileObjects, downloadTileObject, uploadTileObject } from '../storage/tiles';

const TILE_SIZE = 256;
const OVERLAP = 0;
const TILE_FORMAT = 'png';
const TILE_UPLOAD_CONCURRENCY = 8;

type TileManifest = {
  Image: {
    xmlns: string;
    Format: string;
    Overlap: number;
    TileSize: number;
    Size: { Width: number; Height: number };
  };
  // Non-standard helper field used by our viewer to detect true pyramid manifests.
  Levels: number;
};

export async function generateDrawingTiles(supabase: SupabaseClient, job: Job): Promise<void> {
  const { sheetVersionId } = job.payload;

  if (!sheetVersionId) {
    throw new Error('Missing sheetVersionId in payload');
  }

  console.log(`🎨 Generating tiles for sheet version ${sheetVersionId}`);

  // Get sheet version info including temp PNG path
  const { data: version, error: versionError } = await supabase
    .from('drawing_sheet_versions')
    .select('id, org_id, page_index, extracted_metadata')
    .eq('id', sheetVersionId)
    .single();

  if (versionError || !version) {
    throw new Error(`Sheet version not found: ${versionError?.message}`);
  }

  const orgId = version.org_id;
  const metadata = version.extracted_metadata || {};
  const tempPngPath = metadata.temp_png_path;
  const sourceHash = metadata.source_hash;
  const pageIndexFromVersion =
    typeof version.page_index === 'number' && Number.isFinite(version.page_index)
      ? version.page_index
      : null;
  const pageIndexFromPath = typeof tempPngPath === 'string'
    ? parsePageIndexFromPath(tempPngPath)
    : null;
  const pageIndex = pageIndexFromVersion ?? pageIndexFromPath;

  if (!tempPngPath) {
    throw new Error('Sheet version missing temp PNG path - was PDF extraction completed?');
  }

  if (pageIndex === null || pageIndex === undefined) {
    throw new Error('Sheet version missing page_index and could not infer from temp PNG path');
  }

  // Check if tiles already exist (idempotency)
  const { data: existingVersion } = await supabase
    .from('drawing_sheet_versions')
    .select('tile_manifest, tile_base_url')
    .eq('id', sheetVersionId)
    .single();

  if (existingVersion?.tile_manifest && existingVersion?.tile_base_url) {
    console.log('Tiles already exist, skipping generation');
    return;
  }

  const basePath = `${orgId}/${sourceHash}/page-${pageIndex}`;
  // Download pre-rendered PNG from storage
  const pngBytes = await downloadTileObject({ supabase, path: tempPngPath });
  console.log(`Downloaded pre-rendered PNG: ${pngBytes.length} bytes`);

  // Load and process the image with Sharp
  const sourceBuffer = Buffer.from(pngBytes);
  const image = sharp(sourceBuffer, { limitInputPixels: false });
  const imageMetadata = await image.metadata();

  if (!imageMetadata.width || !imageMetadata.height) {
    throw new Error('Failed to get image dimensions');
  }

  const { width, height } = imageMetadata;
  console.log(`Rendered page ${pageIndex}: ${width}x${height}px`);

  const maxLevel = getMaxDziLevel(width, height);
  const levels = maxLevel + 1;
  console.log(`Generating ${levels} levels (maxLevel=${maxLevel})`);

  const tileManifest: TileManifest = {
    Image: {
      xmlns: "http://schemas.microsoft.com/deepzoom/2008",
      Format: TILE_FORMAT,
      Overlap: OVERLAP,
      TileSize: TILE_SIZE,
      Size: { Width: width, Height: height },
    },
    Levels: levels,
  };

  const tileBaseUrl = buildTilesBaseUrl(basePath);
  if (process.env.DRAWINGS_TILES_DEBUG === 'true') {
    console.log('[tiles] tile_base_url', tileBaseUrl);
  }

  await generateTilePyramid({
    supabase,
    sourceBuffer,
    basePath,
    width,
    height,
    maxLevel,
  });

  // Generate and upload thumbnail
  const thumbBuffer = await image
    .resize(256, 256, { fit: 'inside' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const thumbPath = `${basePath}/thumbnail.${TILE_FORMAT}`;
  await uploadToStorage(supabase, thumbPath, thumbBuffer, 'image/png');

  // Upload manifest
  const manifestJson = JSON.stringify(tileManifest);
  const manifestPath = `${basePath}/manifest.json`;
  await uploadToStorage(supabase, manifestPath, Buffer.from(manifestJson), 'application/json');

  // Update database (and backfill page_index if missing)
  await supabase
    .from('drawing_sheet_versions')
    .update({
      tile_manifest: tileManifest,
      tile_base_url: tileBaseUrl,
      source_hash: sourceHash,
      tile_levels: levels,
      tiles_generated_at: new Date().toISOString(),
      thumbnail_url: `${tileBaseUrl}/thumbnail.${TILE_FORMAT}`,
      image_width: width,
      image_height: height,
      tile_manifest_path: manifestPath,
      tiles_base_path: basePath,
      page_index: pageIndex,
    })
    .eq('id', sheetVersionId);

  console.log(`✅ Generated tiles for sheet version ${sheetVersionId}`);

  // Delete the temp PNG from storage (no longer needed)
  try {
    await deleteTileObjects({ supabase, paths: [tempPngPath] });
    console.log(`Cleaned up temp PNG from storage: ${tempPngPath}`);
  } catch (e) {
    console.warn('Failed to delete temp PNG from storage:', e);
  }

  // Check if this completes the drawing set
  await checkAndUpdateDrawingSetStatus(supabase, orgId);
}

async function uploadToStorage(
  supabase: SupabaseClient,
  path: string,
  data: Buffer,
  contentType?: string
): Promise<void> {
  const mimeType = contentType || 'application/octet-stream';

  await uploadTileObject({
    supabase,
    path,
    bytes: data,
    contentType: mimeType,
    cacheControl: 'public, max-age=31536000, immutable',
  });
}

function getMaxDziLevel(width: number, height: number): number {
  const maxDimension = Math.max(width, height);
  return Math.ceil(Math.log2(maxDimension));
}

function getLevelDimensions(width: number, height: number, level: number, maxLevel: number) {
  const scaleDivisor = 2 ** (maxLevel - level);
  const levelWidth = Math.max(1, Math.ceil(width / scaleDivisor));
  const levelHeight = Math.max(1, Math.ceil(height / scaleDivisor));
  return { levelWidth, levelHeight };
}

async function generateTilePyramid(params: {
  supabase: SupabaseClient;
  sourceBuffer: Buffer;
  basePath: string;
  width: number;
  height: number;
  maxLevel: number;
}) {
  const { supabase, sourceBuffer, basePath, width, height, maxLevel } = params;

  for (let level = 0; level <= maxLevel; level++) {
    const { levelWidth, levelHeight } = getLevelDimensions(width, height, level, maxLevel);
    const cols = Math.ceil(levelWidth / TILE_SIZE);
    const rows = Math.ceil(levelHeight / TILE_SIZE);

    // Resize once per level, then extract tiles from that resized image.
    const levelImageBuffer = await sharp(sourceBuffer, { limitInputPixels: false })
      .resize(levelWidth, levelHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const tiles: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        tiles.push({ col, row });
      }
    }

    for (let i = 0; i < tiles.length; i += TILE_UPLOAD_CONCURRENCY) {
      const chunk = tiles.slice(i, i + TILE_UPLOAD_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ col, row }) => {
          const left = col * TILE_SIZE;
          const top = row * TILE_SIZE;
          const tileWidth = Math.min(TILE_SIZE, levelWidth - left);
          const tileHeight = Math.min(TILE_SIZE, levelHeight - top);

          const tileBuffer = await sharp(levelImageBuffer, { limitInputPixels: false })
            .extract({ left, top, width: tileWidth, height: tileHeight })
            .png({ compressionLevel: 9 })
            .toBuffer();

          const tilePath = `${basePath}/tiles/${level}/${col}_${row}.${TILE_FORMAT}`;
          await uploadToStorage(supabase, tilePath, tileBuffer, 'image/png');
        })
      );
    }

    console.log(`Generated level ${level}/${maxLevel}: ${cols}x${rows} tiles`);
  }
}

async function checkAndUpdateDrawingSetStatus(supabase: SupabaseClient, orgId: string): Promise<void> {
  // Check if all sheets in drawing sets are now ready and update set status accordingly
  try {
    // Find drawing sets that have sheets but might need status updates
    const { data: setsWithSheets } = await supabase
      .from('drawing_sets')
      .select(`
        id,
        status,
        drawing_sheets!inner(
          id,
          drawing_sheet_versions!inner(
            tile_manifest
          )
        )
      `)
      .eq('org_id', orgId)
      .eq('status', 'processing');

    if (!setsWithSheets) return;

    for (const set of setsWithSheets) {
      const sheets = (set as any).drawing_sheets || [];
      const totalSheets = sheets.length;
      let readySheets = 0;

      for (const sheet of sheets) {
        const versions = sheet.drawing_sheet_versions || [];
        // A sheet is ready if it has at least one version with tiles
        if (versions.some((v: any) => v.tile_manifest)) {
          readySheets++;
        }
      }

      // Update set status if all sheets are ready
      if (readySheets === totalSheets && totalSheets > 0) {
        await supabase
          .from('drawing_sets')
          .update({
            status: 'ready',
            processed_pages: totalSheets,
            processed_at: new Date().toISOString()
          })
          .eq('id', set.id);

        console.log(`Updated drawing set ${set.id} to ready (${readySheets}/${totalSheets} sheets)`);
      }
    }

    await supabase.rpc('refresh_drawing_sheets_list');
  } catch (e) {
    console.error('Failed to update drawing set status:', e);
  }
}

function parsePageIndexFromPath(path: string): number | null {
  const match = path.match(/page-(\d+)\.png$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
