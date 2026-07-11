import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"

const PAGE = { width: 612, height: 792, margin: 42 }
const COLORS = {
  ink: rgb(0.12, 0.14, 0.16),
  muted: rgb(0.38, 0.41, 0.45),
  line: rgb(0.78, 0.8, 0.82),
  fill: rgb(0.94, 0.95, 0.96),
}

export type DocumentHeader = {
  orgName: string
  orgAddress?: string | null
  projectName: string
  projectNumber?: string | null
  title: string
  documentNumber?: string | null
  date?: string | null
}

export type DocumentTableColumn<T> = {
  label: string
  width: number
  value: (row: T) => string | number | null | undefined
  align?: "left" | "right"
}

export type DocumentKit = {
  pdf: PDFDocument
  font: PDFFont
  bold: PDFFont
  page: PDFPage
  y: number
  header: DocumentHeader
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const paragraphs = text.split(/\r?\n/)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let line = ""
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    lines.push(line)
  }
  return lines.length ? lines : [""]
}

function drawHeader(kit: DocumentKit) {
  const { page, bold, font, header } = kit
  const top = PAGE.height - PAGE.margin
  page.drawText(header.orgName, { x: PAGE.margin, y: top, font: bold, size: 12, color: COLORS.ink })
  if (header.orgAddress) {
    page.drawText(header.orgAddress, { x: PAGE.margin, y: top - 14, font, size: 7, color: COLORS.muted })
  }
  page.drawText(header.title.toUpperCase(), { x: 350, y: top, font: bold, size: 13, color: COLORS.ink })
  const number = header.documentNumber ? `NO. ${header.documentNumber}` : ""
  if (number) page.drawText(number, { x: 350, y: top - 15, font: bold, size: 8, color: COLORS.muted })
  page.drawLine({
    start: { x: PAGE.margin, y: top - 28 },
    end: { x: PAGE.width - PAGE.margin, y: top - 28 },
    thickness: 1,
    color: COLORS.ink,
  })
  const project = header.projectNumber ? `${header.projectNumber}  ${header.projectName}` : header.projectName
  page.drawText(project, { x: PAGE.margin, y: top - 43, font: bold, size: 9, color: COLORS.ink })
  if (header.date) page.drawText(header.date, { x: 450, y: top - 43, font, size: 8, color: COLORS.muted })
  kit.y = top - 64
}

export async function createDocumentKit(header: DocumentHeader): Promise<DocumentKit> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const kit: DocumentKit = { pdf, font, bold, page: pdf.addPage([PAGE.width, PAGE.height]), y: 0, header }
  drawHeader(kit)
  return kit
}

export function addDocumentPage(kit: DocumentKit): PDFPage {
  kit.page = kit.pdf.addPage([PAGE.width, PAGE.height])
  drawHeader(kit)
  return kit.page
}

function ensureSpace(kit: DocumentKit, height: number) {
  if (kit.y - height < PAGE.margin + 22) addDocumentPage(kit)
}

export function drawSectionTitle(kit: DocumentKit, title: string) {
  ensureSpace(kit, 24)
  kit.page.drawRectangle({ x: PAGE.margin, y: kit.y - 13, width: PAGE.width - PAGE.margin * 2, height: 18, color: COLORS.fill })
  kit.page.drawText(title.toUpperCase(), { x: PAGE.margin + 6, y: kit.y - 8, font: kit.bold, size: 8, color: COLORS.ink })
  kit.y -= 26
}

export function drawParagraph(kit: DocumentKit, text: string, options?: { label?: string; size?: number }) {
  const size = options?.size ?? 9
  if (options?.label) {
    ensureSpace(kit, 18)
    kit.page.drawText(options.label.toUpperCase(), { x: PAGE.margin, y: kit.y, font: kit.bold, size: 7, color: COLORS.muted })
    kit.y -= 12
  }
  const lines = wrap(text || "—", kit.font, size, PAGE.width - PAGE.margin * 2)
  for (const line of lines) {
    ensureSpace(kit, size + 5)
    kit.page.drawText(line, { x: PAGE.margin, y: kit.y, font: kit.font, size, color: COLORS.ink })
    kit.y -= size + 4
  }
  kit.y -= 6
}

export function drawKeyValueGrid(kit: DocumentKit, values: Array<{ label: string; value?: string | number | null }>) {
  const columnWidth = (PAGE.width - PAGE.margin * 2) / 2
  for (let index = 0; index < values.length; index += 2) {
    ensureSpace(kit, 30)
    for (let offset = 0; offset < 2; offset += 1) {
      const item = values[index + offset]
      if (!item) continue
      const x = PAGE.margin + offset * columnWidth
      kit.page.drawText(item.label.toUpperCase(), { x, y: kit.y, font: kit.bold, size: 6.5, color: COLORS.muted })
      kit.page.drawText(String(item.value ?? "—"), { x, y: kit.y - 13, font: kit.font, size: 9, color: COLORS.ink })
    }
    kit.y -= 31
  }
  kit.y -= 4
}

