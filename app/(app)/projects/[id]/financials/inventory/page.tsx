import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation";
import { InventoryWorkspace } from "@/components/books/inventory-workspace";
import { PageLayout } from "@/components/layout/page-layout";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";
import { getInventoryWorkspace } from "@/lib/services/books/inventory";

async function ProjectInventoryPageContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection()
  const [{ id }, access] = await Promise.all([params, getBooksUiAccess()]);
  if (!access.adjust) notFound();
  const project = (await getInventoryWorkspace()).find(
    (project) => project.id === id,
  );
  if (!project) notFound();
  return (
    <PageLayout
      title="Inventory accounting"
      breadcrumbs={[
        { label: project.name, href: `/projects/${id}` },
        { label: "Budget", href: `/projects/${id}/financials/budget` },
        { label: "Inventory accounting" },
      ]}
    >
      <InventoryWorkspace initialProject={project} canManage={access.manage} />
    </PageLayout>
  );
}

export default function ProjectInventoryPage(props: Parameters<typeof ProjectInventoryPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Inventory accounting">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <ProjectInventoryPageContent {...props} />
    </Suspense>
  )
}
