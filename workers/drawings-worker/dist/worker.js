"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const process_drawing_set_1 = require("./jobs/process-drawing-set");
const generate_drawing_tiles_1 = require("./jobs/generate-drawing-tiles");
class Worker {
    supabase;
    constructor() {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) {
            throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
        }
        this.supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    async processAvailableJobs(options = {}) {
        const batchSize = clampInt(options.batchSize ?? Number(process.env.DRAWINGS_WORKER_BATCH_SIZE ?? 5), 1, 100, 5);
        const maxBatches = clampInt(options.maxBatches ?? Number(process.env.DRAWINGS_WORKER_MAX_BATCHES ?? 20), 1, 500, 20);
        const startedAt = Date.now();
        const summary = {
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
                }
                else {
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
    async claimJobs(limit) {
        const { data, error } = await this.supabase.rpc('claim_jobs', {
            job_types: ['process_drawing_set', 'generate_drawing_tiles'],
            limit_value: limit
        });
        if (error) {
            throw new Error(`Failed to claim jobs: ${error.message}`);
        }
        return (data ?? []);
    }
    async processJob(job) {
        const startTime = Date.now();
        console.log(`🔄 Processing job ${job.job_id} (${job.job_type})`);
        try {
            switch (job.job_type) {
                case 'process_drawing_set':
                    await (0, process_drawing_set_1.processDrawingSet)(this.supabase, job);
                    break;
                case 'generate_drawing_tiles':
                    await (0, generate_drawing_tiles_1.generateDrawingTiles)(this.supabase, job);
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
        }
        catch (error) {
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
exports.Worker = Worker;
function clampInt(input, min, max, fallback) {
    if (!Number.isFinite(input))
        return fallback;
    const value = Math.floor(input);
    return Math.max(min, Math.min(max, value));
}
