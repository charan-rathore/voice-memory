import { createHash } from "node:crypto";
// Shared by worker parse results, text imports and the in-process parse cache.
export const PIPELINE_VERSION = "vm-ingest/source-lines-1";
export function parseCacheKey(bytes, filename, version = PIPELINE_VERSION) {
  const extension =
    /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1].toLowerCase() ?? "";
  return (
    version +
    ":" +
    extension +
    ":" +
    createHash("sha256").update(bytes).digest("hex")
  );
}
