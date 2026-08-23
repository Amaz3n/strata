import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";

// A full-bleed message log with no rollup strip, matching the real register so
// the page does not jump when the mail lands.
export default function Loading() {
  return <CompanyTabSkeleton rows={12} flush />;
}
