import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { SettingsPanelSkeleton } from "@/components/settings/settings-skeleton";
import { loadBooksNavigationAvailability } from "@/lib/services/books/navigation";

// Availability depends on the signed-in organization. Anonymous build samples
// cannot exercise this gate; development validation uses the real session.
export const instant = {
  unstable_disableBuildValidation: true,
};

async function AccountingSettingsAccess({
  children,
}: {
  children: ReactNode;
}) {
  if (!(await loadBooksNavigationAvailability())) redirect("/settings?tab=accounting");
  return children;
}

export default function AccountingSettingsLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<SettingsPanelSkeleton />}><AccountingSettingsAccess>{children}</AccountingSettingsAccess></Suspense>;
}
