"use client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useLayoutEffect, useMemo, useRef, useState, useTransition } from "react"
import { previewAgreementPacketAction, refreshPurchaseAgreementPacketAction, resumePurchaseAgreementSigningAction } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import type { AgreementPacket, ResolvedAgreementPacket } from "@/lib/sales/agreement-packet"
import type { AgreementSigningState } from "@/lib/sales/agreement-signing-state"

export function AgreementSigningRecovery({contractId,projectId,state}:{contractId:string;projectId:string;state:AgreementSigningState}) {
  const router=useRouter(),{toast}=useToast(),[pending,startTransition]=useTransition()
  const [review,setReview]=useState<{packet:ResolvedAgreementPacket;current:AgreementPacket|null;optional:string[]}|null>(null)
  const view=useMemo(()=>({contractId,projectId,stage:state.stage,canResume:state.canResume}),[contractId,projectId,state.stage,state.canResume]),committed=useRef<typeof view|null>(null),submitting=useRef<typeof view|null>(null)
  useLayoutEffect(()=>{committed.current=view;return()=>{if(committed.current===view)committed.current=null}},[view])
  const resume=()=>{
    if(!state.canResume || committed.current!==view || submitting.current===view)return
    submitting.current=view
    startTransition(async()=>{
      try {
        const result=unwrapAction(await resumePurchaseAgreementSigningAction({contractId,projectId}))
        if(committed.current!==view)return
        toast({title:result.documentId && result.envelopeId ? "Signing packet prepared" : "Signing remains unprepared",description:result.reason??"Reload the signing record to review its delivery status."})
      }catch(error){
        if(committed.current===view){toast({title:"Could not resume signing",description:(error as Error).message});router.refresh()}
      }finally{if(submitting.current===view)submitting.current=null}
    })
  }
  /** The packet the home resolves to now, keeping the optional addenda the buyer was offered when they still apply. */
  const reviewPacket=()=>{
    startTransition(async()=>{
      try {
        const first=await previewAgreementPacketAction({contractId})
        const current=unwrapAction(first).current
        const optional=(current?.documents??[]).filter(document=>!document.required).map(document=>document.template_id)
        const kept=optional.length?await previewAgreementPacketAction({contractId,optionalAddendumTemplateIds:optional}):first
        const resolved=kept.success?{data:kept.data,optional}:{data:unwrapAction(first),optional:[]}
        if(committed.current===view)setReview({packet:resolved.data.packet,current,optional:resolved.optional})
      }catch(error){
        if(committed.current===view)toast({title:"Could not load the agreement documents",description:(error as Error).message})
      }
    })
  }
  const refresh=()=>{
    if(!review || committed.current!==view || submitting.current===view)return
    submitting.current=view
    startTransition(async()=>{
      try {
        const result=unwrapAction(await refreshPurchaseAgreementPacketAction({contractId,optionalAddendumTemplateIds:review.optional,expectedPacketHash:review.packet.hash}))
        if(committed.current!==view)return
        toast({title:"Agreement documents refreshed",description:result.signing.reason??"The signing packet is prepared."})
        setReview(null)
        router.refresh()
      }catch(error){
        if(committed.current===view){toast({title:"Could not refresh the documents",description:(error as Error).message});setReview(null)}
      }finally{if(submitting.current===view)submitting.current=null}
    })
  }
  const previousVersions=new Map((review?.current?.documents??[]).map(document=>[document.template_id,document.version_number]))
  return <div className="border-b px-5 py-3" aria-live="polite">
    <p className="text-sm font-medium">{state.title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{state.detail}</p>
    {review ? <div className="mt-3 max-w-xl">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Documents after refresh</p>
      <ul className="mt-1 divide-y border-y">
        {review.packet.documents.map(document=>{
          const before=previousVersions.get(document.template_id)
          return <li key={document.template_id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <span className="min-w-0 truncate font-medium">{document.title}</span>
            <span className={before===document.version_number?"shrink-0 text-muted-foreground tabular-nums":"shrink-0 text-warning tabular-nums"}>
              {before===undefined?"Added":before===document.version_number?`v${document.version_number}`:`v${before} → v${document.version_number}`}
            </span>
          </li>
        })}
      </ul>
    </div> : null}
    <div className="mt-2 flex flex-wrap gap-2">
      {state.stage==="packet_stale" && state.canResume ? (review
        ? <><Button size="sm" disabled={pending} onClick={refresh}>{pending?"Refreshing…":"Refresh and prepare signing"}</Button><Button size="sm" variant="ghost" disabled={pending} onClick={()=>setReview(null)}>Cancel</Button></>
        : <Button size="sm" variant="outline" disabled={pending} onClick={reviewPacket}>{pending?"Loading…":"Review the refreshed documents"}</Button>)
        : state.canResume?<Button size="sm" variant="outline" disabled={pending} onClick={resume}>{pending?"Resuming…":"Resume signing preparation"}</Button>:null}
      {state.documentId?<Button size="sm" variant="ghost" asChild><Link href={`/projects/${projectId}/documents`}>Review signing document</Link></Button>:null}
    </div>
  </div>
}
