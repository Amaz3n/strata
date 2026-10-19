import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { PageLayout } from "@/components/layout/page-layout";
import { DealRoom } from "@/components/pipeline/deal-room";
import { DealRoomSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealRoom } from "@/lib/services/precon-deals";

type Props = {
  children: ReactNode;
  params: Promise<{ dealId: string }>;
};

// A fabricated deal id cannot pass authorization; validate with real ids in dev.
export const instant = {
  unstable_disableBuildValidation: true,
};

/** The deal's header and tabs hold while the tabs change underneath them. */
async function Deal({ children, params }: Props) {
  await connection();
  const { dealId } = await params;
  const data = await getDealRoom(dealId);
  return (
    <>
      <PageLayout
        title={data.deal.name}
        breadcrumbs={[{ label: "Pipeline", href: "/pipeline" }, { label: data.deal.name }]}
      />
      <DealRoom {...data} now={new Date().toISOString()}>
        {children}
      </DealRoom>
    </>
  );
}

export default function DealLayout(props: Props) {
  return (
    <Suspense fallback={<DealRoomSkeleton />}>
      <Deal {...props} />
    </Suspense>
  );
}
