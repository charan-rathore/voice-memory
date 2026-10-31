// Opt-in hook install. Sets core.hooksPath to .githooks for THIS clone
// only, and refuses to shadow an existing hooksPath or a pre-existing
// .git/hooks/pre-push the user may already rely on. Run: npm run hooks:install
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const current = (() => {
  try {
    return execSync("git config core.hooksPath", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
if (current === ".githooks") {
  console.log("pre-push hook already installed (.githooks/pre-push)");
  process.exit(0);
}
if (current) {
  console.error(
    `core.hooksPath is already "${current}" - not changing it. To use this repo's pre-push gate, chain .githooks/pre-push from your existing hook or unset the config first.`,
  );
  process.exit(1);
}
if (existsSync(".git/hooks/pre-push")) {
  console.error(
    ".git/hooks/pre-push already exists - not overwriting it. Chain .githooks/pre-push from it or remove it first.",
  );
  process.exit(1);
}
execSync("git config core.hooksPath .githooks");
console.log("pre-push hook installed (.githooks/pre-push) for this clone");
