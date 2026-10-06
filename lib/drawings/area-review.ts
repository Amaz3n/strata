import { areasOverlap, type AreaProposal } from './area-takeoff'
/** Edited zones belong to the reviewer. A rerun may not overwrite or overlap them. */
export function reconcileAreaProposals(previous:AreaProposal[],incoming:AreaProposal[]) {
  const edited=previous.filter(p=>p.edited)
  let suppressed=0
  const fresh=incoming.filter(p=>{const conflict=edited.some(e=>areasOverlap(e,p));if(conflict)suppressed++;return !conflict})
  const used=new Set(edited.map(p=>p.id))
  return {proposals:[...edited,...fresh.map(p=>{let id=p.id;while(used.has(id))id+='-new';used.add(id);return {...p,id}})],suppressed,preserved:edited.length}
}
