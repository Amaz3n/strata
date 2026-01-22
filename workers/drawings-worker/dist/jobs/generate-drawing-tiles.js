"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDrawingTiles = generateDrawingTiles;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const sharp_1 = __importDefault(require("sharp"));
const TILE_SIZE = 256;
const OVERLAP = 0; // No overlap for simplicity
const MAX_ZOOM_LEVELS = 8;
async function generateDrawingTiles(supabase, job) {
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
    const pageIndex = version.page_index;
    const metadata = version.extracted_metadata || {};
    const tempPngPath = metadata.temp_png_path;
    const sourceHash = metadata.source_hash;
    if (!tempPngPath) {
        throw new Error('Sheet version missing temp PNG path - was PDF extraction completed?');
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
    const tempDir = (0, os_1.tmpdir)();
    const tempLocalPngPath = (0, path_1.join)(tempDir, `page-${sheetVersionId}-${pageIndex}.png`);
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
        await fs_1.promises.writeFile(tempLocalPngPath, pngBytes);
        console.log(`Downloaded pre-rendered PNG: ${pngBytes.length} bytes`);
        // Load and process the image with Sharp
        const image = (0, sharp_1.default)(tempLocalPngPath);
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
        // Update database
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
        })
            .eq('id', sheetVersionId);
        console.log(`✅ Generated tiles for sheet version ${sheetVersionId}`);
        // Delete the temp PNG from storage (no longer needed)
        try {
            await supabase.storage
                .from('drawings-tiles')
                .remove([tempPngPath]);
            console.log(`Cleaned up temp PNG from storage: ${tempPngPath}`);
        }
        catch (e) {
            console.warn('Failed to delete temp PNG from storage:', e);
        }
        // Check if this completes the drawing set
        await checkAndUpdateDrawingSetStatus(supabase, orgId);
    }
    finally {
        // Clean up local temp file
        try {
            await fs_1.promises.unlink(tempLocalPngPath);
        }
        catch (e) {
            console.warn('Failed to clean up local temp file:', e);
        }
    }
}
async function uploadToStorage(supabase, path, data, contentType) {
    let buffer;
    let mimeType;
    if (typeof data === 'string') {
        // Assume it's a file path
        buffer = await fs_1.promises.readFile(data);
        mimeType = contentType || 'application/octet-stream';
    }
    else {
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
async function checkAndUpdateDrawingSetStatus(supabase, orgId) {
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
        if (!setsWithSheets)
            return;
        for (const set of setsWithSheets) {
            const sheets = set.drawing_sheets || [];
            const totalSheets = sheets.length;
            let readySheets = 0;
            for (const sheet of sheets) {
                const versions = sheet.drawing_sheet_versions || [];
                // A sheet is ready if it has at least one version with tiles
                if (versions.some((v) => v.tile_manifest)) {
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
    }
    catch (e) {
        console.error('Failed to update drawing set status:', e);
    }
}
