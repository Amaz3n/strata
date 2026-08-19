import { redirect } from "next/navigation";

interface LegacyCompanyPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string }>;
}

/**
 * Tabs the old company page exposed as `?tab=`, mapped onto the routes that
 * replaced them. Anything unrecognized lands on the account overview.
 */
const TAB_ROUTES: Record<string, string> = {
  compliance: "compliance",
  prequalification: "prequalification",
  transactions: "transactions",
  commitments: "commitments",
  contacts: "contacts",
};

/** The company account moved under the directory; old links keep working. */
export default async function LegacyCompanyDetailPage({
  params,
  searchParams,
}: LegacyCompanyPageProps) {
  const { id } = await params;
  const { tab } = (await searchParams) ?? {};
  const segment = tab ? TAB_ROUTES[tab] : undefined;
  redirect(segment ? `/directory/${id}/${segment}` : `/directory/${id}`);
}
