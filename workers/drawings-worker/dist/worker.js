"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const process_drawing_set_1 = require("./jobs/process-drawing-set");
const generate_drawing_tiles_1 = require("./jobs/generate-drawing-tiles");
class Worker {
    supabase;
    isRunning = false;
    pollInterval = null;
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
    async start() {
        if (this.isRunning) {
            console.log('Worker is already running');
            return;
        }
        console.log('Starting worker loop...');
        this.isRunning = true;
        // Start polling immediately
        await this.pollAndProcess();
        // Continue polling every 5 seconds
        this.pollInterval = setInterval(async () => {
            try {
                await this.pollAndProcess();
            }
            catch (error) {
                console.error('Error in poll cycle:', error);
            }
        }, 5000);
    }
    async stop() {
        console.log('Stopping worker...');
        this.isRunning = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
    async pollAndProcess() {
        if (!this.isRunning)
            return;
        try {
            // Claim pending jobs (batch size 5 to avoid overwhelming)
            const jobs = await this.claimJobs(5);
            if (jobs.length === 0) {
                return; // No jobs to process
            }
            console.log(`📋 Processing ${jobs.length} jobs`);
            // Process jobs concurrently (but limit concurrency to avoid resource exhaustion)
            const promises = jobs.map(job => this.processJob(job));
            await Promise.allSettled(promises);
        }
        catch (error) {
            console.error('Error polling jobs:', error);
        }
    }
    async claimJobs(limit) {
        // Use the claim_jobs RPC function (we'll create this next)
        const { data, error } = await this.supabase.rpc('claim_jobs', {
            job_types: ['process_drawing_set', 'generate_drawing_tiles'],
            limit_value: limit
        });
        if (error) {
            throw new Error(`Failed to claim jobs: ${error.message}`);
        }
        return data || [];
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
        }
    }
}
exports.Worker = Worker;
