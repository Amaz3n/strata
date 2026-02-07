export type SigningFieldType = "signature" | "initials" | "text" | "date" | "checkbox" | "name"

export interface SigningField {
  id: string
  page_index: number
  field_type: SigningFieldType
  label?: string | null
  required?: boolean | null
  signer_role?: string | null
  x: number
  y: number
  w: number
  h: number
}

export const FIELD_LABELS: Record<SigningFieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  name: "Full name",
  text: "Text",
  date: "Date",
  checkbox: "Checkbox",
}

export function normalizeFieldLabel(field: SigningField) {
  return field.label?.trim() || FIELD_LABELS[field.field_type]
}

export function isRequiredField(field: SigningField) {
  return field.required !== false
}

export function isSignatureField(field: SigningField) {
  return field.field_type === "signature"
}

export function isFieldComplete(field: SigningField, values: Record<string, unknown>) {
  const value = values[field.id]
  if (field.field_type === "checkbox") return value === true
  if (field.field_type === "signature") return typeof value === "string" && value.length > 0
  return typeof value === "string" && value.trim().length > 0
}

export function formatFieldValue(field: SigningField, value: unknown) {
  if (field.field_type === "checkbox") {
    return value === true ? "Checked" : "Unchecked"
  }

  if (field.field_type === "date" && typeof value === "string") {
    const parsed = new Date(`${value}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString()
    }
  }

  if (typeof value === "string") {
    return value
  }

  return ""
}
