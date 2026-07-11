import { createDocumentKit, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export async function renderSubmittalRegisterPdf(data: {
  header: DocumentHeader
  rows: Array<{ number: string; revision: number; title: string; specSection?: string | null; status: string; ballInCourt?: string | null; dueDate?: string | null }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawTable(kit, [
    { label: "No.", width: 65, value: (row) => row.number },
    { label: "Rev", width: 35, value: (row) => row.revision, align: "right" },
    { label: "Title", width: 188, value: (row) => row.title },
    { label: "Spec", width: 65, value: (row) => row.specSection },
    { label: "Status", width: 70, value: (row) => row.status },
    { label: "BIC", width: 60, value: (row) => row.ballInCourt },
    { label: "Due", width: 45, value: (row) => row.dueDate },
  ], data.rows)
  return saveDocumentKit(kit)
}

