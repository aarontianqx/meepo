import { WorkerClient } from './client.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const client = new WorkerClient(config);

client.start();
console.log(`meepo-worker ${config.workerId} connecting to ${config.serverUrl} ...`);
