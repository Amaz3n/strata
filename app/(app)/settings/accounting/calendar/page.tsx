import { Suspense } from "react";
import { connection } from "next/server";
import { AccountingSection } from "@/components/settings/accounting-section";
import { AccountingCalendar } from "@/components/settings/accounting-calendar";
import { SettingsPanelSkeleton } from "@/components/settings/settings-skeleton";
import { getBooksWorkspace } from "@/lib/services/books/workspace";
import { getBooksModuleSettings } from "@/lib/services/books/module";
import { getCurrentUserPermissions } from "@/lib/services/permissions";

async function Calendar() {
  await connection();
  const [workspace, module, { permissions }] = await Promise.all([
    getBooksWorkspace(undefined, "calendar"),
    getBooksModuleSettings(),
    getCurrentUserPermissions(),
  ]);
  return (
    <AccountingCalendar
      periods={workspace.periods}
      settings={module.settings}
      canCreate={workspace.capabilities.close}
      canManageFiscal={
        permissions.includes("org.admin") || permissions.includes("*")
      }
    />
  );
}
export default function AccountingCalendarPage() {
  return (
    <AccountingSection title="Accounting calendar">
      <Suspense fallback={<SettingsPanelSkeleton />}>
        <Calendar />
      </Suspense>
    </AccountingSection>
  );
}
