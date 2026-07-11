import { createDocumentKit, drawSignatureLines, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export async function renderPunchListPdf(data: {
  header: DocumentHeader
  items: Array<{ number: number; title: string; description?: string | null; location?: string | null; status: string; company?: string | null; dueDate?: string | null }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawTable(kit, [
    { label: "#", width: 32, value: (row) => row.number },
    { label: "Item", width: 225, value: (row) => `${row.title}${row.description ? ` — ${row.description}` : ""}` },
    { label: "Location", width: 85, value: (row) => row.location },
    { label: "Company", width: 85, value: (row) => row.company },
    { label: "Status", width: 58, value: (row) => row.status },
    { label: "Due", width: 43, value: (row) => row.dueDate },
  ], data.items)
  drawSignatureLines(kit, ["Contractor", "Owner / Architect"])
  return saveDocumentKit(kit)
}

