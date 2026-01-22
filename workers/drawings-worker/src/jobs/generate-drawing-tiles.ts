import { SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { Job } from '../worker';

const TILE_SIZE = 256;
const OVERLAP = 0; // No overlap for simplicity
const MAX_ZOOM_LEVELS = 8;

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

  const tempDir = tmpdir();
  const tempLocalPngPath = join(tempDir, `page-${sheetVersionId}-${pageIndex}.png`);
  const basePath = `${orgId}/${sourceHash}/page-${pageIndex}`;

  try {
    // Download pre-rendered PNG from storage
    const { data: pngData, error: downloadError } = await supabase.storage
      .from('drawings-tiles')
      .download(tempPngPath);

    if (downloadError || !pngData) {
      throw new Error(`Failed to download pre-rendered PNG: ${downloadError?.message}`);
    }

    const pngBytes = new Uint8Array(await pngData.arrayBuffer());
    await fs.writeFile(tempLocalPngPath, pngBytes);
    console.log(`Downloaded pre-rendered PNG: ${pngBytes.length} bytes`);

    // Load and process the image with Sharp
    const image = sharp(tempLocalPngPath);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error('Failed to get image dimensions');
    }

    const { width, height } = metadata;
    console.log(`Rendered page ${pageIndex}: ${width}x${height}px`);

    // Generate tile pyramid (Phase P0: single level for now)
    const tileManifest = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "png",
        Overlap: OVERLAP,
        TileSize: TILE_SIZE,
        Size: { Width: width, Height: height }
      }
    };

    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error('Missing SUPABASE_URL environment variable');
    }

    const tileBaseUrl = `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${basePath}`;

    // Upload the full-resolution image as a single tile
    const tilePath = `${basePath}/tiles/0/0_0.png`;
    await uploadToStorage(supabase, tilePath, tempLocalPngPath);

    // Generate and upload thumbnail
    const thumbBuffer = await image
      .resize(256, 256, { fit: 'inside' })
      .png()
      .toBuffer();

    const thumbPath = `${basePath}/thumbnail.png`;
    await uploadToStorage(supabase, thumbPath, thumbBuffer);

    // Upload manifest
    const manifestJson = JSON.stringify(tileManifest);
    const manifestPath = `${basePath}/manifest.json`;
    await uploadToStorage(supabase, manifestPath, Buffer.from(manifestJson));

    // Update database (and backfill page_index if missing)
    await supabase
      .from('drawing_sheet_versions')
      .update({
        tile_manifest: tileManifest,
        tile_base_url: tileBaseUrl,
        source_hash: sourceHash,
        tile_levels: 1, // Single level for Phase P0
        tiles_generated_at: new Date().toISOString(),
        thumbnail_url: `${tileBaseUrl}/thumbnail.png`,
        image_width: width,
        image_height: height,
        tiles_base_path: basePath,
        page_index: pageIndex,
      })
      .eq('id', sheetVersionId);

    console.log(`✅ Generated tiles for sheet version ${sheetVersionId}`);

    // Delete the temp PNG from storage (no longer needed)
    try {
      await supabase.storage
        .from('drawings-tiles')
        .remove([tempPngPath]);
      console.log(`Cleaned up temp PNG from storage: ${tempPngPath}`);
    } catch (e) {
      console.warn('Failed to delete temp PNG from storage:', e);
    }

    // Check if this completes the drawing set
    await checkAndUpdateDrawingSetStatus(supabase, orgId);

  } finally {
    // Clean up local temp file
    try {
      await fs.unlink(tempLocalPngPath);
    } catch (e) {
      console.warn('Failed to clean up local temp file:', e);
    }
  }
}

async function uploadToStorage(
  supabase: SupabaseClient,
  path: string,
  data: string | Buffer,
  contentType?: string
): Promise<void> {
  let buffer: Buffer;
  let mimeType: string;

  if (typeof data === 'string') {
    // Assume it's a file path
    buffer = await fs.readFile(data);
    mimeType = contentType || 'application/octet-stream';
  } else {
    buffer = data;
    mimeType = contentType || 'application/octet-stream';
  }

  const { error } = await supabase.storage
    .from('drawings-tiles')
    .upload(path, buffer, {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000, immutable',
      upsert: true,
    });

  if (error && !error.message?.includes?.('already exists')) {
    throw new Error(`Upload failed: ${error.message}`);
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