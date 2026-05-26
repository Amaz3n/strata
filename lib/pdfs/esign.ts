import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import sharp from "sharp"

type FieldType = "signature" | "initials" | "text" | "date" | "checkbox" | "name"

export interface ESignField {
  id: string
  page_index: number
  field_type: FieldType
  x: number
  y: number
  w: number
  h: number
}

export interface ESignAuditTrailItem {
  label: string
  value: string | null | undefined
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const [, base64] = dataUrl.split(",")
  if (!base64) {
    throw new Error("Invalid data URL")
  }
  return Buffer.from(base64, "base64")
}

async function trimSignatureImage(bytes: Uint8Array | Buffer) {
  try {
    return await sharp(bytes, { limitInputPixels: 20_000_000 })
      .trim({ threshold: 12 })
      .png()
      .toBuffer()
  } catch {
    return bytes
  }
}

function wrapText(text: string, font: any, size: number, maxWidth: number) {
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
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

  for (const field of fields) {
    const page = pages[field.page_index]
    if (!page) continue

    const { width, height } = page.getSize()
    const x = field.x * width
    const y = height - (field.y + field.h) * height
    const w = field.w * width
    const h = field.h * height

    const value = resolveFieldValue(values, field.id)
    if (value === null) continue

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

      continue
    }

    if (field.field_type === "signature" && typeof value === "string") {
      const bytes = decodeDataUrl(value)
      const trimmedBytes = await trimSignatureImage(bytes)
      const image = await pdfDoc.embedPng(trimmedBytes)
      const scale = Math.min((w * 0.99) / image.width, (h * 0.99) / image.height)
      const drawWidth = image.width * scale
      const drawHeight = image.height * scale
      page.drawImage(image, {
        x: x + (w - drawWidth) / 2,
        y: y + (h - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      })
      continue
    }

    if (typeof value === "string") {
      const fontSize = Math.min(18, Math.max(10, Math.round(h * 0.6)))
      page.drawText(value, {
        x: x + 4,
        y: y + (h - fontSize) / 2,
        size: fontSize,
        font,
        color: rgb(0.15, 0.15, 0.15),
      })
    }
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
      const valueLines = wrapText(value, font, valueSize, valueWidth)
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
          font,
          color: rgb(0.25, 0.25, 0.25),
        })
        cursorY -= lineHeight
      }

      cursorY -= 4
    }
  }

  return pdfDoc.save()
}
