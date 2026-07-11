import { createDocumentKit, drawKeyValueGrid, drawParagraph, drawSectionTitle, drawSignatureLines, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export async function renderTransmittalPdf(data: {
  header: DocumentHeader
  subject: string
  purpose: string
  notes?: string | null
  sentAt?: string | null
  recipients: Array<{ name: string; company?: string | null; email: string }>
  items: Array<{ description: string; type?: string | null; copies: number }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawKeyValueGrid(kit, [
    { label: "Subject", value: data.subject }, { label: "Purpose", value: data.purpose.replaceAll("_", " ") },
    { label: "Sent", value: data.sentAt }, { label: "Recipients", value: data.recipients.length },
  ])
  if (data.notes) drawParagraph(kit, data.notes, { label: "Notes" })
  drawSectionTitle(kit, "Recipients")
  drawTable(kit, [
    { label: "Name", width: 190, value: (row) => row.name },
    { label: "Company", width: 160, value: (row) => row.company },
    { label: "Email", width: 178, value: (row) => row.email },
  ], data.recipients)
  drawSectionTitle(kit, "Enclosures")
  drawTable(kit, [
    { label: "Description", width: 388, value: (row) => row.description },
    { label: "Type", width: 95, value: (row) => row.type },
    { label: "Copies", width: 45, value: (row) => row.copies, align: "right" },
  ], data.items)
  drawSignatureLines(kit, ["Sent by", "Received by"])
  return saveDocumentKit(kit)
}

