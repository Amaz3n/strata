import { notFound, redirect } from "next/navigation"
import { getDrawingSetAction } from "../../actions"

interface DrawingSetRedirectPageProps {
  params: Promise<{ setId: string }>
}

export default async function DrawingSetRedirectPage({
  params,
}: DrawingSetRedirectPageProps) {
  const { setId } = await params
  const set = await getDrawingSetAction(setId)

  if (!set) {
    notFound()
  }

  redirect(`/projects/${set.project_id}/drawings?set=${set.id}`)
}
