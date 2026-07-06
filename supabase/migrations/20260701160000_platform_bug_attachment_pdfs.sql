update storage.buckets
set allowed_mime_types = array['image/*', 'application/pdf']::text[],
    file_size_limit = 10485760,
    public = false
where id = 'platform-bug-attachments';
