import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import process from 'node:process';

// Get number of CPU cores, fallback to 1 if unknown
const numCPUs = availableParallelism ? availableParallelism() : 1;

if (cluster.isPrimary) {
  console.log(`[Cluster] Primary ${process.pid} is running`);
  console.log(`[Cluster] Forking ${numCPUs} application workers...`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // If a worker dies, restart it automatically for high availability
  cluster.on('exit', (worker, code, signal) => {
    console.log(`[Cluster] Worker ${worker.process.pid} died with code: ${code}, and signal: ${signal}`);
    console.log('[Cluster] Starting a new worker...');
    cluster.fork();
  });
} else {
  // Workers handle the actual application logic
  // Dynamic import ensures app logic only loads in worker processes
  import('./app.js').then((app) => {
    app.startWorker();
  }).catch((err) => {
    console.error(`[Worker ${process.pid}] Failed to start:`, err);
    process.exit(1);
  });
}
