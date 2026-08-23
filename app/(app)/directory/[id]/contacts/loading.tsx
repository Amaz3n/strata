import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";

// A roster of people, no rollup strip — matching the real panel so the page
// does not jump when the contacts land.
export default function Loading() {
  return <CompanyTabSkeleton rows={5} />;
}
