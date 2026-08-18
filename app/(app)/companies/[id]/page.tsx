import { redirect } from "next/navigation";

interface LegacyCompanyPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string }>;
}

/** The company account moved under the directory; old links keep working. */
export default async function LegacyCompanyDetailPage({
  params,
  searchParams,
}: LegacyCompanyPageProps) {
  const { id } = await params;
  const { tab } = (await searchParams) ?? {};
  redirect(tab === "compliance" ? `/directory/${id}/compliance` : `/directory/${id}`);
}
