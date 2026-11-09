// Preview startup must not import or initialize production voice/provider routes.
const runtime = await import(
  process.env.IS_PULL_REQUEST === "true"
    ? "./src/public-review-preview.mjs"
    : "./src/server.mjs"
);
export const createLocalServer = runtime.createLocalServer;
export const server = runtime.server;
export const startServer = runtime.startServer;
if (process.argv[1] === new URL(import.meta.url).pathname) startServer();
