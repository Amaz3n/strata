import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";

// Four figures and a grouped requirement list, matching the real workspace so
// the page does not jump when the compliance status lands.
export default function Loading() {
  return <CompanyTabSkeleton rows={6} summaryFigures={4} />;
}
