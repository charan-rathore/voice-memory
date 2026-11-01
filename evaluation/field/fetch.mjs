// Downloads the public sample reports named in questions.json into
// evaluation/field/files (git-ignored). Sources are pinned by repository
// path; nothing here is committed to this repository.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const Q = JSON.parse(
  readFileSync(new URL("./questions.json", import.meta.url), "utf8"),
);
const out = new URL("./files/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [file, src] of Object.entries(Q.sources)) {
  const dest = new URL(file, out);
  if (existsSync(dest)) continue;
  const [repo, path] = src.split(":");
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`fail ${file}: ${r.status}`);
    continue;
  }
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`ok   ${file}`);
}
