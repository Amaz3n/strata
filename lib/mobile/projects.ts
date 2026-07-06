import type { Project } from "@/lib/types"
import type { MobileProjectDTO } from "@/lib/mobile/contracts"

export function mapMobileProject(project: Project): MobileProjectDTO {
  return {
    id: project.id,
    organization_id: project.org_id,
    name: project.name,
    status: project.status,
    address: project.address ?? null,
    start_date: project.start_date ?? null,
    end_date: project.end_date ?? null,
    updated_at: project.updated_at,
  }
}
