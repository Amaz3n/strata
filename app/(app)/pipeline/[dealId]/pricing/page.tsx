import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { DealPricing } from "@/components/pipeline/deal-pricing";
import { DealTabSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealPricing } from "@/lib/services/precon-deals";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ row?: string }>;
};

export const instant = {
  unstable_disableBuildValidation: true,
};

async function loadPricing(dealId: string) {
  "use cache: private";
  cacheLife("deal");
  return getDealPricing(dealId);
}

async function Pricing({ params, searchParams }: Props) {
  const [{ dealId }, query] = await Promise.all([params, searchParams]);
  const data = await loadPricing(dealId);
  return <DealPricing {...data} focusRow={query.row ?? null} />;
}

/** The deal's price: every line and how it is priced, or where to start it from. */
export default function DealPricingPage(props: Props) {
  return (
    <Suspense fallback={<DealTabSkeleton />}>
      <Pricing {...props} />
    </Suspense>
  );
}
