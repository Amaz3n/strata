# Drawings Worker

A Cloud Run worker for processing PDF drawing sets into tiled images.

## Overview

This worker processes drawing jobs on demand. The app enqueues jobs in Supabase `outbox` and then calls the worker's `/process` endpoint to run batches immediately.

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
DRAWINGS_WORKER_SECRET=shared-secret-used-by-app-and-worker
DRAWINGS_WORKER_PROCESS_PATH=/process
DRAWINGS_WORKER_BATCH_SIZE=5
DRAWINGS_WORKER_MAX_BATCHES=20

# R2 (required when DRAWINGS_TILES_STORAGE=r2)
DRAWINGS_TILES_STORAGE=r2
DRAWINGS_TILES_BASE_URL=https://cdn.arcnaples.com/drawings-tiles
R2_BUCKET=project-files
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_REGION=auto
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_FORCE_PATH_STYLE=true
```

App-side environment variables (Next.js server):

```bash
DRAWINGS_WORKER_URL=https://drawings-worker-<hash>-uc.a.run.app
DRAWINGS_WORKER_SECRET=shared-secret-used-by-app-and-worker
DRAWINGS_WORKER_PROCESS_PATH=/process
DRAWINGS_WORKER_TIMEOUT_MS=4000
DRAWINGS_WORKER_BATCH_SIZE=5
DRAWINGS_WORKER_MAX_BATCHES=20
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
  --set-env-vars DRAWINGS_WORKER_SECRET=$DRAWINGS_WORKER_SECRET \
  --min-instances 0 \
  --max-instances 5 \
  --cpu 2 \
  --memory 2Gi \
  --cpu-throttling \
  --timeout 3600
```

## Endpoints

- `GET /health` - Health check.
- `POST /process` - Claims and processes queued drawing jobs.
  - Requires `Authorization: Bearer $DRAWINGS_WORKER_SECRET` in production.
  - Optional JSON body:
    - `batchSize` (number)
    - `maxBatches` (number)

## Architecture

- **PDF Rendering**: MuPDF (`mutool`) for reliable PDF processing
- **Image Processing**: Sharp for resizing and thumbnail generation
- **Storage**: Content-addressed paths for cacheable, immutable artifacts
- **Concurrency**: Processes jobs sequentially to avoid memory pressure
- **Idempotency**: Safe to retry jobs, detects existing outputs
