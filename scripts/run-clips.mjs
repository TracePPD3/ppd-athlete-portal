// Clip test runner: runs saved clips through the same frame extraction and
// analysis the live portal uses, several times each, and prints the verdicts.
// Replaces eyeballing screenshots when changing a rubric or the sampling.
//
// Usage (from the repo root):
//   node --env-file=.env.local scripts/run-clips.mjs              # 3 runs per clip
//   node --env-file=.env.local scripts/run-clips.mjs --runs 5
//   node scripts/run-clips.mjs --dry                              # frames only, no API call
//   PPD_SAMPLE_FPS=6 PPD_MAX_FRAMES=24 node --env-file=.env.local scripts/run-clips.mjs
//
// Clips live in test-clips/ (videos are git-ignored). test-clips/expected.json
// says what each clip should come back as, for example:
//   { "yelich-good-swing.mov": { "sport": "hitting", "load": "pass", "unload": "pass" } }
// Pitching clips may also set "angle" ("open side" or "behind").

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { extractFrames, SAMPLE_FPS, MAX_FRAMES } from "../lib/frames.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clipsDir = path.join(root, "test-clips");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const runsFlag = args.indexOf("--runs");
const runs = runsFlag >= 0 ? Number(args[runsFlag + 1]) || 3 : 3;

// "LOAD — Flag" / "UNLOAD — Pass" style headings from the report.
function parseVerdicts(report) {
  const load = report.match(/(?<![A-Za-z])LOAD(?:\/BALANCE)?\s*[—–-]+\s*(Pass|Flag)/i);
  const unload = report.match(/(?:UNLOAD|SEPARATION)\s*[—–-]+\s*(Pass|Flag)/i);
  return {
    first: load ? load[1].toLowerCase() : "?",
    second: unload ? unload[1].toLowerCase() : "?",
  };
}

async function main() {
  let expected = {};
  try {
    expected = JSON.parse(await fs.readFile(path.join(clipsDir, "expected.json"), "utf8"));
  } catch {
    console.log("No test-clips/expected.json found; running every clip with no expected verdicts.\n");
  }

  const files = (await fs.readdir(clipsDir).catch(() => []))
    .filter((f) => /\.(mov|mp4|m4v|webm)$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.log(`No clips found in ${clipsDir}. Add .mov/.mp4 files there.`);
    process.exit(1);
  }

  // Imported lazily so --dry works without an API key.
  const { analyzeVideo, MODEL } = dry ? {} : await import("../lib/analyze.js");
  if (!dry && !process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set. Use --env-file=.env.local, or pass --dry.");
    process.exit(1);
  }

  console.log(`Sampling: ${SAMPLE_FPS} fps, max ${MAX_FRAMES} frames${dry ? "" : `, model ${MODEL}`}, ${dry ? "dry run" : `${runs} runs per clip`}\n`);

  let mismatches = 0;
  for (const file of files) {
    const want = expected[file] || {};
    const sport = want.sport || "hitting";
    const angle = want.angle || "open side";
    const frames = await extractFrames(path.join(clipsDir, file));
    const times = frames.map((f) => f.timeSeconds.toFixed(1)).join(" ");
    console.log(`${file}  [${sport}, ${angle}]  ${frames.length} frames at: ${times}`);
    if (dry) continue;

    const got = [];
    for (let i = 0; i < runs; i++) {
      try {
        const report = await analyzeVideo({ sport, angleSets: [{ angle, frames }] });
        const v = parseVerdicts(report);
        got.push(v);
        console.log(`  run ${i + 1}: ${sport === "hitting" ? "Load" : "Load/Balance"} ${v.first}, ${sport === "hitting" ? "Unload" : "Separation"} ${v.second}`);
      } catch (err) {
        got.push({ first: "error", second: "error" });
        console.log(`  run ${i + 1}: ERROR ${err.message}`);
      }
    }

    const stable = got.every((v) => v.first === got[0].first && v.second === got[0].second);
    console.log(`  stable across runs: ${stable ? "yes" : "NO (verdicts changed between runs)"}`);
    if (want.load || want.unload) {
      const ok = got.every(
        (v) => (!want.load || v.first === want.load) && (!want.unload || v.second === want.unload),
      );
      console.log(`  expected load=${want.load ?? "-"} unload=${want.unload ?? "-"}: ${ok ? "MATCH" : "MISMATCH"}`);
      if (!ok) mismatches++;
    }
    console.log("");
  }

  if (!dry) console.log(mismatches === 0 ? "All clips matched." : `${mismatches} clip(s) did not match expected verdicts.`);
  process.exit(mismatches === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
