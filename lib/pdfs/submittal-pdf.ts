import { createDocumentKit, drawKeyValueGrid, drawParagraph, drawSectionTitle, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export type SubmittalPdfData = {
  header: DocumentHeader
  title: string
  description?: string | null
  status: string
  revision: number
  specSection?: string | null
  dueDate?: string | null
  requiredOnSite?: string | null
  ballInCourt?: string | null
  decisionStatus?: string | null
  decisionNote?: string | null
  items: Array<{ number: string | number; description: string; manufacturer?: string | null; model?: string | null }>
  reviewSteps?: Array<{ order: number; reviewer: string; status: string; decision?: string | null; decidedAt?: string | null }>
}

export async function renderSubmittalPdf(data: SubmittalPdfData): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawKeyValueGrid(kit, [
    { label: "Title", value: data.title }, { label: "Status", value: data.status },
    { label: "Revision", value: data.revision }, { label: "Spec section", value: data.specSection },
    { label: "Due", value: data.dueDate }, { label: "Required on site", value: data.requiredOnSite },
    { label: "Ball in court", value: data.ballInCourt }, { label: "Decision", value: data.decisionStatus },
  ])
  if (data.description) drawParagraph(kit, data.description, { label: "Description" })
  drawSectionTitle(kit, "Submitted items")
  drawTable(kit, [
    { label: "Item", width: 50, value: (row) => row.number },
    { label: "Description", width: 258, value: (row) => row.description },
    { label: "Manufacturer", width: 110, value: (row) => row.manufacturer },
    { label: "Model", width: 110, value: (row) => row.model },
  ], data.items)
  if (data.reviewSteps?.length) {
    drawSectionTitle(kit, "Review routing")
    drawTable(kit, [
      { label: "Step", width: 45, value: (row) => row.order },
      { label: "Reviewer", width: 180, value: (row) => row.reviewer },
      { label: "Status", width: 90, value: (row) => row.status },
      { label: "Decision", width: 110, value: (row) => row.decision },
      { label: "Date", width: 103, value: (row) => row.decidedAt },
    ], data.reviewSteps)
  }
  if (data.decisionNote) drawParagraph(kit, data.decisionNote, { label: "Decision notes" })
  return saveDocumentKit(kit)
}

