import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";
import { getInventoryWorkspace } from "@/lib/services/books/inventory";
import {
  WarrantyAccounting,
  WarrantyReserveEstimate,
} from "@/components/books/warranty-accounting";

export async function ProjectInventoryLink({
  projectId,
  applicable = true,
}: {
  projectId: string;
  applicable?: boolean;
}) {
  if (!applicable || !(await getBooksUiAccess()).adjust) return null;
  return (
    <div className="flex justify-end py-3">
      <Button asChild variant="outline" size="sm">
        <Link href={`/projects/${projectId}/financials/inventory`}>
          Inventory accounting
        </Link>
      </Button>
    </div>
  );
}

export async function ProjectWarrantyAccounting({
  projectId,
}: {
  projectId: string;
}) {
  if (!(await getBooksUiAccess()).adjust) return null;
  const hasInventory = (await getInventoryWorkspace()).some(
    (project) => project.id === projectId,
  );
  return (
    <div className="space-y-4">
      {hasInventory ? <WarrantyReserveEstimate projectId={projectId} /> : null}
      <WarrantyAccounting projectId={projectId} />
    </div>
  );
}
