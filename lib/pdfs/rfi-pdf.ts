import { createDocumentKit, drawKeyValueGrid, drawParagraph, drawSectionTitle, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export type RfiPdfData = {
  header: DocumentHeader
  subject: string
  status: string
  priority?: string | null
  dueDate?: string | null
  drawingReference?: string | null
  specReference?: string | null
  location?: string | null
  costImpactCents?: number | null
  scheduleImpactDays?: number | null
  question: string
  decisionStatus?: string | null
  decisionNote?: string | null
  responses: Array<{ author?: string | null; date: string; type?: string | null; body: string }>
}

export async function renderRfiPdf(data: RfiPdfData): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawKeyValueGrid(kit, [
    { label: "Subject", value: data.subject },
    { label: "Status", value: data.status },
    { label: "Priority", value: data.priority },
    { label: "Due", value: data.dueDate },
    { label: "Drawing reference", value: data.drawingReference },
    { label: "Spec reference", value: data.specReference },
    { label: "Location", value: data.location },
    { label: "Schedule impact", value: data.scheduleImpactDays == null ? null : `${data.scheduleImpactDays} days` },
    { label: "Cost impact", value: data.costImpactCents == null ? null : `$${(data.costImpactCents / 100).toLocaleString()}` },
  ])
  drawSectionTitle(kit, "Question")
  drawParagraph(kit, data.question)
  drawSectionTitle(kit, "Response history")
  drawTable(kit, [
    { label: "Date", width: 90, value: (row) => row.date },
    { label: "Author", width: 110, value: (row) => row.author },
    { label: "Type", width: 75, value: (row) => row.type },
    { label: "Response", width: 253, value: (row) => row.body },
  ], data.responses)
  drawSectionTitle(kit, "Decision")
  drawKeyValueGrid(kit, [{ label: "Status", value: data.decisionStatus }, { label: "Notes", value: data.decisionNote }])
  return saveDocumentKit(kit)
}

