"use server"

import { getProjectQboLink, type ProjectQboLink } from "@/lib/services/qbo-project-link"

/** Read an Arc project's linked QBO customer/project (set in the project settings sheet). */
export async function getProjectQboLinkAction(params: { projectId: string }): Promise<ProjectQboLink> {
  return getProjectQboLink({ projectId: params.projectId })
}
