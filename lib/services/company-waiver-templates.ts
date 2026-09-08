import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  waiverTemplateSchema,
  type CompanyWaiverTemplate,
} from "@/lib/templates/waiver-template";
export const COMPANY_WAIVER_TEMPLATE_FOLDER = "/Templates/Editable waivers";
export async function listEditableWaiverTemplates(ctx: {
  supabase: SupabaseClient;
  orgId: string;
}, options: { publishedOnly?: boolean; direction?: "incoming" | "outgoing"; jurisdiction?: string } = {}): Promise<CompanyWaiverTemplate[]> {
  const { data, error } = await ctx.supabase
    .from("files")
    .select("id,metadata,created_at")
    .eq("org_id", ctx.orgId)
    .eq("folder_path", COMPANY_WAIVER_TEMPLATE_FOLDER)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error("Unable to load company waiver templates");
  const seen = new Set<string>();
  return (data ?? []).flatMap((row) => {
    const raw = row.metadata?.editable_waiver;
    const parsed = waiverTemplateSchema.safeParse(raw);
    if (
      !parsed.success ||
      (options.publishedOnly && parsed.data.status !== "published") ||
      (options.direction && (parsed.data.applicability ?? "outgoing") !== "both" && (parsed.data.applicability ?? "outgoing") !== options.direction) ||
      (options.jurisdiction && parsed.data.jurisdiction && parsed.data.jurisdiction !== options.jurisdiction) ||
      typeof raw.familyId !== "string" ||
      seen.has(raw.familyId)
    )
      return [];
    seen.add(raw.familyId);
    return [
      {
        ...parsed.data,
        id: row.id,
        familyId: raw.familyId,
        createdAt: row.created_at,
        sourceFileId: raw.sourceFileId,
        revision: Number(raw.revision) || 1,
      },
    ];
  });
}
