import type { JobRequest, JobResult } from './worker';

type Pending = { job: JobRequest; resolve: (r: JobResult) => void };

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Pending[] = [];
  private busy = new Map<Worker, (r: JobResult) => void>();

  constructor(size = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<JobResult>) => {
        const resolve = this.busy.get(worker);
        this.busy.delete(worker);
        this.idle.push(worker);
        resolve?.(event.data);
        this.pump();
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(job: JobRequest): Promise<JobResult> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.pop() as Worker;
      const next = this.queue.shift() as Pending;
      this.busy.set(worker, next.resolve);
      worker.postMessage(next.job);
    }
  }
}
