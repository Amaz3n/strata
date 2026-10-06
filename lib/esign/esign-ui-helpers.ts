export type BulkRecipient = { name: string; email: string; title?: string }

/** Parse quoted CSV without silently dropping invalid recipients. */
export function parseBulkRecipientCsv(input: string): { recipients: BulkRecipient[]; errors: string[] } {
  const rows: string[][] = []
  let row: string[] = [], cell = "", quoted = false
  const errors: string[] = []
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell.trim()); cell = ""
      if (char === '\n') { rows.push(row); row = [] }
    } else if (char !== '\r') cell += char
  }
  if (quoted) errors.push("An opening quote is missing its closing quote.")
  row.push(cell.trim()); rows.push(row)
  const recipients: BulkRecipient[] = [], seen = new Set<string>()
  rows.forEach((columns, index) => {
    if (columns.every(value => !value)) return
    const email = (columns.length === 1 ? columns[0] : columns[1]).toLowerCase()
    if (columns.length > 3 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) {
      errors.push(`Row ${index + 1}: use email or name,email,optional title.`); return
    }
    if (seen.has(email)) { errors.push(`Row ${index + 1}: duplicate recipient ${email}.`); return }
    seen.add(email)
    recipients.push({ name: columns.length === 1 ? "" : columns[0], email, title: columns[2] || undefined })
  })
  if (recipients.length > 100) errors.push("Send at most 100 recipients in one batch.")
  return { recipients, errors }
}

export function unsignedDraftValues(fields: Array<{id: string; field_type: string}>, values: Record<string, unknown>) {
  const result: Record<string, string | boolean> = {}
  for (const field of fields) {
    const value = values[field.id]
    if (field.field_type === "signature") continue
    if (typeof value === "boolean" || (typeof value === "string" && value.length <= 10000 && !value.startsWith("data:"))) result[field.id] = value
  }
  return result
}

export function readUnsignedDraft(raw: string | null, fields: Array<{id: string; field_type: string}>, now = Date.now()) {
  try {
    const draft = JSON.parse(raw ?? "null")
    if (draft?.version !== 1 || typeof draft.savedAt !== "number" || now - draft.savedAt > 86400000 || draft.savedAt > now || !draft.values || typeof draft.values !== "object") return null
    return unsignedDraftValues(fields, draft.values)
  } catch { return null }
}
