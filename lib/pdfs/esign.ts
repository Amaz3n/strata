import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, type PDFFont, type PDFPage } from "pdf-lib"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import * as fontkit from "fontkit"
import { validateSignaturePng } from "@/lib/esign/field-values"

type FieldType = "signature" | "initials" | "text" | "date" | "checkbox" | "name"

export interface ESignField {
  id: string
  page_index: number
  field_type: FieldType
  x: number
  y: number
  w: number
  h: number
  metadata?: Record<string, unknown> | null
}

export interface ESignAuditTrailItem {
  label: string
  value: string | null | undefined
}

const fontAssets = new Map<string, Promise<Buffer>>()
function loadFontAsset(name: string) {
  let bytes = fontAssets.get(name)
  if (!bytes) {
    bytes = readFile(path.join(process.cwd(), "lib/pdfs/fonts", name))
    fontAssets.set(name, bytes)
  }
  return bytes
}

// pdf-lib 1.x expects fontkit's older stream API. fontkit 2 exposes the same
// subset bytes synchronously; adapt that boundary without private PDF internals.
const pdfFontkit = {
  create(bytes: Uint8Array) {
    const font = fontkit.create(bytes)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset()
      subset.encodeStream = () => Readable.from([subset.encode()])
      return subset
    }
    return font
  },
}

async function createFontSelector(pdf: PDFDocument) {
  pdf.registerFontkit(pdfFontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0])
  const sans = await pdf.embedFont(await loadFontAsset("DMSans-Regular.ttf"), { subset: true })
  const serif = await pdf.embedFont(StandardFonts.TimesRoman)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  let cjk: PDFFont | undefined
  const supports = (font: PDFFont, text: string) => {
    const characters = new Set(font.getCharacterSet())
    return Array.from(text).every(char => /[\n\r\t]/.test(char) || characters.has(char.codePointAt(0)!))
  }
  return async (text: string, family: unknown = "sans"): Promise<PDFFont> => {
    const preferred = family === "serif" ? serif : family === "mono" ? mono : sans
    if (supports(preferred, text)) return preferred
    if (supports(sans, text)) return sans
    cjk ??= await pdf.embedFont(await loadFontAsset("NotoSansSC-Regular.otf"), { subset: true })
    if (supports(cjk, text)) return cjk
    throw new Error("This text includes characters not supported by the document fonts. Please contact the sender.")
  }
}

/** Convert displayed PDF.js crop-box coordinates to the original PDF user space. */
export function signingPageGeometry(page: PDFPage) {
  const crop = page.getCropBox()
  const media = page.getMediaBox()
  const x = Math.max(crop.x, media.x)
  const y = Math.max(crop.y, media.y)
  const width = Math.min(crop.x + crop.width, media.x + media.width) - x
  const height = Math.min(crop.y + crop.height, media.y + media.height) - y
  if (width <= 0 || height <= 0) throw new Error("The PDF crop box does not intersect its page.")
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  if (![0, 90, 180, 270].includes(rotation)) throw new Error("Unsupported PDF page rotation.")
  const transforms: Record<number, [number, number, number, number, number, number]> = {
    0: [1, 0, 0, 1, x, y],
    90: [0, 1, -1, 0, x + width, y],
    180: [-1, 0, 0, -1, x + width, y + height],
    270: [0, -1, 1, 0, x, y + height],
  }
  return { width: rotation % 180 ? height : width, height: rotation % 180 ? width : height, transform: transforms[rotation] }
}

