-- RECOVERED FROM PRODUCTION 2026-09-02.
-- Forwarding is derived at read time by numbering confirmed-human sessions,
-- so a stored flag would only drift as bot verdicts are resolved.

alter table outreach.sessions drop column if exists is_forward;
