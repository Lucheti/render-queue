import { composeApi } from "./composition/api-composition.js";
import { loadApiConfig } from "./config/config.js";

const config = loadApiConfig(process.env);
const api = await composeApi(config);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  api.server.log.info({ signal }, "shutting down");
  try {
    await api.shutdown();
    process.exit(0);
  } catch (error) {
    api.server.log.error({ error }, "shutdown failed");
    process.exit(1);
  }
};
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

await api.server.listen({ host: config.host, port: config.port });
