import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"

import type { ScheduleA } from "@/lib/sales/agreement-packet"

/**
 * The signing packet: Arc's Schedule A, then the org's own agreement and addenda
 * byte-for-byte (each checked against the hash the packet pinned), then one
 * manifest and signature page naming every document by title, version and
 * SHA-256 and the packet hash. The signature covers that last page, so it
 * covers the exact list of documents.
 */

export type PacketPdfDocument = { title: string; versionNumber: number; sha256: string; bytes: Uint8Array }

const PAGE = { width: 612, height: 792, margin: 54 }
const INK = rgb(0.1, 0.1, 0.1)
const MUTED = rgb(0.42, 0.42, 0.42)
const RULE = rgb(0.82, 0.82, 0.82)

const REPLACEMENTS: Record<string, string> = { "—": "-", "–": "-", "‘": "'", "’": "'", "“": "\"", "”": "\"", "→": "->", "…": "..." }

/** The standard fonts encode WinAnsi only; anything else would throw mid-render. */
function printable(value: string): string {
  return [...value].map((char) => REPLACEMENTS[char] ?? (/[\x20-\x7e\xa0-\xff]/.test(char) ? char : "?")).join("")
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of printable(text).split(/\r?\n/)) {
    let line = ""
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

class Writer {
  page: PDFPage
  y: number
  constructor(private pdf: PDFDocument, private regular: PDFFont, private bold: PDFFont) {
    this.page = pdf.addPage([PAGE.width, PAGE.height])
    this.y = PAGE.height - PAGE.margin
  }
  ensure(height: number) {
    if (this.y - height >= PAGE.margin) return
    this.page = this.pdf.addPage([PAGE.width, PAGE.height])
    this.y = PAGE.height - PAGE.margin
  }
  text(value: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {}) {
    const size = options.size ?? 10
    const font = options.bold ? this.bold : this.regular
    for (const line of wrap(value, font, size, options.width ?? PAGE.width - PAGE.margin * 2 - (options.x ?? 0))) {
      this.ensure(size + 4)
      this.page.drawText(line, { x: PAGE.margin + (options.x ?? 0), y: this.y - size, size, font, color: options.color ?? INK })
      this.y -= size + 4
    }
  }
  row(label: string, value: string, options: { bold?: boolean } = {}) {
    this.ensure(16)
    const font = options.bold ? this.bold : this.regular
    const printed = printable(value)
    this.page.drawText(printable(label), { x: PAGE.margin, y: this.y - 10, size: 10, font, color: INK, maxWidth: 360 })
    this.page.drawText(printed, { x: PAGE.width - PAGE.margin - font.widthOfTextAtSize(printed, 10), y: this.y - 10, size: 10, font, color: INK })
    this.y -= 16
  }
  rule() {
    this.ensure(10)
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y - 4 }, end: { x: PAGE.width - PAGE.margin, y: this.y - 4 }, thickness: 0.5, color: RULE })
    this.y -= 10
  }
  gap(height = 10) {
    this.y -= height
  }
}

export async function renderPurchaseAgreementPacket(input: {
  orgName: string
  title: string
  scheduleA: ScheduleA
  documents: PacketPdfDocument[]
  packetHash: string
  signers: Array<{ role: string; name: string }>
}): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const { scheduleA } = input

  const schedule = new Writer(pdf, regular, bold)
  schedule.text(input.orgName, { size: 9, color: MUTED })
  schedule.text(`${input.title} - Schedule A`, { size: 16, bold: true })
  schedule.text(`Agreement ${scheduleA.agreementNumber}${scheduleA.effectiveDate ? ` · Effective ${scheduleA.effectiveDate}` : ""}`, { size: 9, color: MUTED })
  schedule.gap()
  schedule.text("Buyers", { size: 11, bold: true })
  for (const buyer of scheduleA.buyers) schedule.row(buyer.name, buyer.email ?? "")
  schedule.gap()
  schedule.text("Property", { size: 11, bold: true })
  for (const fact of scheduleA.property) schedule.row(fact.label, fact.value)
  schedule.gap()
  schedule.text("Purchase price", { size: 11, bold: true })
  for (const line of scheduleA.priceLines) schedule.row(line.label, money(line.amountCents))
  schedule.rule()
  schedule.row("Purchase price", money(scheduleA.totalCents), { bold: true })
  schedule.gap()
  schedule.text("Financing and contingencies", { size: 11, bold: true })
  for (const condition of scheduleA.conditions) schedule.row(condition.label, condition.value)
  if (scheduleA.stipulations) {
    schedule.gap()
    schedule.text("Special stipulations", { size: 11, bold: true })
    schedule.text(scheduleA.stipulations)
  }

  for (const document of input.documents) {
    if (createHash("sha256").update(document.bytes).digest("hex") !== document.sha256) {
      throw new Error(`"${document.title}" v${document.versionNumber} failed its integrity check; the published document's bytes changed`)
    }
    const source = await PDFDocument.load(document.bytes, { updateMetadata: false })
    const form = source.getForm()
    if (form.getFields().length) form.flatten()
    const pages = await pdf.copyPages(source, source.getPageIndices())
    for (const page of pages) pdf.addPage(page)
  }

  const manifest = new Writer(pdf, regular, bold)
  manifest.text("Documents in this agreement", { size: 14, bold: true })
  manifest.text("The buyer and the builder sign this page. Their signatures cover each document listed here, identified by its SHA-256.", { size: 9, color: MUTED })
  manifest.gap()
  manifest.row("Schedule A (prepared by the builder for this sale)", "")
  input.documents.forEach((document, index) => {
    manifest.row(`${index + 1}. ${document.title}`, `Version ${document.versionNumber}`)
    manifest.text(`SHA-256 ${document.sha256}`, { size: 7, color: MUTED, x: 12 })
  })
  manifest.rule()
  manifest.text(`Packet ${input.packetHash}`, { size: 7, color: MUTED })
  manifest.gap(24)
  for (const signer of input.signers) {
    manifest.ensure(48)
    manifest.gap(20)
    manifest.page.drawLine({ start: { x: PAGE.margin, y: manifest.y }, end: { x: PAGE.margin + 260, y: manifest.y }, thickness: 0.5, color: INK })
    manifest.gap(4)
    manifest.text(`${signer.role}: ${signer.name}`, { size: 9 })
  }

  return Buffer.from(await pdf.save())
}
