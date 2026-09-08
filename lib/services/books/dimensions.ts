import "server-only"
import { collectBooksRows } from "@/lib/services/books/paging"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Resolve only unambiguous relationships; never assign a random lot or contract. */
export async function loadBooksProjectDimensions(orgId: string) {
  const service = createServiceSupabaseClient()
  const [projects, lots, contracts, divisions, communities] = await Promise.all([
    collectBooksRows((from,to) => service.from("projects").select("id,division_id").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("lots").select("id,project_id,community_id,lot_number").eq("org_id",orgId).not("project_id","is",null).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("contracts").select("id,project_id").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("divisions").select("id,name").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("communities").select("id,name").eq("org_id",orgId).order("id").range(from,to)),
  ])
  const divisionNames = new Map(divisions.map(row => [row.id,row.name]));
  const communityNames = new Map(communities.map(row => [row.id,row.name]));
  const lotsByProject = new Map<string, typeof lots>();
  const contractsByProject = new Map<string, typeof contracts>();
  for (const lot of lots) if (lot.project_id) { const group = lotsByProject.get(lot.project_id) ?? []; group.push(lot); lotsByProject.set(lot.project_id,group); }
  for (const contract of contracts) if (contract.project_id) { const group = contractsByProject.get(contract.project_id) ?? []; group.push(contract); contractsByProject.set(contract.project_id,group); }
  return new Map(projects.map(project => {
    const projectLots = lotsByProject.get(project.id) ?? []
    const projectContracts = contractsByProject.get(project.id) ?? []
    const dimensions: Record<string,string> = { organization_id: orgId }
    if (project.division_id) { dimensions.division_id = project.division_id; dimensions.division_name = divisionNames.get(project.division_id) ?? project.division_id }
    if (projectLots.length === 1) { dimensions.lot_id = projectLots[0].id; dimensions.community_id = projectLots[0].community_id; dimensions.lot_name = `Lot ${projectLots[0].lot_number}`; dimensions.community_name = communityNames.get(projectLots[0].community_id) ?? projectLots[0].community_id }
    if (projectContracts.length === 1) dimensions.contract_id = projectContracts[0].id
    return [project.id, dimensions]
  }))
}
