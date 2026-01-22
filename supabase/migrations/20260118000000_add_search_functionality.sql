-- Add search functionality and indexes
-- This migration creates full-text search indexes for better search performance

-- Create full-text search indexes for better search performance
-- Projects
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_search
ON projects USING gin(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(address, '') || ' ' || coalesce(description, '')));

-- Tasks
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_search
ON tasks USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')));

-- Files
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_search
ON files USING gin(to_tsvector('english', coalesce(file_name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(tags::text, '')));

-- Contacts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_search
ON contacts USING gin(to_tsvector('english', coalesce(full_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(role, '')));

-- Companies
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_search
ON companies USING gin(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(website, '')));

-- Invoices
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_search
ON invoices USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(invoice_number, '') || ' ' || coalesce(notes, '')));

-- Change Orders
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_change_orders_search
ON change_orders USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(reason, '') || ' ' || coalesce(summary, '')));

-- RFIs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rfis_search
ON rfis USING gin(to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(question, '') || ' ' || coalesce(drawing_reference, '') || ' ' || coalesce(spec_reference, '') || ' ' || coalesce(location, '')));

-- Submittals
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_submittals_search
ON submittals USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(spec_section, '')));

-- Conversations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_search
ON conversations USING gin(to_tsvector('english', coalesce(subject, '')));

-- Messages
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search
ON messages USING gin(to_tsvector('english', coalesce(body, '')));

-- Drawing Sets
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drawing_sets_search
ON drawing_sets USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')));

-- Daily Logs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_logs_search
ON daily_logs USING gin(to_tsvector('english', coalesce(summary, '')));

-- Punch Items
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_punch_items_search
ON punch_items USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(location, '')));

-- Schedule Items
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_schedule_items_search
ON schedule_items USING gin(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(phase, '') || ' ' || coalesce(trade, '') || ' ' || coalesce(location, '')));