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

function commitDateTime() {
  try {
    const iso = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { encoding: "utf8" }).trim();
    const date = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
    return part("year") + "-" + part("month") + "-" + part("day") + " " +
      part("hour") + ":" + part("minute") + " JST";
  } catch {
    return "dev";
  }
}

function stampQueryVersions(source, sha) {
  return source.replace(/\?v=(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})/gi, "?v=" + sha);
}

function stampBuildMeta(source, sha, dateTime) {
  return source
    .replaceAll("__COMMIT_SHA__", sha)
    .replaceAll("__COMMIT_DATETIME__", dateTime);
}

const sha = revision();
const dateTime = commitDateTime();
for (const path of ["web/index.html", "web/manifest.webmanifest"]) {
  const source = readFileSync(path, "utf8");
  writeFileSync(path, stampBuildMeta(stampQueryVersions(source, sha), sha, dateTime));
}

const swPath = "web/sw.js";
const sw = readFileSync(swPath, "utf8")
  .replace(/const REV = "(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})";/, 'const REV = "' + sha + '";')
  .replace(/\?v=(?:__COMMIT_SHA__|dev|[0-9a-f]{7,40})/gi, "?v=" + sha);
writeFileSync(swPath, sw);
console.log("Stamped deployment revision " + sha + " (" + dateTime + ")");
