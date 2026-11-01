// Stable deployment entry point. Runtime implementation lives in src/.
import { startServer } from "./src/server.mjs";
export { createLocalServer, server, startServer } from "./src/server.mjs";
if (process.argv[1] === new URL(import.meta.url).pathname) startServer();
