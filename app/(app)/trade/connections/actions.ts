"use server";
import { runAction } from "@/lib/action-result";
import { openTradeBuilderConnection } from "@/lib/services/external-portal-auth";
import {
  endProjectConnection,
  linkBuilderProject,
  openProjectConnectionPortal,
} from "@/lib/services/project-connections";
export async function openBuilderConnectionAction(grantId: string) {
  return runAction(() => openTradeBuilderConnection(grantId));
}
export async function linkBuilderProjectAction(input: unknown) {
  return runAction(() => linkBuilderProject(input));
}
export async function unlinkProjectConnectionAction(connectionId: string) {
  return runAction(() => endProjectConnection(connectionId));
}
export async function openProjectConnectionPortalAction(connectionId: string) {
  return runAction(() => openProjectConnectionPortal(connectionId));
}
