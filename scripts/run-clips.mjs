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

// The report does not use one fixed heading format: the rubric only asks for a
// pass (check mark) or a flag (wrench), so a heading may read "LOAD — Pass",
// "LOAD ✅", or "**Load: Flag 🔧**". Find each checkpoint heading, then read
// the verdict from the first stretch of text after it.
function verdictNear(text) {
  const head = text.slice(0, 160);
  const mark = head.search(/✅|🔧|\bpass\b|\bflag\b/i);
  if (mark < 0) return "?";
  const hit = head.slice(mark).match(/✅|🔧|pass|flag/i)[0].toLowerCase();
  return hit === "✅" || hit === "pass" ? "pass" : "flag";
}

// Checkpoint headings are lines such as "## 1. LOAD — ✅ Pass" or
// "**UNLOAD** 🔧". Prefer those heading lines, because the words "load" and
// "unload" also appear inside the body text ("nothing stored to unload").
function findVerdict(report, isFirst) {
  const name = isFirst
    ? /(?<![A-Za-z])LOAD(?:\s*\/\s*BALANCE)?(?![A-Za-z])/i
    : /(?<![A-Za-z])(?:UNLOAD|SEPARATION)(?![A-Za-z])/i;
  const lines = report.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s*(#|\*\*|\d+\.)/.test(line) || /✅|🔧/.test(line);
    if (!isHeading || !name.test(line)) continue;
    if (isFirst && /UNLOAD/i.test(line) && !/(?<![A-Za-z])LOAD(?![A-Za-z])/i.test(line.replace(/UNLOAD/gi, ""))) continue;
    const v = verdictNear(line + " " + (lines[i + 1] || ""));
    if (v !== "?") return v;
  }
  const at = report.search(name);
  return at >= 0 ? verdictNear(report.slice(at, at + 160)) : "?";
}

function parseVerdicts(report) {
  return { first: findVerdict(report, true), second: findVerdict(report, false) };
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
    await fs.mkdir(path.join(clipsDir, "reports"), { recursive: true });
    for (let i = 0; i < runs; i++) {
      try {
        const report = await analyzeVideo({ sport, angleSets: [{ angle, frames }] });
        const v = parseVerdicts(report);
        await fs.writeFile(path.join(clipsDir, "reports", `${file}.run${i + 1}.md`), report);
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
