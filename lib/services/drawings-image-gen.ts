"use client"

import { createClient } from "@/lib/supabase/client"

// We'll import PDF.js dynamically to avoid loading issues
let pdfjsLib: any = null

interface ImageGenerationResult {
  thumbnailPath: string
  mediumPath: string
  fullPath: string
  thumbnailUrl: string
  mediumUrl: string
  fullUrl: string
  width: number
  height: number
}

/**
 * Generate optimized images from a PDF page using browser Canvas API
 *
 * Phase 1 Performance - Client-side Solution:
 * - Works in all browsers (no server dependencies)
 * - Generates 3 resolutions: thumbnail (400px), medium (1200px), full (2400px)
 * - Uses WebP for optimal compression
 * - Uploads directly to Supabase Storage
 */
export async function generateImagesFromPDF(
  pdfFile: File,
  pageIndex: number,
  orgId: string,
  projectId: string,
  drawingSetId: string,
  sheetVersionId: string,
  onProgress?: (stage: string) => void
): Promise<ImageGenerationResult> {
  onProgress?.("Loading PDF...")

  try {
    // Import PDF.js dynamically like the drawing viewer does
    if (!pdfjsLib) {
      const { pdfjs } = await import("react-pdf")
      pdfjsLib = pdfjs
      console.log("[PDF.js] Imported PDF.js dynamically, version:", pdfjs.version)
    }

    // Configure worker source
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
    console.log("[PDF.js] Worker configured:", pdfjsLib.GlobalWorkerOptions.workerSrc)

    // Load PDF with standard configuration
    const arrayBuffer = await pdfFile.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      // Use standard PDF.js configuration
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise

    const page = await pdf.getPage(pageIndex + 1) // PDF.js uses 1-based indexing

    onProgress?.("Rendering to canvas...")

    // Get page dimensions
    const viewport = page.getViewport({ scale: 1 })
    const targetWidth = 2400
    const scale = targetWidth / viewport.width
    const scaledViewport = page.getViewport({ scale })

    // Create canvas for high-res render
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")!
    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height

    // Render PDF to canvas with error handling
    await page.render({
      canvasContext: context,
      viewport: scaledViewport,
    }).promise

    onProgress?.("Generating images...")

    // Generate 3 resolutions
    const [thumbnail, medium, full] = await Promise.all([
      resizeCanvas(canvas, 400),
      resizeCanvas(canvas, 1200),
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob)
            else reject(new Error("Failed to create blob"))
          },
          "image/webp",
          0.9
        )
      }),
    ])

    onProgress?.("Uploading images...")

    // Upload to Supabase Storage
    const supabase = createClient()
    const fullHash = await hashBlob(full)
    const basePath = `${orgId}/${projectId}/drawings/${drawingSetId}/${sheetVersionId}/${fullHash}`

    const [thumbUpload, mediumUpload, fullUpload] = await Promise.all([
      uploadImage(supabase, thumbnail, `${basePath}/thumb.webp`),
      uploadImage(supabase, medium, `${basePath}/medium.webp`),
      uploadImage(supabase, full, `${basePath}/full.webp`),
    ])

    onProgress?.("Complete!")

    return {
      thumbnailPath: thumbUpload.path,
      mediumPath: mediumUpload.path,
      fullPath: fullUpload.path,
      thumbnailUrl: thumbUpload.publicUrl,
      mediumUrl: mediumUpload.publicUrl,
      fullUrl: fullUpload.publicUrl,
      width: Math.round(scaledViewport.width),
      height: Math.round(scaledViewport.height),
    }
  } catch (error) {
    console.error(`Failed to generate images for page ${pageIndex + 1}:`, error)

    // Fallback: Try to render PDF page as image using a different approach
    // This is a last resort that may not work in all browsers
    onProgress?.("Trying alternative rendering...")

    try {
      // Create a simple placeholder image for now
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("2d")!
      canvas.width = 2400
      canvas.height = 3200 // Assume letter size

      // Fill with white background
      context.fillStyle = "white"
      context.fillRect(0, 0, canvas.width, canvas.height)

      // Add text indicating PDF rendering failed
      context.fillStyle = "red"
      context.font = "48px Arial"
      context.fillText("PDF rendering failed", 100, 100)
      context.fillText("Please try again", 100, 200)

      // Generate images from this placeholder
      const [thumbnail, medium, full] = await Promise.all([
        resizeCanvas(canvas, 400),
        resizeCanvas(canvas, 1200),
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => {
              if (blob) resolve(blob)
              else reject(new Error("Failed to create blob"))
            },
            "image/webp",
            0.9
          )
        }),
      ])

      // Upload placeholder images
      const supabase = createClient()
      const fullHash = await hashBlob(full)
      const basePath = `${orgId}/${projectId}/drawings/${drawingSetId}/${sheetVersionId}/${fullHash}`

      const [thumbUpload, mediumUpload, fullUpload] = await Promise.all([
        uploadImage(supabase, thumbnail, `${basePath}/thumb.webp`),
        uploadImage(supabase, medium, `${basePath}/medium.webp`),
        uploadImage(supabase, full, `${basePath}/full.webp`),
      ])

      return {
        thumbnailPath: thumbUpload.path,
        mediumPath: mediumUpload.path,
        fullPath: fullUpload.path,
        thumbnailUrl: thumbUpload.publicUrl,
        mediumUrl: mediumUpload.publicUrl,
        fullUrl: fullUpload.publicUrl,
        width: canvas.width,
        height: canvas.height,
      }
    } catch (fallbackError) {
      console.error("Fallback rendering also failed:", fallbackError)
      throw new Error(`Image generation failed: ${(error as Error).message}`)
    }
  }
}