export function formatSigningDate(value: string, format: unknown = "MM/DD/YYYY") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error("Invalid signing date.")
  const [, year, month, day] = match
  if (format === "YYYY-MM-DD") return value
  if (format === "DD/MM/YYYY") return `${day}/${month}/${year}`
  if (format === "MMM D, YYYY") return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${Number(day)}, ${year}`
  return `${month}/${day}/${year}`
}

function assertFieldGeometry(field: ESignField, pages: PDFPage[]) {
  if (!Number.isInteger(field.page_index) || !pages[field.page_index] ||
      ![field.x, field.y, field.w, field.h].every(Number.isFinite) ||
      field.x < 0 || field.y < 0 || field.w <= 0 || field.h <= 0 ||
      field.x + field.w > 1.000001 || field.y + field.h > 1.000001) {
    throw new Error("A signing field is outside the document page. Ask the sender to correct its placement.")
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (/[\r\n]/.test(text)) return text.split(/\r\n|\r|\n/).flatMap(line => wrapText(line, font, size, maxWidth))
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""

  const pushLongToken = (token: string) => {
    let slice = ""
    for (const char of token) {
      const next = `${slice}${char}`
      if (slice && font.widthOfTextAtSize(next, size) > maxWidth) {
        lines.push(slice)
        slice = char
      } else {
        slice = next
      }
    }
    return slice
  }

  for (const word of words.length ? words : [text]) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (current) {
        lines.push(current)
        current = ""
      }
      current = pushLongToken(word)
      continue
    }

    const next = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > maxWidth) {
      if (current) lines.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) lines.push(current)
  return lines.length ? lines : [""]
}

function resolveFieldValue(
  values: Record<string, any>,
  fieldId: string,
): string | boolean | null {
  const value = values[fieldId]
  if (value === undefined || value === null) return null
  return value
}

export async function generateExecutedPdf({
  pdfBytes,
  fields,
  values,
  auditTrail,
}: {
  pdfBytes: Uint8Array | Buffer
  fields: ESignField[]
  values: Record<string, any>
  auditTrail?: ESignAuditTrailItem[]
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const pages = pdfDoc.getPages()
  const selectFont = await createFontSelector(pdfDoc)
  const font = await selectFont("Electronic Signature Certificate")

  for (const field of fields) {
    assertFieldGeometry(field, pages)
    const page = pages[field.page_index]
    const { width, height, transform } = signingPageGeometry(page)
    const x = field.x * width
    const y = height - (field.y + field.h) * height
    const w = field.w * width
    const h = field.h * height

    const value = resolveFieldValue(values, field.id)
    if (value === null || value === "") continue
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...transform))

    if (field.field_type === "checkbox") {
      const strokeWidth = Math.max(1, Math.round(Math.min(w, h) * 0.06))
      const checkWidth = Math.max(2, Math.round(Math.min(w, h) * 0.14))
      page.drawRectangle({
        x: x + strokeWidth * 0.5,
        y: y + strokeWidth * 0.5,
        width: Math.max(2, w - strokeWidth),
        height: Math.max(2, h - strokeWidth),
        borderWidth: strokeWidth,
        borderColor: rgb(0.15, 0.15, 0.15),
      })

      if (value === true) {
        const leftX = x + w * 0.18
        const midX = x + w * 0.42
        const rightX = x + w * 0.82
        const lowY = y + h * 0.34
        const midY = y + h * 0.14
        const highY = y + h * 0.76

        page.drawLine({
          start: { x: leftX, y: lowY },
          end: { x: midX, y: midY },
          thickness: checkWidth,
          color: rgb(0.12, 0.12, 0.12),
        })
        page.drawLine({
          start: { x: midX, y: midY },
          end: { x: rightX, y: highY },
          thickness: checkWidth,
          color: rgb(0.12, 0.12, 0.12),
        })
      }

      page.pushOperators(popGraphicsState())
      continue
    }

    if (field.field_type === "signature" && typeof value === "string") {
      const normalized = await validateSignaturePng(value)
      const image = await pdfDoc.embedPng(Buffer.from(normalized.split(",")[1], "base64"))
      const scale = Math.min((w * 0.99) / image.width, (h * 0.99) / image.height)
      const drawWidth = image.width * scale
      const drawHeight = image.height * scale
      page.drawImage(image, {
        x: x + (w - drawWidth) / 2,
        y: y + (h - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      })
      page.pushOperators(popGraphicsState())
      continue
    }

    if (typeof value === "string") {
      const text = field.field_type === "date" ? formatSigningDate(value, field.metadata?.dateFormat) : value
      const fieldFont = await selectFont(text, field.metadata?.fontFamily)
      const requestedSize = Number(field.metadata?.fontSize ?? 14)
      let fontSize = Number.isFinite(requestedSize) ? Math.max(6, Math.min(18, requestedSize)) : 14
      const padding = Math.min(2, w * 0.03, h * 0.03)
      let lines = wrapText(text, fieldFont, fontSize, w - 2 * padding)
      while ((lines.length * fontSize * 1.2 > h - 2 * padding || lines.some(line => fieldFont.widthOfTextAtSize(line, fontSize) > w - 2 * padding)) && fontSize > 6) {
        fontSize = Math.max(6, fontSize - 0.5)
        lines = wrapText(text, fieldFont, fontSize, w - 2 * padding)
      }
      if (lines.length * fontSize * 1.2 > h - 2 * padding || lines.some(line => fieldFont.widthOfTextAtSize(line, fontSize) > w - 2 * padding)) {
        throw new Error("Text does not fit its signing field. Shorten it or ask the sender to enlarge the field.")
      }
      const lineHeight = fontSize * 1.2
      const top = y + h - (h - lines.length * lineHeight) / 2
      lines.forEach((line, index) => page.drawText(line, {
        x: x + padding,
        y: top - (index + 1) * lineHeight + fontSize * 0.15,
        size: fontSize,
        font: fieldFont,
        color: rgb(0.15, 0.15, 0.15),
      }))
    }
    page.pushOperators(popGraphicsState())
  }

  if (auditTrail?.length) {
    let auditPage = pdfDoc.addPage()
    const { width, height } = auditPage.getSize()
    const margin = 48
    const labelWidth = 142
    const valueX = margin + labelWidth + 10
    const valueWidth = width - valueX - margin
    const valueSize = 9
    const lineHeight = 13
    let cursorY = height - margin

    const startAuditPage = (includeTitle: boolean) => {
      if (includeTitle) {
        auditPage.drawText("Electronic Signature Certificate", {
          x: margin,
          y: cursorY,
          size: 18,
          font,
          color: rgb(0.08, 0.08, 0.08),
        })
        cursorY -= 28

        auditPage.drawText("This certificate summarizes audit evidence recorded by Arc for this executed document.", {
          x: margin,
          y: cursorY,
          size: 10,
          font,
          color: rgb(0.25, 0.25, 0.25),
        })
        cursorY -= 24
      } else {
        auditPage.drawText("Electronic Signature Certificate, continued", {
          x: margin,
          y: cursorY,
          size: 12,
          font,
          color: rgb(0.18, 0.18, 0.18),
        })
        cursorY -= 24
      }
    }

    const addAuditPage = () => {
      auditPage = pdfDoc.addPage()
      cursorY = height - margin
      startAuditPage(false)
    }

    startAuditPage(true)

    for (const item of auditTrail) {
      const label = `${item.label}:`
      const value = String(item.value ?? "Not recorded")
      const valueFont = await selectFont(value)
      const valueLines = wrapText(value, valueFont, valueSize, valueWidth)
      const rowHeight = Math.max(lineHeight, valueLines.length * lineHeight) + 4

      if (cursorY - rowHeight < margin) {
        addAuditPage()
      }

      auditPage.drawText(label, {
        x: margin,
        y: cursorY,
        size: valueSize,
        font,
        color: rgb(0.12, 0.12, 0.12),
      })

      for (const line of valueLines) {
        if (cursorY < margin) {
          addAuditPage()
        }
        auditPage.drawText(line, {
          x: valueX,
          y: cursorY,
          size: valueSize,
          font: valueFont,
          color: rgb(0.25, 0.25, 0.25),
        })
        cursorY -= lineHeight
      }

      cursorY -= 4
    }
  }

  return pdfDoc.save()
}
