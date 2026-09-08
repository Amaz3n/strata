import { renderToBuffer } from "@react-pdf/renderer";
import { WaiverTemplateDocument } from "@/lib/pdfs/waiver-template";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
import type { PrepareWaiverInput } from "@/lib/lien-waivers/invoice-waiver";
import { editableWaiverValues } from "@/lib/lien-waivers/preparation";
export async function renderEditableInvoiceWaiver(
  template: WaiverTemplateDraft,
  input: PrepareWaiverInput,
  invoiceNumber: string,
) {
  if (template.body.includes("{{project_name}}") && !input.project_name)
    throw new Error("Enter the project name used by this template");
  return renderToBuffer(
    WaiverTemplateDocument({
      draft: template,
      values: editableWaiverValues(input),
      invoiceNumber,
    }),
  );
}
