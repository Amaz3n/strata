import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";
import { getProjectDirectoryAccess } from "@/lib/services/project-directory";
import { withSpan } from "@/lib/observability/spans";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const parsed = z
    .array(z.string().uuid())
    .max(50)
    .safeParse(new URL(request.url).searchParams.get("ids")?.split(",") ?? []);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid projects" }, { status: 400 });
  try {
    const context = await requireOrgContext();
    await requirePermission("schedule.read", context);
    if (!parsed.data.length)
      return NextResponse.json(
        {},
        { headers: { "Cache-Control": "private, no-store" } },
      );
    const access = await getProjectDirectoryAccess(context);
    // Verify requested IDs against the same visibility predicates as the table.
    let query = context.supabase
      .from("projects")
      .select("id, project_members!inner(user_id,status)")
      .eq("org_id", context.orgId)
      .eq("phase", "delivery")
      .in("id", parsed.data);
    if (access.divisionIds) query = query.in("division_id", access.divisionIds);
    const visible = access.allProjects
      ? await (() => {
          let q = context.supabase
            .from("projects")
            .select("id")
            .eq("org_id", context.orgId)
            .eq("phase", "delivery")
            .in("id", parsed.data);
          if (access.divisionIds) q = q.in("division_id", access.divisionIds);
          return q;
        })()
      : await query
          .eq("project_members.user_id", context.userId)
          .eq("project_members.status", "active");
    if (visible.error) throw new Error(visible.error.message);
    const result = await withSpan(
      "projects.progress",
      { rows: visible.data?.length ?? 0 },
      async () =>
        await createServiceSupabaseClient().rpc(
          "get_project_directory_schedule_summaries",
          {
            p_org_id: context.orgId,
            p_project_ids: (visible.data ?? []).map((p) => p.id),
          },
        ),
    );
    if (result.error) throw new Error(result.error.message);
    return NextResponse.json(
      Object.fromEntries(
        (result.data ?? []).map((row: { project_id: string }) => [
          row.project_id,
          row,
        ]),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("Project progress read failed", error);
    return NextResponse.json(
      { error: "Progress is unavailable" },
      { status: 500 },
    );
  }
}
