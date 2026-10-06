import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
/** Shared by the browser preview and issued PDF; top-left normalized coordinates. */
export async function renderOriginalWaiver(
  bytes: Uint8Array,
  template: WaiverTemplateDraft,
  values: Record<string, string>,
  preview = false,
) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.getForm().getFields().length) pdf.getForm().flatten();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of template.document?.placements ?? []) {
    const page = pdf.getPages()[field.page];
    if (!page) throw new Error(`Field ${field.key} refers to a missing page`);
    if (page.getRotation().angle !== 0)
      throw new Error(
        "Apply page rotation to the original PDF before mapping fields",
      );
    const text =
      field.kind === "text"
        ? (values[field.key] ?? "")
        : preview
          ? `[${field.kind}]`
          : "";
    if (!text) continue;
    const width = field.width * page.getWidth(),
      height = field.height * page.getHeight();
    let size = Math.min(template.document?.fontSize ?? 10, height / 1.2),
      lines: string[] = [];
    try {
      for (; size >= 7; size -= 0.5) {
        lines = [];
        for (const paragraph of text.split(/\r?\n/)) {
          let line = "";
          for (const word of paragraph.split(/\s+/)) {
            const next = line ? `${line} ${word}` : word;
            if (line && font.widthOfTextAtSize(next, size) > width) {
              lines.push(line);
              line = word;
            } else line = next;
          }
          lines.push(line);
        }
        if (
          lines.every((line) => font.widthOfTextAtSize(line, size) <= width) &&
          lines.length * size * 1.2 <= height
        )
          break;
      }
    } catch {
      throw new Error(
        `The ${field.key} field contains characters unsupported by the original PDF font. Use the editable document or change this value.`,
      );
    }
    if (size < 7)
      throw new Error(
        `Enlarge the ${field.key} field on page ${field.page + 1}; its value does not fit`,
      );
    page.drawText(lines.join("\n"), {
      x: field.x * page.getWidth(),
      y: (1 - field.y) * page.getHeight() - size,
      size,
      lineHeight: size * 1.2,
      font,
      color: rgb(0.08, 0.08, 0.08),
    });
  }
  return pdf.save();
}
