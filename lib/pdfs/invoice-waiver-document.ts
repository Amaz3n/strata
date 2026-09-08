import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { PrepareWaiverInput, WaiverPlacement } from "@/lib/lien-waivers/invoice-waiver"
import { WAIVER_CONSENT, WAIVER_PDF_LIMIT } from "@/lib/lien-waivers/invoice-waiver"
import { resolveWaiverForm } from "@/lib/lien-waivers/forms"

export async function inspectWaiverPdf(bytes: Uint8Array) {
  if (bytes.byteLength > WAIVER_PDF_LIMIT) throw new Error("Choose a PDF smaller than 15 MB")
  if (!Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("Choose a valid PDF")
  let pdf: PDFDocument
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }) } catch {
    throw new Error("This PDF could not be opened. Use an unlocked PDF.")
  }
  if (!pdf.getPageCount() || pdf.getPageCount() > 50) throw new Error("Use a PDF with 1–50 pages")
  return pdf
}

export async function renderCustomInvoiceWaiver(bytes: Uint8Array, fields: WaiverPlacement[], input: PrepareWaiverInput, invoiceNumber: string, signedAt?: string) {
  const pdf = await inspectWaiverPdf(bytes)
  // Paint the original form's widgets first. Flattening after our overlays can
  // cover the filled values with an empty widget's white appearance stream.
  const form = pdf.getForm()
  if (form.getFields().length) form.flatten()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const signature = await pdf.embedFont(StandardFonts.HelveticaOblique)
  if (input.exceptions && !fields.some((f) => f.key === "exceptions")) {
    throw new Error("This template has no exceptions field. Add one to the template before including exceptions.")
  }
  const values = {
    ...input, amount: (input.amount_cents / 100).toFixed(2), invoice_number: invoiceNumber,
    signer_name: signedAt ? input.signer_name : "", signed_date: signedAt?.slice(0, 10) ?? "",
  }
  for (const field of fields) {
    const page = pdf.getPage(field.page)
    if (!page) throw new Error("A template field refers to a missing page")
    if (page.getRotation().angle !== 0) throw new Error("Save this template with page rotation applied before mapping fields")
    const text = values[field.key]
    if (!text) continue
    const face = field.key === "signer_name" ? signature : font
    const width = field.width * page.getWidth()
    const height = field.height * page.getHeight()
    let size = Math.min(field.key === "signer_name" ? 14 : 11, height * 0.65)
    let lines: string[] = []
    try {
      for (; size >= 7; size -= 0.5) {
        lines = []
        for (const paragraph of String(text).split(/\r?\n/)) {
          let line = ""
          for (const word of paragraph.split(/\s+/)) {
            const next = line ? `${line} ${word}` : word
            if (line && face.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word }
            else line = next
          }
          lines.push(line)
        }
        const fits = lines.every((line) => face.widthOfTextAtSize(line, size) <= width)
          && lines.length * size * 1.2 <= height
          && (field.key !== "signer_name" || lines.length === 1)
        if (fits) break
      }
    } catch { throw new Error(`The ${field.key.replaceAll("_", " ")} field contains characters this PDF font cannot print`) }
    if (size < 7 || lines.length * size * 1.2 > height) throw new Error(`The ${field.key.replaceAll("_", " ")} field is too small. Enlarge it in the template.`)
    page.drawText(lines.join("\n"), { x: field.x * page.getWidth(), y: page.getHeight() * (1 - field.y) - size,
      size, font: face, color: rgb(0.08, 0.08, 0.08), lineHeight: size * 1.2 })
  }
  // Issued copies are static; the original template remains untouched and reusable.
  return Buffer.from(await pdf.save())
}

export async function renderArcInvoiceWaiver(input: PrepareWaiverInput, invoiceNumber: string, waiverId: string, signedAt?: string) {
  const exceptions = input.exceptions.split("\n").map((s) => s.trim()).filter(Boolean)
  const form = resolveWaiverForm({ jurisdiction: input.jurisdiction, kind: input.waiver_type, fields: {
    claimantName: input.claimant_name, customerName: input.customer_name, ownerName: input.owner_name,
    propertyDescription: input.property_description, amountCents: input.amount_cents,
    throughDate: input.through_date, invoiceNumber, exceptions,
  } })
  const { renderPayablesLienWaiverPdf } = await import("@/lib/pdfs/payables-lien-waiver")
  return renderPayablesLienWaiverPdf({ form, claimantName: input.claimant_name, customerName: input.customer_name,
    ownerName: input.owner_name, propertyDescription: input.property_description, amountCents: input.amount_cents,
    throughDate: input.through_date, billNumber: invoiceNumber, exceptions, waiverId,
    signerName: signedAt ? input.signer_name : null, signerTitle: input.signer_title, signedAt,
    consentStatement: signedAt ? WAIVER_CONSENT : null })
}
