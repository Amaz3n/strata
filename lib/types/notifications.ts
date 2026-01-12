export type NotificationType =
  | "task_assigned"
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "daily_log_created"
  | "schedule_item_created"
  | "schedule_item_updated"
  | "schedule_risk"
  | "rfi_created"
  | "rfi_response_added"
  | "rfi_decided"
  | "submittal_created"
  | "submittal_item_added"
  | "submittal_decided"
  | "change_order_created"
  | "change_order_published"
  | "invoice_created"
  | "invoice_updated"
  | "invoice_sent"
  | "payment_recorded"
  | "vendor_bill_submitted"
  | "selection_created"
  | "portal_message"
  | "file_created"
  | "file_archived"
  | "file_deleted"
  | "drawing_set_created"
  | "drawing_set_deleted"
  | "drawing_markup_created"
  | "drawing_pin_created"
  | "lien_waiver_created"
  | "lien_waiver_signed"
  | "team_member_invited"
  | "team_member_joined"
  | "compliance_item_created"
  | "compliance_item_due"
  | "compliance_item_overdue"
  | "punch_item_created"
  | "decision_created"
  | "decision_updated"
  | "warranty_item_created"
  | "warranty_item_due"
  | "warranty_item_expired"
  | "contact_created"
  | "contact_updated"
  | "company_created"
  | "company_updated"
  | "project_created"
  | "project_updated"
  | "project_completed"
  | "project_archived"
  | "estimate_created"
  | "estimate_updated"
  | "estimate_sent"
  | "proposal_created"
  | "proposal_updated"
  | "proposal_sent"
  | "contract_created"
  | "contract_signed"
  | "commitment_created"
  | "commitment_updated"

export interface NotificationRecord {
  id: string
  org_id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  payload: Record<string, any>
  is_read: boolean
  created_at: string
  updated_at: string
  project_id?: string
  entity_type?: string
  entity_id?: string
  event_id?: string
}

export interface NotificationInput {
  orgId: string
  userId: string
  type: NotificationType
  title: string
  message: string
  projectId?: string
  entityType?: string
  entityId?: string
  eventId?: string
}

