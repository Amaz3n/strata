import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { processDrawingSet } from './jobs/process-drawing-set';
import { generateDrawingTiles } from './jobs/generate-drawing-tiles';

export interface Job {
  job_id: number | string;
  org_id: string;
  job_type: string;
  payload: Record<string, any>;
  retry_count: number;
  run_at: string;
}

export interface ProcessOptions {
  batchSize?: number;
  maxBatches?: number;
}

export interface ProcessSummary {
  batchSize: number;
  maxBatches: number;
  batches: number;
  claimed: number;
  processed: number;
  completed: number;
  failed: number;
  durationMs: number;
  stopReason: 'no_jobs' | 'queue_drained' | 'max_batches_reached';
}

export class Worker {
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  async processAvailableJobs(options: ProcessOptions = {}): Promise<ProcessSummary> {
    const batchSize = clampInt(
      options.batchSize ?? Number(process.env.DRAWINGS_WORKER_BATCH_SIZE ?? 5),
      1,
      100,
      5
    );
    const maxBatches = clampInt(
      options.maxBatches ?? Number(process.env.DRAWINGS_WORKER_MAX_BATCHES ?? 20),
      1,
      500,
      20
    );
    const startedAt = Date.now();

    const summary: ProcessSummary = {
      batchSize,
      maxBatches,
      batches: 0,
      claimed: 0,
      processed: 0,
      completed: 0,
      failed: 0,
      durationMs: 0,
      stopReason: 'no_jobs',
    };

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const jobs = await this.claimJobs(batchSize);
      if (jobs.length === 0) {
        summary.stopReason = summary.claimed === 0 ? 'no_jobs' : 'queue_drained';
        break;
      }

      summary.batches += 1;
      summary.claimed += jobs.length;
      console.log(`📋 Processing batch ${batch + 1}/${maxBatches} (${jobs.length} jobs)`);

      const results = await Promise.all(jobs.map((job) => this.processJob(job)));
      for (const ok of results) {
        summary.processed += 1;
        if (ok) {
          summary.completed += 1;
        } else {
          summary.failed += 1;
        }
      }
    }

    if (summary.stopReason === 'no_jobs' && summary.batches === maxBatches) {
      summary.stopReason = 'max_batches_reached';
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  private async claimJobs(limit: number): Promise<Job[]> {
    const { data, error } = await this.supabase.rpc('claim_jobs', {
      job_types: ['process_drawing_set', 'generate_drawing_tiles'],
      limit_value: limit
    });

    if (error) {
      throw new Error(`Failed to claim jobs: ${error.message}`);
    }

    return (data ?? []) as Job[];
  }

  private async processJob(job: Job): Promise<boolean> {
    const startTime = Date.now();
    console.log(`🔄 Processing job ${job.job_id} (${job.job_type})`);

    try {
      switch (job.job_type) {
        case 'process_drawing_set':
          await processDrawingSet(this.supabase, job);
          break;

        case 'generate_drawing_tiles':
          await generateDrawingTiles(this.supabase, job);
          break;

        default:
          throw new Error(`Unknown job type: ${job.job_type}`);
      }

      // Mark job as completed
      await this.supabase
        .from('outbox')
        .update({
          status: 'completed',
          last_error: null
        })
        .eq('id', job.job_id);

      const duration = Date.now() - startTime;
      console.log(`✅ Completed job ${job.job_id} in ${duration}ms`);
      return true;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`❌ Failed job ${job.job_id} after ${duration}ms:`, errorMessage);

      // Handle retry logic
      const newRetryCount = job.retry_count + 1;
      const shouldRetry = newRetryCount < 3; // Max 3 retries

      await this.supabase
        .from('outbox')
        .update({
          status: shouldRetry ? 'pending' : 'failed',
          retry_count: newRetryCount,
          last_error: errorMessage,
          run_at: shouldRetry
            ? new Date(Date.now() + Math.pow(2, newRetryCount) * 60000).toISOString() // Exponential backoff
            : job.run_at
        })
        .eq('id', job.job_id);
      return false;
    }
  }
}

function clampInt(input: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(input)) return fallback;
  const value = Math.floor(input);
  return Math.max(min, Math.min(max, value));
}
