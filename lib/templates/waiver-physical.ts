import type { WaiverTemplateDraft } from "./waiver-template"

/** Manual notarial entries are completed on paper, never fabricated during preparation. */
export function physicalWaiverTemplate(template: WaiverTemplateDraft): WaiverTemplateDraft {
  if (!template.document) return template
  return { ...template, document: { ...template.document, fields: template.document.fields.map(field =>
    field.source === "manual" && /notar/i.test(`${field.key} ${field.label}`)
      ? { ...field, source: "constant", type: "text", required: false, value: "________________" }
      : field,
  ) } }
}
