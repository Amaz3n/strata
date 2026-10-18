import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { getProjectPayrollDraftDetail } from "./payroll-draft-workspace";
const uuid = z.string().uuid().toLowerCase();
export async function readProjectPayrollSupportVersions(input: unknown) {
  const args = z
    .object({
      projectId: uuid,
      importId: uuid,
      after: uuid.nullable().optional(),
      search: z.string().trim().max(200).default(""),
    })
    .strict()
    .parse(input);
  await getProjectPayrollDraftDetail({
    projectId: args.projectId,
    importId: args.importId,
  });
  const c = await requireOrgContext(),
    r = await createServiceSupabaseClient().rpc(
      "read_books_payroll_support_versions",
      {
        p_org_id: c.orgId,
        p_after: args.after ?? null,
        p_search: args.search,
        p_limit: 50,
      },
    );
  if (r.error)
    throw Error(
      `Payroll supporting versions could not load: ${r.error.message}`,
    );
  const page = z
    .object({
      orgId: z.literal(c.orgId),
      versions: z
        .array(
          z.object({
            id: uuid,
            org_id: z.literal(c.orgId),
            file_id: uuid,
            file_name: z.string(),
            mime_type: z.string().nullable(),
            size_bytes: z.number().int().safe().positive(),
            checksum: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .max(50),
      nextCursor: uuid.nullable(),
    })
    .parse(r.data);
  if (new Set(page.versions.map((row) => row.id)).size !== page.versions.length)
    throw Error("Payroll supporting version page identity differs");
  return page;
}
