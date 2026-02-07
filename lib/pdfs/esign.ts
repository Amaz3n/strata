import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

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

function decodeDataUrl(dataUrl: string): Uint8Array {
  const [, base64] = dataUrl.split(",")
  if (!base64) {
    throw new Error("Invalid data URL")
  }
  return Buffer.from(base64, "base64")
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
}: {
  pdfBytes: Uint8Array | Buffer
  fields: ESignField[]
  values: Record<string, any>
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
      const isPng = value.startsWith("data:image/png")
      const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes)
      const scale = Math.min(w / image.width, h / image.height)
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

  return pdfDoc.save()
}
