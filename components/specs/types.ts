export interface SpecRevisionView {
  id: string
  revision_number: number
  file_id: string
  file_url?: string | null
  file_name?: string | null
  page_start?: number | null
  page_end?: number | null
  issued_date?: string | null
  created_at: string
}

export interface LinkedSpecSubmittal {
  id: string
  submittal_number: number
  revision?: number | null
  title: string
  status: string
}

export interface SpecSectionView {
  id: string
  project_id: string
  division: string
  section_number: string
  title: string
  current_revision_id?: string | null
  revision_number?: number | null
  issued_date?: string | null
  file_id?: string | null
  revisions?: SpecRevisionView[]
  submittals?: LinkedSpecSubmittal[]
  submittal_count?: number
  created_at?: string
  updated_at?: string
}

export interface SpecUploadView {
  id: string
  file_id: string
  file_name?: string | null
  status: "pending" | "processing" | "complete" | "failed" | string
  sections_detected?: number | null
  error?: string | null
  created_at: string
  updated_at?: string
}

export interface SpecSectionOption {
  id: string
  section_number: string
  title: string
  division?: string
}