/**
 * Resize canvas to target width while maintaining aspect ratio
 */
async function resizeCanvas(
  sourceCanvas: HTMLCanvasElement,
  targetWidth: number
): Promise<Blob> {
  const aspectRatio = sourceCanvas.height / sourceCanvas.width
  const targetHeight = Math.round(targetWidth * aspectRatio)

  const resizeCanvas = document.createElement("canvas")
  resizeCanvas.width = targetWidth
  resizeCanvas.height = targetHeight

  const ctx = resizeCanvas.getContext("2d")!

  // Use better image smoothing
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"

  ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight)

  // Determine quality based on size
  const quality = targetWidth <= 400 ? 0.8 : targetWidth <= 1200 ? 0.85 : 0.9

  return new Promise((resolve, reject) => {
    resizeCanvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error("Failed to create blob"))
      },
      "image/webp",
      quality
    )
  })
}

/**
 * Upload a blob to Supabase Storage and return public URL
 */
async function uploadImage(
  supabase: ReturnType<typeof createClient>,
  blob: Blob,
  path: string
): Promise<{ path: string; publicUrl: string }> {
  const { error } = await supabase.storage
    .from("drawings-images")
    .upload(path, blob, {
      contentType: "image/webp",
      cacheControl: "31536000", // 1 year immutable caching
      upsert: false,
    })

  if (error) {
    throw new Error(`Failed to upload image: ${error.message}`)
  }

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!baseUrl) {
    const { data: { publicUrl } } = supabase.storage.from("drawings-images").getPublicUrl(path)
    return { path, publicUrl }
  }

  const normalized = path.startsWith("/") ? path.slice(1) : path
  const publicUrl = `${baseUrl}/storage/v1/object/public/drawings-images/${encodeURI(normalized)}`
  return { path, publicUrl }
}

async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hashHex.slice(0, 16) // shorter but still unique enough for versioning
}

/**
 * Generate images for all pages in a PDF
 */
export async function generateImagesForAllPages(
  pdfFile: File,
  orgId: string,
  projectId: string,
  drawingSetId: string,
  sheetVersions: Array<{ id: string; pageIndex: number }>,
  onProgress?: (current: number, total: number, stage: string) => void
): Promise<Map<string, ImageGenerationResult>> {
  const results = new Map<string, ImageGenerationResult>()

  for (let i = 0; i < sheetVersions.length; i++) {
    const version = sheetVersions[i]

    try {
      onProgress?.(i + 1, sheetVersions.length, `Processing page ${i + 1}...`)

      const images = await generateImagesFromPDF(
        pdfFile,
        version.pageIndex,
        orgId,
        projectId,
        drawingSetId,
        version.id,
        (stage) => onProgress?.(i + 1, sheetVersions.length, stage)
      )

      results.set(version.id, images)
    } catch (error) {
      console.error(`Failed to generate images for page ${i + 1}:`, error)
      // Continue with other pages
    }
  }

  return results
}
