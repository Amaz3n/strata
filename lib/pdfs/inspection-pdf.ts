import {
  createDocumentKit,
  drawKeyValueGrid,
  drawParagraph,
  drawSectionTitle,
  drawSignatureLines,
  drawTable,
  saveDocumentKit,
  type DocumentHeader,
} from "@/lib/pdfs/document-kit"

export async function renderInspectionPdf(data: {
  header: DocumentHeader
  kind: string
  status: string
  result: string | null
  inspectorName: string | null
  inspectedAt: string | null
  location: string | null
  companyName: string | null
  notes: string | null
  items: Array<{
    section: string | null
    prompt: string
    response: string | null
    isDeficient: boolean
    note: string | null
  }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)

  drawKeyValueGrid(kit, [
    { label: "Type", value: data.kind === "safety" ? "Safety" : "Quality" },
    { label: "Result", value: data.result ? data.result.toUpperCase() : data.status.replace(/_/g, " ") },
    { label: "Inspector", value: data.inspectorName },
    { label: "Date", value: data.inspectedAt },
    { label: "Location", value: data.location },
    { label: "Company inspected", value: data.companyName },
  ])

  const sections = new Map<string, typeof data.items>()
  for (const item of data.items) {
    const key = item.section ?? ""
    const list = sections.get(key) ?? []
    list.push(item)
    sections.set(key, list)
  }

  for (const [section, items] of sections) {
    if (section) drawSectionTitle(kit, section)
    drawTable(kit, [
      { label: "Item", width: 320, value: (row) => row.prompt },
      { label: "Response", width: 76, value: (row) => (row.response ? row.response.replace(/_/g, " ") : "—") },
      { label: "Deficient", width: 56, value: (row) => (row.isDeficient ? "YES" : "") },
      { label: "Note", width: 76, value: (row) => row.note },
    ], items)
  }

  if (data.notes) {
    drawSectionTitle(kit, "Notes")
    drawParagraph(kit, data.notes)
  }

  drawSignatureLines(kit, ["Inspector", "Superintendent"])
  return saveDocumentKit(kit)
}
