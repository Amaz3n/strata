import { connection } from "next/server";
import { Suspense } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { BuilderConnections } from "@/components/trade/builder-connections";
import { getTradeBuilderWorkspace } from "@/lib/services/external-portal-auth";
import {
  listLinkableJobs,
  listProjectConnectionsForGrants,
} from "@/lib/services/project-connections";
import { defaultTradeJobType } from "@/lib/business-profile";
import { getOrgProductTier } from "@/lib/services/context";

async function Connections() {
  await connection();
  const [workspace, linkable, tier] = await Promise.all([
    getTradeBuilderWorkspace(),
    listLinkableJobs(),
    getOrgProductTier(),
  ]);
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
  const links = await listProjectConnectionsForGrants(
    items.filter((item) => item.kind === "sub").map((item) => item.id),
  );
  return (
    <PageLayout title="Builder connections">
      <BuilderConnections
        items={items}
        links={links}
        linkableJobs={linkable.jobs}
        linkableJobsTruncated={linkable.truncated}
        defaultJobType={defaultTradeJobType(tier)}
      />
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
