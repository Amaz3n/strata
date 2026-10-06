import { createHash } from "node:crypto"
import type { PDFDocument, PDFObject } from "mupdf"
import type { MupdfModule } from "@/lib/services/mupdf-loader"

/** Bump whenever serialization or the supported-feature gate changes. */
export const PAGE_FINGERPRINT_VERSION = "mupdf-standalone-exact-v1"

export type PageFingerprint =
  | { supported: true; fingerprint: string; standalonePdf: Buffer; recipe: string }
  | { supported: false; reason: string }

const SUPPORTED_PAGE_KEYS = new Set([
  "Type", "Parent", "Resources", "MediaBox", "CropBox", "Rotate", "Contents", "Annots",
])

function present(object: PDFObject): boolean {
  return !object.isNull() && (!object.isArray() || object.length > 0)
}

/**
 * Exact standalone bytes authorize reuse, never visual/perceptual similarity.
 * MuPDF graftPage does not copy annotations or document-level presentation
 * state, so those documents deliberately miss rather than hiding a change.
 * The full recipe includes renderer version plus every output-generation setting.
 */
export function fingerprintDrawingPage(
  mupdf: MupdfModule, doc: PDFDocument, pageIndex: number, recipe: string,
): PageFingerprint {
  if (!recipe.trim()) throw new Error("A rendering recipe is required")
  let single: PDFDocument | undefined
  try {
    const catalog = doc.getTrailer().get("Root")
    for (const key of ["OCProperties", "AcroForm", "OutputIntents", "NeedsRendering"]) {
      if (present(catalog.get(key))) return { supported: false, reason: `document-${key}` }
    }
    if (present(doc.getTrailer().get("Encrypt"))) return { supported: false, reason: "encrypted" }
    const page = doc.findPage(pageIndex)
    let unsupported: string | null = null
    page.forEach((_value, key) => {
      if (!SUPPORTED_PAGE_KEYS.has(String(key))) unsupported = String(key)
    })
    if (unsupported) return { supported: false, reason: `page-${unsupported}` }
    if (present(page.get("Annots"))) return { supported: false, reason: "annotations" }
    // Invalid/missing resources are uncertain even if a renderer recovers them.
    if (page.getInheritable("Resources").isNull()) return { supported: false, reason: "missing-resources" }
    if (page.getInheritable("MediaBox").isNull()) return { supported: false, reason: "missing-media-box" }
    single = new mupdf.PDFDocument()
    single.graftPage(0, doc, pageIndex)
    const serialized = single.saveToBuffer("compress")
    try {
      const standalonePdf = Buffer.from(serialized.asUint8Array())
      const fingerprint = createHash("sha256").update(PAGE_FINGERPRINT_VERSION).update("\0")
        .update(recipe).update("\0").update(standalonePdf).digest("hex")
      return { supported: true, fingerprint, standalonePdf, recipe }
    } finally { serialized.destroy() }
  } catch {
    return { supported: false, reason: "unreadable-page" }
  } finally { single?.destroy() }
}
