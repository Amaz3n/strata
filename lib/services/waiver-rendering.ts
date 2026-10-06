import "server-only";
import { physicalWaiverTemplate } from "@/lib/templates/waiver-physical";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
import {
  resolveWaiverValues,
  validateWaiverValues,
  validateWaiverSigners,
} from "@/lib/templates/waiver-engine";
import { downloadFilesObject } from "@/lib/storage/files-storage";
export async function renderCompanyWaiver(input: {
  template: WaiverTemplateDraft;
  values: Record<string, string>;
  customValues?: Record<string, string>;
  onResolved?: (values: Record<string, string>) => void;
  physicalSigning?: boolean;
  additionalSigners?: { role: string; name: string; email: string }[];
  invoiceNumber?: string;
  sourceFileId?: string;
  supabase: SupabaseClient;
  orgId: string;
}) {
  if (input.physicalSigning) input = { ...input, template: physicalWaiverTemplate(input.template) };
  const values = resolveWaiverValues(
    input.template,
    { ...input.values, invoice_number: input.invoiceNumber ?? "" },
    input.customValues,
  );
  validateWaiverValues(input.template, values);
  if (!input.physicalSigning) validateWaiverSigners(input.template, input.additionalSigners);
  input.onResolved?.(values);
  if (input.template.document?.mode === "original") {
    if (!input.sourceFileId)
      throw new Error("This template has no original PDF");
    const { data, error } = await input.supabase
      .from("files")
      .select("storage_path")
      .eq("org_id", input.orgId)
      .eq("id", input.sourceFileId)
      .eq("folder_path", "/Templates/Originals")
      .is("archived_at", null)
      .single();
    if (error || !data) throw new Error("Original waiver PDF unavailable");
    const { renderOriginalWaiver } = await import("@/lib/pdfs/waiver-original");
    return Buffer.from(
      await renderOriginalWaiver(
        await downloadFilesObject({ ...input, path: data.storage_path }),
        input.template,
        values,
      ),
    );
  }
  const [{ renderToBuffer }, { WaiverTemplateDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("@/lib/pdfs/waiver-template"),
  ]);
  return renderToBuffer(
    WaiverTemplateDocument({
      draft: input.template,
      values,
      invoiceNumber: input.invoiceNumber,
    }),
  );
}
