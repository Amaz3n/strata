import { createDocumentKit, drawKeyValueGrid, drawParagraph, drawSectionTitle, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export async function renderMeetingMinutesPdf(data: {
  header: DocumentHeader
  series: string
  title: string
  heldAt?: string | null
  location?: string | null
  attendees: Array<{ name: string; company?: string | null; present: boolean }>
  items: Array<{ number: string; topic: string; discussion?: string | null; status: string; ballInCourt?: string | null; dueDate?: string | null; carried: boolean }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawKeyValueGrid(kit, [
    { label: "Meeting", value: data.title }, { label: "Series", value: data.series.toUpperCase() },
    { label: "Held", value: data.heldAt }, { label: "Location", value: data.location },
  ])
  drawSectionTitle(kit, "Attendance")
  drawTable(kit, [
    { label: "Name", width: 240, value: (row) => row.name },
    { label: "Company", width: 220, value: (row) => row.company },
    { label: "Present", width: 68, value: (row) => row.present ? "Yes" : "No" },
  ], data.attendees)
  for (const [label, items] of [["Old business", data.items.filter((item) => item.carried)], ["New business", data.items.filter((item) => !item.carried)]] as const) {
    drawSectionTitle(kit, label)
    if (!items.length) {
      drawParagraph(kit, "No items.")
      continue
    }
    drawTable(kit, [
      { label: "Item", width: 48, value: (row) => row.number },
      { label: "Topic / discussion", width: 270, value: (row) => `${row.topic}${row.discussion ? ` — ${row.discussion}` : ""}` },
      { label: "Status", width: 65, value: (row) => row.status },
      { label: "BIC", width: 82, value: (row) => row.ballInCourt },
      { label: "Due", width: 63, value: (row) => row.dueDate },
    ], items)
  }
  return saveDocumentKit(kit)
}