export function drawTable<T>(kit: DocumentKit, columns: DocumentTableColumn<T>[], rows: T[]) {
  const drawTableHeader = () => {
    ensureSpace(kit, 22)
    let x = PAGE.margin
    kit.page.drawRectangle({ x, y: kit.y - 14, width: PAGE.width - PAGE.margin * 2, height: 18, color: COLORS.fill })
    for (const column of columns) {
      kit.page.drawText(column.label.toUpperCase(), { x: x + 4, y: kit.y - 9, font: kit.bold, size: 6.5, color: COLORS.muted })
      x += column.width
    }
    kit.y -= 21
  }
  drawTableHeader()
  for (const row of rows) {
    const cells = columns.map((column) => wrap(String(column.value(row) ?? "—"), kit.font, 7.5, column.width - 8))
    const rowHeight = Math.max(19, Math.max(...cells.map((cell) => cell.length)) * 10 + 6)
    if (kit.y - rowHeight < PAGE.margin + 22) {
      addDocumentPage(kit)
      drawTableHeader()
    }
    let x = PAGE.margin
    columns.forEach((column, columnIndex) => {
      cells[columnIndex].forEach((line, lineIndex) => {
        const textWidth = kit.font.widthOfTextAtSize(line, 7.5)
        const textX = column.align === "right" ? x + column.width - textWidth - 4 : x + 4
        kit.page.drawText(line, { x: textX, y: kit.y - 10 - lineIndex * 10, font: kit.font, size: 7.5, color: COLORS.ink })
      })
      x += column.width
    })
    kit.page.drawLine({ start: { x: PAGE.margin, y: kit.y - rowHeight }, end: { x: PAGE.width - PAGE.margin, y: kit.y - rowHeight }, thickness: 0.5, color: COLORS.line })
    kit.y -= rowHeight
  }
  kit.y -= 10
}

export function drawSignatureLines(kit: DocumentKit, labels: string[]) {
  ensureSpace(kit, 52)
  const gap = 20
  const width = (PAGE.width - PAGE.margin * 2 - gap * (labels.length - 1)) / labels.length
  labels.forEach((label, index) => {
    const x = PAGE.margin + index * (width + gap)
    kit.page.drawLine({ start: { x, y: kit.y - 24 }, end: { x: x + width, y: kit.y - 24 }, thickness: 0.6, color: COLORS.ink })
    kit.page.drawText(label, { x, y: kit.y - 37, font: kit.font, size: 7, color: COLORS.muted })
  })
  kit.y -= 50
}

export async function drawImageGrid(kit: DocumentKit, images: Array<{ bytes: Uint8Array; mimeType: string; caption?: string | null }>) {
  if (images.length === 0) return
  const gap = 10
  const width = (PAGE.width - PAGE.margin * 2 - gap) / 2
  const height = 150
  ensureSpace(kit, height + 50)
  drawSectionTitle(kit, "Photos")
  for (let index = 0; index < images.length; index += 2) {
    ensureSpace(kit, height + 24)
    const row = images.slice(index, index + 2)
    for (let offset = 0; offset < row.length; offset += 1) {
      const image = row[offset]
      let embedded
      try {
        embedded = image.mimeType === "image/png" ? await kit.pdf.embedPng(image.bytes) : await kit.pdf.embedJpg(image.bytes)
      } catch {
        continue
      }
      const scale = Math.min(width / embedded.width, height / embedded.height)
      const drawWidth = embedded.width * scale
      const drawHeight = embedded.height * scale
      const x = PAGE.margin + offset * (width + gap) + (width - drawWidth) / 2
      const y = kit.y - drawHeight
      kit.page.drawImage(embedded, { x, y, width: drawWidth, height: drawHeight })
      if (image.caption) kit.page.drawText(image.caption.slice(0, 60), { x: PAGE.margin + offset * (width + gap), y: kit.y - height - 10, font: kit.font, size: 7, color: COLORS.muted })
    }
    kit.y -= height + 24
  }
}

export async function saveDocumentKit(kit: DocumentKit): Promise<Buffer> {
  const pages = kit.pdf.getPages()
  pages.forEach((page, index) => {
    const footer = `Page ${index + 1} of ${pages.length}  •  Generated by Arc`
    page.drawText(footer, { x: PAGE.margin, y: 22, font: kit.font, size: 7, color: COLORS.muted })
  })
  return Buffer.from(await kit.pdf.save())
}
