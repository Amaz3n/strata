# Drawings Worker

A Cloud Run worker for processing PDF drawing sets into tiled images.

## Overview

This worker polls the Supabase `outbox` table for drawing-related jobs and processes them asynchronously, removing the need for heavy PDF processing in Next.js routes.

## Supported Job Types

### `process_drawing_set`
- Downloads a PDF from Supabase Storage
- Determines page count using MuPDF
- Creates `drawing_sheets` and `drawing_sheet_versions` records
- Queues `generate_drawing_tiles` jobs for each page

### `generate_drawing_tiles`
- Extracts a specific page from a PDF
- Renders it to a high-resolution PNG
- Generates thumbnail
- Uploads to content-addressed storage in `drawings-tiles` bucket
- Updates database with tile metadata

## Environment Variables

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run locally (requires .env file)
npm run dev
```

## Deployment

### Build and push to Artifact Registry

```bash
# Build the Docker image
docker build -t drawings-worker .

# Tag for Artifact Registry
docker tag drawings-worker gcr.io/YOUR_PROJECT/drawings-worker:latest

# Push to Artifact Registry
docker push gcr.io/YOUR_PROJECT/drawings-worker:latest
```

### Deploy to Cloud Run

```bash
gcloud run deploy drawings-worker \
  --image gcr.io/YOUR_PROJECT/drawings-worker:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars SUPABASE_URL=$SUPABASE_URL \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest \
  --min-instances 1 \
  --max-instances 5 \
  --cpu 2 \
  --memory 2Gi \
  --timeout 3600
```

## Architecture

- **PDF Rendering**: MuPDF (`mutool`) for reliable PDF processing
- **Image Processing**: Sharp for resizing and thumbnail generation
- **Storage**: Content-addressed paths for cacheable, immutable artifacts
- **Concurrency**: Processes jobs sequentially to avoid memory pressure
- **Idempotency**: Safe to retry jobs, detects existing outputs