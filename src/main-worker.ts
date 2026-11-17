import { composeWorker } from "./composition/worker-composition.js";
import { loadWorkerConfig } from "./config/config.js";

const worker = composeWorker(loadWorkerConfig(process.env));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await worker.shutdown();
    process.exit(0);
  } catch (error) {
    console.error("worker shutdown failed", error);
    process.exit(1);
  }
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

worker.start();
