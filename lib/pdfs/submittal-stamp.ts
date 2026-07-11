import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

export const DEFAULT_STAMP_DISCLAIMER =
  "Review is for general conformance with design intent and contract documents. " +
  "Approval does not relieve the contractor of responsibility for dimensions, quantities, " +
  "fabrication processes, or coordination with other trades."

const decisionDisplay: Record<string, string> = {
  approved: "APPROVED",
  approved_as_noted: "APPROVED AS NOTED",
  revise_resubmit: "REVISE & RESUBMIT",
  rejected: "REJECTED",
}

function wrapText(text: string, font: { widthOfTextAtSize(text: string, size: number): number }, size: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Draws the review stamp block on page 1 (top-right) of a submittal document:
 * org name, "REVIEWED — <DECISION>", reviewer, date, and the disclaimer line.
 * Returns new PDF bytes; the input is never mutated on disk.
 */
export async function applySubmittalReviewStamp({
  pdfBytes,
  orgName,
  decision,
  reviewerLine,
  dateLabel,
  disclaimer,
}: {
  pdfBytes: Uint8Array | Buffer
  orgName: string
  decision: string
  reviewerLine: string
  dateLabel: string
  disclaimer?: string | null
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const page = pdfDoc.getPages()[0]
  if (!page) throw new Error("Document has no pages to stamp")

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const { width, height } = page.getSize()
  const stampWidth = Math.min(240, width * 0.42)
  const margin = 16
  const padding = 10
  const innerWidth = stampWidth - padding * 2

  const decisionLabel = decisionDisplay[decision] ?? decision.replace(/_/g, " ").toUpperCase()
  const disclaimerText = (disclaimer?.trim() || DEFAULT_STAMP_DISCLAIMER).trim()
  const disclaimerLines = wrapText(disclaimerText, font, 6, innerWidth)

  const headerSize = 8
  const decisionSize = 11
  const metaSize = 7.5
  const disclaimerSize = 6

  const stampHeight =
    padding + // top
    headerSize + 6 +
    decisionSize + 8 +
    metaSize + 4 + // reviewer
    metaSize + 8 + // date
    disclaimerLines.length * (disclaimerSize + 2) +
    padding

  const x = width - stampWidth - margin
  const yTop = height - margin
  const y = yTop - stampHeight

  const ink = rgb(0.72, 0.11, 0.11)

  page.drawRectangle({
    x,
    y,
    width: stampWidth,
    height: stampHeight,
    borderWidth: 1.5,
    borderColor: ink,
    color: rgb(1, 1, 1),
    opacity: 0.82,
    borderOpacity: 1,
  })

  let cursorY = yTop - padding - headerSize

  page.drawText(orgName.toUpperCase(), {
    x: x + padding,
    y: cursorY,
    size: headerSize,
    font: bold,
    color: ink,
  })
  cursorY -= decisionSize + 6

  page.drawText(`REVIEWED — ${decisionLabel}`, {
    x: x + padding,
    y: cursorY,
    size: decisionSize,
    font: bold,
    color: ink,
  })
  cursorY -= metaSize + 8

  page.drawText(`By: ${reviewerLine}`, {
    x: x + padding,
    y: cursorY,
    size: metaSize,
    font,
    color: ink,
  })
  cursorY -= metaSize + 4

  page.drawText(`Date: ${dateLabel}`, {
    x: x + padding,
    y: cursorY,
    size: metaSize,
    font,
    color: ink,
  })
  cursorY -= disclaimerSize + 8

  for (const line of disclaimerLines) {
    page.drawText(line, {
      x: x + padding,
      y: cursorY,
      size: disclaimerSize,
      font,
      color: ink,
    })
    cursorY -= disclaimerSize + 2
  }

  return pdfDoc.save()
}
