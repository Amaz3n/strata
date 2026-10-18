import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksAuthorization } from "@/lib/services/books/access";
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module";

export async function PayrollCorrectionWorkflowLink({
  projectId,
}: {
  projectId: string;
}) {
  const c = await requireOrgContext();
  try {
    await requireBooksAuthorization({
      permission: "books.adjust",
      orgId: c.orgId,
      userId: c.userId,
      supabase: c.supabase,
      logDecision: false,
    });
    if (!(await isBooksWorkspaceEnabled(c.orgId))) return null;
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
  return (
    <div className="mb-4 flex justify-end">
      <Button asChild variant="outline" size="sm">
        <Link href={`/projects/${projectId}/time/payroll`}>
          Payroll corrections
        </Link>
      </Button>
    </div>
  );
}
