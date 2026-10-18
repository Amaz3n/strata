"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/lib/services/context";
import { requireAuthorization } from "@/lib/services/authorization";
import {
  waiverTemplateSchema,
  templateFields,
  type CompanyWaiverTemplate,
} from "@/lib/templates/waiver-template";
const folder = "/Templates/Editable waivers";
async function context() {
  const ctx = await requireOrgContext();
  await requireAuthorization({
    ...ctx,
    permission: "org.admin",
    resourceType: "organization",
    resourceId: ctx.orgId,
  });
  return ctx;
}
export async function listCompanyWaiverTemplates(): Promise<
  CompanyWaiverTemplate[]
> {
  const { listEditableWaiverTemplates } =
    await import("@/lib/services/company-waiver-templates");
  return listEditableWaiverTemplates(await requireOrgContext());
}
export async function saveCompanyWaiverTemplate(
  input: unknown,
  previousId?: string,
  sourceFileId?: string,
  expectedEditToken?: string,
): Promise<CompanyWaiverTemplate> {
  const ctx = await context();
  const draft = waiverTemplateSchema.parse(input);
  if (draft.defaults?.projectIds.length) {
    const { data, error } = await ctx.supabase
      .from("projects")
      .select("id")
      .eq("org_id", ctx.orgId)
      .in("id", draft.defaults.projectIds);
    if (error || data?.length !== new Set(draft.defaults.projectIds).size)
      throw new Error("Choose projects in your organization");
  }
  const editToken = randomUUID();
  let familyId = randomUUID();
  let revision = 1;
  let previousMetadata: Record<string, any> | undefined;
  if (previousId) {
    const { data, error } = await ctx.supabase
      .from("files")
      .select("metadata")
      .eq("org_id", ctx.orgId)
      .eq("folder_path", folder)
      .eq("id", z.string().uuid().parse(previousId))
      .single();
    if (error || !data?.metadata?.editable_waiver)
      throw new Error("Template not found");
    previousMetadata = data.metadata;
    if (
      expectedEditToken !== undefined &&
      expectedEditToken !== data.metadata.editable_waiver.editToken
    )
      throw new Error("This draft changed elsewhere. Reload before saving.");
    familyId = data.metadata.editable_waiver.familyId;
    const { data: latest, error: latestError } = await ctx.supabase
      .from("files")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("folder_path", folder)
      .eq("metadata->editable_waiver->>familyId", familyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (latestError || latest.id !== previousId)
      throw new Error(
        "This template has a newer revision. Reload it before editing.",
      );
    revision = (Number(data.metadata.editable_waiver.revision) || 1) + 1;
  }
  if (sourceFileId) {
    const { data } = await ctx.supabase
      .from("files")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("folder_path", "/Templates/Originals")
      .eq("id", z.string().uuid().parse(sourceFileId))
      .single();
    if (!data) throw new Error("Source document not found");
  }
  if (
    draft.status === "draft" &&
    previousMetadata?.editable_waiver?.status === "draft" &&
    previousId
  ) {
    let update = ctx.supabase
      .from("files")
      .update({
        metadata: {
          ...previousMetadata,
          editable_waiver: {
            ...draft,
            familyId,
            sourceFileId,
            revision: revision - 1,
            editToken,
          },
        },
        description: draft.name,
      })
      .eq("org_id", ctx.orgId)
      .eq("folder_path", folder)
      .eq("id", previousId)
      .is("archived_at", null)
      .eq("metadata->editable_waiver->>status", "draft");
    const previousToken = previousMetadata.editable_waiver.editToken;
    update = previousToken
      ? update.eq("metadata->editable_waiver->>editToken", previousToken)
      : update.is("metadata->editable_waiver->>editToken", null);
    const { data, error } = await update.select("id,created_at").maybeSingle();
    if (error) {
      console.error("Waiver draft update failed", {
        code: error.code,
        fileId: previousId,
      });
      throw new Error(
        "Unable to save this draft. Your changes are still open; try saving again.",
      );
    }
    if (!data)
      throw new Error("This draft changed elsewhere. Reload before saving.");
    return {
      ...draft,
      id: previousId,
      editToken,
      familyId,
      sourceFileId,
      revision: revision - 1,
      createdAt: data.created_at,
    };
  }
  const [
    { renderToBuffer },
    { WaiverTemplateDocument },
    { storeGeneratedPdf },
  ] = await Promise.all([
    import("@react-pdf/renderer"),
    import("@/lib/pdfs/waiver-template"),
    import("@/lib/services/generated-documents"),
  ]);
  if (draft.document?.mode === "original" && !sourceFileId)
    throw new Error("Import the original PDF before saving this template");
  let pdf = await renderToBuffer(
    WaiverTemplateDocument({
      draft:
        draft.status === "draft"
          ? {
              ...draft,
              document: undefined,
              body: "Draft template. Open Settings → Templates to continue editing.",
            }
          : draft,
    }),
  );
  if (draft.status === "published" && draft.document) {
    if (draft.document.mode === "original" && sourceFileId) {
      const { data, error } = await ctx.supabase
        .from("files")
        .select("storage_path")
        .eq("org_id", ctx.orgId)
        .eq("id", sourceFileId)
        .eq("folder_path", "/Templates/Originals")
        .single();
      if (error || !data) throw new Error("Original PDF unavailable");
      const { downloadFilesObject } =
        await import("@/lib/storage/files-storage");
      const { renderOriginalWaiver } =
        await import("@/lib/pdfs/waiver-original");
      const { waiverPreviewValues } =
        await import("@/lib/templates/waiver-engine");
      pdf = Buffer.from(
        await renderOriginalWaiver(
          await downloadFilesObject({ ...ctx, path: data.storage_path }),
          draft,
          waiverPreviewValues(draft, true),
          true,
        ),
      );
    }
    const { waiverSignatureFields } =
      await import("@/lib/pdfs/waiver-signature-fields");
    await waiverSignatureFields(pdf, 0, draft);
  }
  const stored = await storeGeneratedPdf({
    orgId: ctx.orgId,
    projectId: null,
    fileName: `${draft.name}-${randomUUID()}.pdf`,
    pdf,
    storageFolder: "editable-waiver-templates",
    folderPath: folder,
    description: draft.name,
    createdBy: ctx.userId,
    supabase: ctx.supabase,
    metadata: {
      editable_waiver: {
        ...draft,
        familyId,
        sourceFileId,
        revision,
        editToken,
      },
    },
  });
  revalidatePath("/settings/templates");
  return {
    ...draft,
    id: stored.fileId,
    editToken,
    familyId,
    revision,
    sourceFileId,
    createdAt: new Date().toISOString(),
  };
}
export async function importCompanyWaiverTemplate(formData: FormData) {
  const ctx = await context();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size || file.size > 15 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 15 MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  const { inspectWaiverPdf } =
    await import("@/lib/pdfs/invoice-waiver-document");
  const inspected = await inspectWaiverPdf(bytes);
  const { extractWaiverTemplate } =
    await import("@/lib/services/waiver-template-extraction");
  const draft = await extractWaiverTemplate(
    bytes,
    file.name,
    ctx.orgId,
    inspected.getPageCount(),
  );
  const { storeGeneratedPdf } =
    await import("@/lib/services/generated-documents");
  const stored = await storeGeneratedPdf({
    orgId: ctx.orgId,
    projectId: null,
    fileName: `${randomUUID()}-${file.name}`,
    pdf: bytes,
    storageFolder: "template-originals",
    folderPath: "/Templates/Originals",
    description: "Original waiver for template review",
    createdBy: ctx.userId,
    supabase: ctx.supabase,
  });
  return {
    draft,
    warnings: draft.warnings ?? [],
    sourceFileId: stored.fileId,
  };
}

/** Save the source first, then run extraction after the response. The UI can resume polling after navigation. */
export async function beginCompanyWaiverImport(formData: FormData) {
  const ctx = await context();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size || file.size > 15 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 15 MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  const { inspectWaiverPdf } =
    await import("@/lib/pdfs/invoice-waiver-document");
  const inspected = await inspectWaiverPdf(bytes);
  const { storeGeneratedPdf } =
    await import("@/lib/services/generated-documents");
  const stored = await storeGeneratedPdf({
    orgId: ctx.orgId,
    projectId: null,
    pdf: bytes,
    fileName: `${randomUUID()}-${file.name}`,
    storageFolder: "template-originals",
    folderPath: "/Templates/Originals",
    description: "Waiver import source",
    createdBy: ctx.userId,
    supabase: ctx.supabase,
    metadata: {
      waiver_import: { status: "reading", startedAt: new Date().toISOString() },
    },
  });
  const { after } = await import("next/server");
  after(async () => {
    let state: Record<string, unknown>;
    try {
      const { extractWaiverTemplate } =
        await import("@/lib/services/waiver-template-extraction");
      const draft = await extractWaiverTemplate(
        bytes,
        file.name,
        ctx.orgId,
        inspected.getPageCount(),
      );
      state = { status: "ready", draft };
    } catch (e) {
      state = {
        status: "failed",
        message: e instanceof Error ? e.message : "Unable to read document",
      };
    }
    const { error } = await ctx.supabase
      .from("files")
      .update({
        metadata: {
          waiver_import: { ...state, finishedAt: new Date().toISOString() },
        },
      })
      .eq("org_id", ctx.orgId)
      .eq("id", stored.fileId)
      .eq("folder_path", "/Templates/Originals");
    if (error)
      console.error("Unable to persist waiver import result", {
        fileId: stored.fileId,
        code: error.code,
      });
  });
  return { sourceFileId: stored.fileId };
}
export async function getCompanyWaiverImport(sourceFileId: string) {
  const ctx = await context();
  const { data, error } = await ctx.supabase
    .from("files")
    .select("metadata")
    .eq("org_id", ctx.orgId)
    .eq("id", z.string().uuid().parse(sourceFileId))
    .eq("folder_path", "/Templates/Originals")
    .single();
  if (error || !data) throw new Error("Import unavailable");
  const state = data.metadata?.waiver_import;
  if (state?.status === "ready")
    return {
      status: "ready" as const,
      draft: waiverTemplateSchema.parse(state.draft),
      sourceFileId,
    };
  if (state?.status === "failed")
    return {
      status: "failed" as const,
      message: state.message || "Unable to read document",
    };
  if (!state || Date.now() - Date.parse(state.startedAt) > 180_000)
    return {
      status: "failed" as const,
      message:
        "This import was interrupted. Your original is preserved; import it again to retry.",
    };
  return { status: "reading" as const };
}

export async function archiveCompanyWaiverTemplate(id: string) {
  const ctx = await context();
  const { data, error } = await ctx.supabase
    .from("files")
    .select("metadata")
    .eq("org_id", ctx.orgId)
    .eq("id", z.string().uuid().parse(id))
    .eq("folder_path", folder)
    .single();
  if (error || !data?.metadata?.editable_waiver?.familyId)
    throw new Error("Template unavailable");
  const { error: archiveError } = await ctx.supabase
    .from("files")
    .update({ archived_at: new Date().toISOString() })
    .eq("org_id", ctx.orgId)
    .eq("folder_path", folder)
    .eq(
      "metadata->editable_waiver->>familyId",
      data.metadata.editable_waiver.familyId,
    );
  if (archiveError) throw new Error("Unable to archive template");
  revalidatePath("/settings/templates");
}

/** Read-only examples; no waiver or invoice is created or changed. */
export async function listWaiverExampleInvoices(projectId: string) {
  const ctx = await context();
  const { data, error } = await ctx.supabase
    .from("invoices")
    .select("id,invoice_number,title")
    .eq("org_id", ctx.orgId)
    .eq("project_id", z.string().uuid().parse(projectId))
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("Could not load example invoices");
  return (data ?? []).map((row) => ({
    id: row.id,
    label: row.invoice_number || row.title || "Untitled invoice",
  }));
}
export async function getWaiverTemplateExample(invoiceId: string) {
  await context();
  const { invoiceWaiverContext, loadInvoiceWaiverPreparation } =
    await import("@/lib/services/invoice-waiver-workflow");
  const [ctx, details] = await Promise.all([
    invoiceWaiverContext(invoiceId),
    loadInvoiceWaiverPreparation(invoiceId),
  ]);
  return {
    invoiceNumber: ctx.invoice.invoice_number ?? "",
    values: {
      project_name: details.project_name,
      claimant_name: details.claimant_name,
      company_name: details.claimant_name,
      customer_name: details.customer_name,
      owner_name: details.owner_name,
      property_address: details.property_description,
      signer_name: details.signer_name,
      signer_title: "",
      signed_date: "________________",
      through_date: details.through_date,
      exceptions: "",
      amount: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: ctx.invoice.currency || "USD",
      }).format(Number(ctx.invoice.total_cents) / 100),
    } as Record<string, string>,
  };
}
