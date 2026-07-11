import { createDocumentKit, drawImageGrid, drawKeyValueGrid, drawParagraph, drawSectionTitle, drawTable, saveDocumentKit, type DocumentHeader } from "@/lib/pdfs/document-kit"

export async function renderDailyReportPdf(data: {
  header: DocumentHeader
  weather?: string | null
  dayType?: string | null
  summary?: string | null
  manpower: Array<{ company: string; trade?: string | null; workers: number; hours?: number | null }>
  entries: Array<{ type: string; description: string; quantity?: number | null; hours?: number | null; location?: string | null }>
  delays?: Array<{ type: string; description: string; hoursLost?: number | null; affectedTrades?: string | null; potentialClaim?: boolean }>
  equipment?: Array<{ description: string; company?: string | null; count: number; hoursUsed?: number | null; idle?: boolean }>
  deliveries?: Array<{ description: string; supplier?: string | null; quantity?: string | null; ticketNumber?: string | null }>
  visitors?: Array<{ name: string; company?: string | null; purpose?: string | null; timeIn?: string | null; timeOut?: string | null }>
  submittedBy?: string | null
  submittedAt?: string | null
  photos?: Array<{ bytes: Uint8Array; mimeType: string; caption?: string | null }>
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)
  drawKeyValueGrid(kit, [{ label: "Weather", value: data.weather }, { label: "Day type", value: data.dayType }])
  if (data.summary) drawParagraph(kit, data.summary, { label: "Summary" })
  drawSectionTitle(kit, "Manpower")
  drawTable(kit, [
    { label: "Company", width: 230, value: (row) => row.company },
    { label: "Trade", width: 155, value: (row) => row.trade },
    { label: "Workers", width: 70, value: (row) => row.workers, align: "right" },
    { label: "Hours", width: 73, value: (row) => row.hours, align: "right" },
  ], data.manpower)
  const groups = new Map<string, typeof data.entries>()
  for (const entry of data.entries) {
    const rows = groups.get(entry.type) ?? []
    rows.push(entry)
    groups.set(entry.type, rows)
  }
  for (const [type, entries] of groups) {
    drawSectionTitle(kit, type.replaceAll("_", " "))
    drawTable(kit, [
      { label: "Description", width: 338, value: (row) => row.description },
      { label: "Location", width: 100, value: (row) => row.location },
      { label: "Qty", width: 45, value: (row) => row.quantity, align: "right" },
      { label: "Hours", width: 45, value: (row) => row.hours, align: "right" },
    ], entries)
  }
  if (data.delays?.length) {
    drawSectionTitle(kit, "Delays")
    drawTable(kit, [
      { label: "Type", width: 70, value: (row) => row.type },
      { label: "Description", width: 255, value: (row) => row.description },
      { label: "Trades", width: 100, value: (row) => row.affectedTrades },
      { label: "Hours", width: 48, value: (row) => row.hoursLost, align: "right" },
      { label: "Claim", width: 55, value: (row) => row.potentialClaim ? "Yes" : "" },
    ], data.delays)
  }
  if (data.equipment?.length) {
    drawSectionTitle(kit, "Equipment")
    drawTable(kit, [
      { label: "Description", width: 225, value: (row) => row.description },
      { label: "Company", width: 160, value: (row) => row.company },
      { label: "Count", width: 50, value: (row) => row.count, align: "right" },
      { label: "Hours", width: 50, value: (row) => row.hoursUsed, align: "right" },
      { label: "Idle", width: 43, value: (row) => row.idle ? "Yes" : "" },
    ], data.equipment)
  }
  if (data.deliveries?.length) {
    drawSectionTitle(kit, "Deliveries")
    drawTable(kit, [
      { label: "Description", width: 230, value: (row) => row.description },
      { label: "Supplier", width: 145, value: (row) => row.supplier },
      { label: "Quantity", width: 75, value: (row) => row.quantity },
      { label: "Ticket", width: 78, value: (row) => row.ticketNumber },
    ], data.deliveries)
  }
  if (data.visitors?.length) {
    drawSectionTitle(kit, "Visitors")
    drawTable(kit, [
      { label: "Name", width: 135, value: (row) => row.name },
      { label: "Company", width: 135, value: (row) => row.company },
      { label: "Purpose", width: 175, value: (row) => row.purpose },
      { label: "In", width: 40, value: (row) => row.timeIn },
      { label: "Out", width: 43, value: (row) => row.timeOut },
    ], data.visitors)
  }
  if (data.submittedBy || data.submittedAt) {
    drawParagraph(kit, [data.submittedBy ? `Submitted by ${data.submittedBy}` : null, data.submittedAt].filter(Boolean).join(" · "))
  }
  if (data.photos?.length) await drawImageGrid(kit, data.photos)
  return saveDocumentKit(kit)
}
