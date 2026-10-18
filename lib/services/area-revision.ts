import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadMeasurementContext } from './drawing-measurements'
import { downloadTilesObject } from '@/lib/storage/drawings-tiles-storage'
import { AREA_EVIDENCE_FILE, AREA_EVIDENCE_VERSION } from '@/lib/drawings/area-evidence'
import { parseTextRuns, TEXT_RUNS_FILE } from '@/lib/drawings/text-runs'
import type { RevisionAreaSource } from '@/lib/drawings/area-revision'
/** Missing legacy/scan artifacts remain unavailable, never presumed unchanged. */
export async function loadAreaRevisionSource(supabase:SupabaseClient,orgId:string,versionId:string):Promise<RevisionAreaSource|null>{
  try {
    const [{data:version,error},measurement]=await Promise.all([
      supabase.from('drawing_sheet_versions').select('tiles_base_path').eq('org_id',orgId).eq('id',versionId).maybeSingle(),
      loadMeasurementContext(supabase,orgId,versionId),
    ])
    if(error||!version?.tiles_base_path||!measurement.imageSize||!measurement.feetPerImagePx)return null
    const [raw,text]=await Promise.all([AREA_EVIDENCE_FILE,TEXT_RUNS_FILE].map(file=>downloadTilesObject({supabase,path:`${version.tiles_base_path}/${file}`})))
    const evidence=JSON.parse(raw.toString('utf8'))
    if(evidence.version!==AREA_EVIDENCE_VERSION||!Array.isArray(evidence.paths))return null
    return {evidence,textRuns:parseTextRuns(text.toString('utf8')),width:measurement.imageSize.width,height:measurement.imageSize.height,scale:measurement.feetPerImagePx}
  }catch{return null}
}
