import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function revision() {
  const fromEnv =
    process.env.WORKERS_CI_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

function stampQueryVersions(source, sha) {
  return source.replace(/\?v=(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})/gi, "?v=" + sha);
}

const sha = revision();
for (const path of ["web/index.html", "web/manifest.webmanifest"]) {
  writeFileSync(path, stampQueryVersions(readFileSync(path, "utf8"), sha));
}

const swPath = "web/sw.js";
const sw = readFileSync(swPath, "utf8")
  .replace(/const REV = "(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})";/, 'const REV = "' + sha + '";')
  .replace(/\?v=(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})/gi, "?v=" + sha);
writeFileSync(swPath, sw);
console.log("Stamped deployment revision " + sha);
