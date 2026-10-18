import "server-only";
import { readAllRowsById } from "@/lib/land/paging";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  waiverTemplateSchema,
  type CompanyWaiverTemplate,
} from "@/lib/templates/waiver-template";
export const COMPANY_WAIVER_TEMPLATE_FOLDER = "/Templates/Editable waivers";
export async function listEditableWaiverTemplates(
  ctx: {
    supabase: SupabaseClient;
    orgId: string;
  },
  options: {
    publishedOnly?: boolean;
    direction?: "incoming" | "outgoing";
    jurisdiction?: string;
  } = {},
): Promise<CompanyWaiverTemplate[]> {
  const data = await readAllRowsById(
    (afterId, limit) => {
      let query = ctx.supabase
        .from("files")
        .select("id,metadata,created_at")
        .eq("org_id", ctx.orgId)
        .eq("folder_path", COMPANY_WAIVER_TEMPLATE_FOLDER)
        .is("archived_at", null)
        .order("id")
        .limit(limit);
      if (afterId) query = query.gt("id", afterId);
      return query;
    },
    { cap: 10_000, label: "Unable to load complete company waiver templates" },
  );
  data.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return data.flatMap((row) => {
    const raw = row.metadata?.editable_waiver;
    const parsed = waiverTemplateSchema.safeParse(raw);
    if (
      !parsed.success ||
      typeof raw.familyId !== "string" ||
      seen.has(raw.familyId)
    )
      return [];
    // Draft edits do not retire the active revision. A newer published revision does,
    // including when its direction or jurisdiction no longer matches this query.
    if (options.publishedOnly && parsed.data.status !== "published") return [];
    seen.add(raw.familyId);
    if (
      (options.direction &&
        (parsed.data.applicability ?? "outgoing") !== "both" &&
        (parsed.data.applicability ?? "outgoing") !== options.direction) ||
      (options.jurisdiction &&
        parsed.data.jurisdiction &&
        parsed.data.jurisdiction !== options.jurisdiction)
    )
      return [];
    return [
      {
        ...parsed.data,
        id: row.id,
        familyId: raw.familyId,
        editToken:
          typeof raw.editToken === "string" ? raw.editToken : undefined,
        createdAt: row.created_at,
        sourceFileId: raw.sourceFileId,
        revision: Number(raw.revision) || 1,
      },
    ];
  });
}
