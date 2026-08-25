import {
  createDocumentKit,
  drawKeyValueGrid,
  drawParagraph,
  drawSectionTitle,
  saveDocumentKit,
  type DocumentHeader,
} from "@/lib/pdfs/document-kit"

export type CorrespondencePdfMessage = {
  date: string
  direction: "inbound" | "outbound"
  from: string
  to: string
  cc?: string | null
  subject: string
  classification: string
  ruledBy: string
  links?: string | null
  attachments?: string | null
  body: string
}

export type CorrespondencePdfData = {
  header: DocumentHeader
  /** What this packet covers — the filters that produced it, or the thread. */
  scope: Array<{ label: string; value?: string | number | null }>
  messages: CorrespondencePdfMessage[]
  /** Set when the export hit its cap, so the packet does not read as complete. */
  truncatedNote?: string | null
}

/**
 * The document kit embeds Helvetica, which can only draw WinAnsi. Email bodies
 * carry whatever the sender's client produced — emoji, CJK, typographic
 * oddities — and an unmappable glyph throws rather than degrading. Fold the
 * common typographic characters onto their ASCII equivalents and replace the
 * rest, so an export never fails on one stray character.
 */
const CHARACTER_FOLDS: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—]/g, "-"],
  [/[…]/g, "..."],
  [/[   ]/g, " "],
  [/[•]/g, "-"],
]

function sanitize(value: string): string {
  let result = value.replace(/\r\n?/g, "\n")
  for (const [pattern, replacement] of CHARACTER_FOLDS) result = result.replace(pattern, replacement)
  // Everything outside printable Latin-1 plus newline and tab.
  return result.replace(/[^\n\t\x20-\x7E\xA0-\xFF]/g, "?")
}

export async function renderCorrespondencePdf(data: CorrespondencePdfData): Promise<Buffer> {
  const kit = await createDocumentKit(data.header)

  drawKeyValueGrid(
    kit,
    data.scope.map((item) => ({ label: item.label, value: item.value == null ? null : sanitize(String(item.value)) })),
  )

  if (!data.messages.length) {
    drawSectionTitle(kit, "Messages")
    drawParagraph(kit, "No correspondence matched this export.")
    return saveDocumentKit(kit)
  }

  data.messages.forEach((message, index) => {
    drawSectionTitle(kit, `${index + 1}. ${sanitize(message.subject)}`)
    drawKeyValueGrid(kit, [
      { label: "Date", value: sanitize(message.date) },
      { label: message.direction === "outbound" ? "Sent to" : "From", value: sanitize(message.direction === "outbound" ? message.to : message.from) },
      { label: "Classification", value: `${sanitize(message.classification)} (${sanitize(message.ruledBy)})` },
      { label: "Cc", value: message.cc ? sanitize(message.cc) : null },
      { label: "Linked to", value: message.links ? sanitize(message.links) : null },
      { label: "Attachments", value: message.attachments ? sanitize(message.attachments) : null },
    ])
    drawParagraph(kit, sanitize(message.body))
  })

  if (data.truncatedNote) {
    drawSectionTitle(kit, "Incomplete export")
    drawParagraph(kit, sanitize(data.truncatedNote))
  }

  return saveDocumentKit(kit)
}
