import {
  createDocumentKit,
  drawKeyValueGrid,
  drawParagraph,
  drawSectionTitle,
  drawSignatureLines,
  saveDocumentKit,
  type DocumentHeader,
} from "@/lib/pdfs/document-kit"

export async function renderIncidentPdf(data: {
  header: DocumentHeader
  occurredAt: string
  severity: string
  classification: string | null
  status: string
  location: string | null
  involvedCompanyName: string | null
  involvedPersonName: string | null
  witnessNames: string | null
  isOshaRecordable: boolean
  description: string
  immediateAction: string | null
  rootCause: string | null
}): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)

  drawKeyValueGrid(kit, [
    { label: "Date / time of incident", value: data.occurredAt },
    { label: "Severity", value: data.severity.replace(/_/g, " ") },
    { label: "Classification", value: data.classification },
    { label: "Status", value: data.status.replace(/_/g, " ") },
    { label: "Location", value: data.location },
    { label: "OSHA recordable", value: data.isOshaRecordable ? "Yes" : "No" },
    { label: "Involved company", value: data.involvedCompanyName },
    { label: "Involved person", value: data.involvedPersonName },
  ])

  drawSectionTitle(kit, "Description")
  drawParagraph(kit, data.description)

  if (data.witnessNames) {
    drawSectionTitle(kit, "Witnesses")
    drawParagraph(kit, data.witnessNames)
  }

  drawSectionTitle(kit, "Immediate action taken")
  drawParagraph(kit, data.immediateAction ?? "—")

  drawSectionTitle(kit, "Root cause")
  drawParagraph(kit, data.rootCause ?? "—")

  drawSignatureLines(kit, ["Reported by", "Safety manager"])
  return saveDocumentKit(kit)
}
