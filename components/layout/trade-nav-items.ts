import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  Contact,
  CreditCard,
  FolderOpen,
  Home,
  Link2,
  Settings,
  Wallet,
  BarChart3,
} from "@/components/icons";
import type { ProjectNavGroup } from "./project-nav-items";

/** Shared by desktop and mobile; routes retain their existing workbenches. */
export function buildTradeNavGroups(pathname: string): ProjectNavGroup[] {
  const item = (
    title: string,
    url: string,
    icon: typeof Home,
    requiredAny: string[],
  ) => ({
    title,
    url,
    icon,
    requiredAny,
    isActive: url === "/" ? pathname === "/" : pathname.startsWith(url),
  });
  return [
    {
      label: "Arc Trade",
      items: [
        item("Today", "/", Home, ["org.member"]),
        item("Tasks", "/tasks", ClipboardCheck, ["org.member"]),
        item("Jobs", "/projects", FolderOpen, [
          "project.read",
          "project.manage",
          "org.member",
        ]),
        item("Opportunities", "/pipeline", Contact, [
          "pipeline.read",
          "pipeline.write",
        ]),
        item("Schedule & crew", "/trade/crew", CalendarDays, ["schedule.read"]),
        item("Builder connections", "/trade/connections", Link2, [
          "org.member",
        ]),
      ],
    },
    {
      label: "Office",
      items: [
        item("Billing", "/billing", Wallet, ["invoice.read"]),
        item("Payables", "/payables", CreditCard, [
          "bill.read",
          "payment.read",
        ]),
        item("Directory", "/directory", Building2, [
          "directory.read",
          "directory.write",
        ]),
        item("Reports", "/reports", BarChart3, ["report.read"]),
        item("Company setup", "/trade/setup", Settings, ["org.admin"]),
      ],
    },
  ];
}
