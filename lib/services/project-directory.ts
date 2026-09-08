import "server-only";
import { cache } from "react";
import {
  requireOrgContext,
  type OrgServiceContext,
} from "@/lib/services/context";
import { getDivisionAccessForUser } from "@/lib/services/authorization";
import {
  hasAnyPermission,
  hasPermission,
  requireProjectPermission,
} from "@/lib/services/permissions";
import { getAmbientDeskContext } from "@/lib/services/desk-context";
import { withSpan } from "@/lib/observability/spans";
import {
  directoryCursorSchema,
  PROJECT_DIRECTORY_PAGE_SIZE,
  projectDirectoryQuerySchema,
  type ProjectDirectoryPage,
  type ProjectDirectoryQuery,
  type ProjectDirectoryRow,
} from "@/lib/projects/directory";
import { getProjectWithFinancials } from "@/lib/services/projects";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

// No project-ID catalog: authorization stays as division predicates and an
// assigned-project EXISTS inside the database, before ordering and pagination.
export const getProjectDirectoryAccess = cache(
  async (context: OrgServiceContext) => {
    const [division, membership, canReadAll, canReadSchedule] =
      await Promise.all([
        getDivisionAccessForUser(context),
        context.supabase
          .from("memberships")
          .select("project_scope")
          .eq("org_id", context.orgId)
          .eq("user_id", context.userId)
          .eq("status", "active"),
        hasAnyPermission(["project.read", "project.manage"], context),
        hasPermission("schedule.read", context),
      ]);
    if (membership.error)
      throw new Error(
        `Unable to resolve project scope: ${membership.error.message}`,
      );
    return {
      allProjects:
        canReadAll &&
        !(membership.data ?? []).some(
          (row) => row.project_scope === "assigned",
        ),
      divisionIds: division.assignedOnly ? division.divisionIds : null,
      canReadSchedule,
    };
  },
);

export async function loadProjectDirectory(
  raw: unknown,
  context?: OrgServiceContext,
) {
  const ctx = context ?? (await requireOrgContext());
  const query = projectDirectoryQuerySchema.parse(raw);
  return withSpan("projects.index", { sort: query.sort }, async () => {
    const [ambient, access] = await Promise.all([
      getAmbientDeskContext(),
      getProjectDirectoryAccess(ctx),
    ]);
    const requested =
      query.community === "all"
        ? undefined
        : (query.community ?? ambient.communityId);
    const communityId = ambient.communities.some((c) => c.id === requested)
      ? requested
      : undefined;
    if ((requested && !communityId) || access.divisionIds?.length === 0) {
      return {
        page: { rows: [], nextCursor: null } as ProjectDirectoryPage,
        communities: ambient.communities,
        communityId,
        canReadSchedule: access.canReadSchedule,
        divisionId: ambient.divisionId,
      };
    }
    if (query.sort === "progress" && !access.canReadSchedule)
      throw new Error("Schedule permission is required to sort by progress");
    const page = await getProjectDirectoryPage(ctx, query, access, {
      communityId,
      divisionId: ambient.divisionId,
    });
    return {
      page,
      communities: ambient.communities,
      communityId,
      canReadSchedule: access.canReadSchedule,
      divisionId: ambient.divisionId,
    };
  });
}

export async function getProjectDirectoryPage(
  context: OrgServiceContext,
  query: ProjectDirectoryQuery,
  access: { allProjects: boolean; divisionIds: string[] | null },
  scope: { communityId?: string; divisionId?: string },
): Promise<ProjectDirectoryPage> {
  const cursor = query.cursor
    ? directoryCursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      )
    : null;
  // The RPC is service-only. The request's membership and effective permissions
  // have been checked above; all resulting scope predicates are passed to SQL.
  const { data, error } = await createServiceSupabaseClient().rpc(
    "get_project_directory_page",
    {
      p_org_id: context.orgId,
      p_user_id: context.userId,
      p_all_projects: access.allProjects,
      p_division_ids: access.divisionIds,
      p_community_id: scope.communityId ?? null,
      p_division_id: scope.divisionId ?? null,
      p_exclude_reporting: Boolean(scope.communityId || scope.divisionId),
      p_search: query.q,
      p_status: query.status,
      p_sort: query.sort,
      p_direction: query.direction,
      p_cursor: cursor,
      p_limit: PROJECT_DIRECTORY_PAGE_SIZE + 1,
    },
  );
  if (error) throw new Error(`Unable to load projects: ${error.message}`);
  const raw = (data ?? []) as Array<
    ProjectDirectoryRow & { sort_text: string; sort_number: number }
  >;
  const rows = raw.slice(0, PROJECT_DIRECTORY_PAGE_SIZE);
  const last = rows.at(-1);
  const nextCursor =
    raw.length > PROJECT_DIRECTORY_PAGE_SIZE && last
      ? Buffer.from(
          JSON.stringify({
            text: last.sort_text,
            number: Number(last.sort_number),
            name: last.name,
            id: last.id,
          }),
        ).toString("base64url")
      : null;
  return {
    rows: rows.map(({ sort_text: _text, sort_number: _number, ...row }) => row),
    nextCursor,
  };
}

export async function getProjectDirectoryEditor(projectId: string) {
  const context = await requireOrgContext();
  await requireProjectPermission(context.userId, projectId, "project.read");
  const project = await getProjectWithFinancials({ projectId, context });
  if (!project) throw new Error("Project not found");
  return project;
}
