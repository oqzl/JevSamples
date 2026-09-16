import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function revision() {
  const fromEnv =
    process.env.WORKERS_CI_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "dev";
  }
}

const sha = revision();
const targets = ["web/index.html", "web/sw.js", "web/manifest.webmanifest"];
for (const path of targets) {
  const source = readFileSync(path, "utf8");
  writeFileSync(path, source.replaceAll("__COMMIT_SHA__", sha));
}
console.log("Stamped deployment revision " + sha);
