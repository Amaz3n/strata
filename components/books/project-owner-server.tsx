import { requireOrgContext } from "@/lib/services/context";
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module";
import { ProjectBooksOwner } from "./project-owner";
export async function ProjectBooksOwnership({
  projectId,
}: {
  projectId: string;
}) {
  const c = await requireOrgContext();
  if (!(await isBooksWorkspaceEnabled(c.orgId))) return null;
  return (
    <ProjectBooksOwner
      orgId={c.orgId}
      actorId={c.userId}
      projectId={projectId}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
