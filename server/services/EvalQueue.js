/**
 * EvalQueue — Phase 3
 *
 * In-process async evaluation queue that decouples final interview
 * evaluation from the WebSocket handler.
 *
 * Design:
 *   - FIFO queue with configurable concurrency (default 2)
 *   - Each job is an async function that gets called with the job payload
 *   - Failed jobs are retried up to maxRetries with exponential backoff
 *   - Emits metrics for observability
 *
 * In a production multi-node cluster this would be replaced with
 * a Redis-backed queue (BullMQ / bee-queue). The interface is kept
 * identical so the swap is a one-line change in InterviewEngine.
 *
 * Trade-off (per LLD notes):
 *   In-process queue is safe for single-worker deployments. With
 *   Node cluster, each worker has its own queue — acceptable here
 *   because evaluation is stateless (reads from MongoDB) and there
 *   is no cross-worker deduplication issue; at worst a session is
 *   evaluated twice, which is idempotent.
 */

export default class EvalQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;

    this._queue = [];
    this._running = 0;

    this.metrics = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      currentDepth: 0,
    };
  }

  /**
   * Enqueue an evaluation job.
   *
   * @param {string} jobId   Unique job identifier (sessionId)
   * @param {Function} fn    Async function to execute: async () => void
   * @returns {Promise<void>} Resolves when the job completes (or fails permanently)
   */
  enqueue(jobId, fn) {
    return new Promise((resolve, reject) => {
      this.metrics.enqueued++;
      this.metrics.currentDepth++;

      this._queue.push({ jobId, fn, retries: 0, resolve, reject });
      this._drain();
    });
  }

  getMetrics() {
    return { ...this.metrics };
  }

  // --- Internal ---

  _drain() {
    while (this._running < this.concurrency && this._queue.length > 0) {
      const job = this._queue.shift();
      this._run(job);
    }
  }

  async _run(job) {
    this._running++;
    try {
      await job.fn();
      this._running--;
      this.metrics.completed++;
      this.metrics.currentDepth--;
      job.resolve();
    } catch (err) {
      this._running--;
      if (job.retries < this.maxRetries) {
        job.retries++;
        this.metrics.retried++;
        const delay = this.retryDelay * Math.pow(2, job.retries - 1);
        console.warn(
          `[EvalQueue] Job ${job.jobId} failed (attempt ${job.retries}/${this.maxRetries}), ` +
          `retrying in ${delay}ms. Error: ${err.message}`
        );
        setTimeout(() => {
          this._queue.unshift(job);
          this._drain();
        }, delay);
      } else {
        this.metrics.failed++;
        this.metrics.currentDepth--;
        console.error(`[EvalQueue] Job ${job.jobId} failed permanently after ${job.retries} retries:`, err.message);
        job.reject(err);
      }
    }
    this._drain();
  }
}
