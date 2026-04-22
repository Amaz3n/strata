import { notFound, redirect } from "next/navigation"
import { getDrawingSheetAction } from "../../actions"

interface DrawingSheetRedirectPageProps {
  params: Promise<{ sheetId: string }>
}

export default async function DrawingSheetRedirectPage({
  params,
}: DrawingSheetRedirectPageProps) {
  const { sheetId } = await params
  const sheet = await getDrawingSheetAction(sheetId)

  if (!sheet) {
    notFound()
  }

  redirect(
    `/projects/${sheet.project_id}/drawings?set=${sheet.drawing_set_id}&sheetId=${sheet.id}`,
  )
}
