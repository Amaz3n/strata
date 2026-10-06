import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { BuilderConnections } from "@/components/trade/builder-connections";
import { getTradeBuilderWorkspace } from "@/lib/services/external-portal-auth";

async function Connections() {
  await connection();
  const workspace = await getTradeBuilderWorkspace();
  // Raw portal tokens never enter this client list. The open action resolves
  // the grant against the current verified identity again before navigation.
  const items = (workspace?.items ?? [])
    .filter((item) => item.kind === "sub" || item.kind === "bid")
    .map(({ id, kind, org_name, project_name, subtitle, due_at }) => ({
      id,
      kind,
      org_name,
      project_name,
      subtitle,
      due_at,
    }));
  return (
    <PageLayout title="Builder connections">
      <BuilderConnections items={items} />
    </PageLayout>
  );
}
export default function Page() {
  return (
    <Suspense fallback={<PageLayout title="Builder connections"><PageLoadingSkeleton /></PageLayout>}>
      <Connections />
    </Suspense>
  );
}
