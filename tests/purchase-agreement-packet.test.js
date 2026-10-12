require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const test = require("node:test")
const { PDFDocument, StandardFonts } = require("pdf-lib")

const { renderPurchaseAgreementPacket } = require("../lib/pdfs/purchase-agreement-packet")

async function counselPdf(title, pages) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pages; index += 1) pdf.addPage([612, 792]).drawText(`${title} page ${index + 1}`, { x: 72, y: 700, size: 12, font })
  const bytes = await pdf.save()
  return { title, versionNumber: 2, sha256: createHash("sha256").update(bytes).digest("hex"), bytes }
}

const scheduleA = {
  agreementNumber: "PA-2026-1", effectiveDate: "2026-10-12", buyers: [{ name: "Pat Buyer", email: "pat@example.test" }],
  property: [{ label: "Lot", value: "B-47" }], priceLines: [{ label: "Community base price", amountCents: 385_000_00 }],
  totalCents: 385_000_00, stipulations: null, conditions: [{ label: "Financing", value: "Financed purchase" }],
}

test("the packet is Schedule A, then each of counsel's documents page for page, then one signature page naming them", async () => {
  const agreement = await counselPdf("Purchase agreement", 3)
  const addendum = await counselPdf("HOA disclosure", 2)
  const bytes = await renderPurchaseAgreementPacket({
    orgName: "Gulf Homes", title: "Purchase Agreement — Lot 47", scheduleA, documents: [agreement, addendum],
    packetHash: "d".repeat(64), signers: [{ role: "Buyer", name: "Pat Buyer" }, { role: "Gulf Homes", name: "Sam Seller" }],
  })
  const packet = await PDFDocument.load(bytes)
  assert.equal(packet.getPageCount(), 1 + 3 + 2 + 1)
})

test("a document whose bytes no longer match the hash the packet pinned is never rendered", async () => {
  const agreement = await counselPdf("Purchase agreement", 1)
  await assert.rejects(
    renderPurchaseAgreementPacket({ orgName: "Gulf Homes", title: "PA", scheduleA, documents: [{ ...agreement, sha256: "0".repeat(64) }], packetHash: "d".repeat(64), signers: [] }),
    /failed its integrity check/,
  )
})
