// Clip test runner: runs saved clips through the same frame extraction and
// analysis the live portal uses, several times each, and prints the verdicts.
// Replaces eyeballing screenshots when changing a rubric or the sampling.
//
// Usage (from the repo root):
//   node --env-file=.env.local scripts/run-clips.mjs              # 3 runs per clip
//   node --env-file=.env.local scripts/run-clips.mjs --runs 5
//   node scripts/run-clips.mjs --dry                              # frames only, no API call
//   node --env-file=.env.local scripts/run-clips.mjs --find-only  # swing finder only (cheap)
//   PPD_SAMPLE_FPS=6 PPD_MAX_FRAMES=24 node --env-file=.env.local scripts/run-clips.mjs
//
// Clips live in test-clips/ (videos are git-ignored). test-clips/expected.json
// says what each clip should come back as, for example:
//   { "yelich-good-swing.mov": { "sport": "hitting", "load": "pass", "unload": "pass" } }
// Pitching clips may also set "angle" ("open side" or "behind").
// Slow-motion replays set "speed": "slow". They still run, but are reported
// separately and do not count toward the pass/fail result: only normal-speed
// clips look like what players actually upload.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { extractFrames, extractThumbnails, SAMPLE_FPS, MAX_FRAMES } from "../lib/frames.js";

// US dollars per million tokens (Anthropic list prices), for the cost lines.
// Output includes the model's thinking tokens.
const PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

function dollars(model, usage) {
  const price = PRICES[model];
  if (!price) return null;
  return ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output) / 1e6;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clipsDir = path.join(root, "test-clips");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const findOnly = args.includes("--find-only");
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
  const { analyzeVideo, MODEL } = dry || findOnly ? {} : await import("../lib/analyze.js");
  const { findContactTime, FINDER_MODEL } = dry ? {} : await import("../lib/swing-finder.js");
  if (!dry && !process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set. Use --env-file=.env.local, or pass --dry.");
    process.exit(1);
  }

  // Each test run saves its reports in its own dated folder, so runs can be
  // compared before and after a change instead of overwriting each other.
  const reportsDir = path.join(clipsDir, "reports", new Date().toISOString().replace(/:/g, "-").slice(0, 19));
  if (!dry && !findOnly) console.log(`Reports: ${path.relative(root, reportsDir)}`);

  const mode = dry ? "dry run (no swing finder, even sampling)" : findOnly ? `swing finder only, model ${FINDER_MODEL}` : `model ${MODEL}, swing finder ${FINDER_MODEL}, ${runs} runs per clip`;
  console.log(`Sampling: ${SAMPLE_FPS} fps, max ${MAX_FRAMES} frames, ${mode}\n`);

  const results = []; // { file, speed, ok } for clips that have expected verdicts
  for (const file of files) {
    const want = expected[file] || {};
    const sport = want.sport || "hitting";
    const angle = want.angle || "open side";
    const speed = want.speed === "slow" ? "slow" : "normal";
    // Same sampling as the live route: hitting finds contact first, then
    // samples the swing densely (even sampling if contact isn't found).
    const clipPath = path.join(clipsDir, file);
    let contactTime = null;
    let finderCost = 0;
    if (sport === "hitting" && !dry) {
      const finderUsage = [];
      contactTime = await findContactTime(await extractThumbnails(clipPath), {
        onUsage: (u) => finderUsage.push(u),
      });
      finderCost = finderUsage.reduce((s, u) => s + (dollars(FINDER_MODEL, u) ?? 0), 0);
      const tokens = finderUsage.map((u) => `${u.input_tokens} in, ${u.output_tokens} out`).join("; ");
      console.log(`${file}  swing finder: ${contactTime == null ? "no contact found, even sampling" : `contact at ${contactTime.toFixed(2)}s`}  (${tokens || "no API call"}, $${finderCost.toFixed(4)})`);
    }
    const frames = await extractFrames(clipPath, { contactTime });
    const times = frames.map((f) => f.timeSeconds.toFixed(1)).join(" ");
    console.log(`${file}  [${sport}, ${angle}${speed === "slow" ? ", SLOW-MOTION" : ""}]  ${frames.length} frames at: ${times}`);
    if (dry || findOnly) continue;

    const got = [];
    const usages = [];
    await fs.mkdir(reportsDir, { recursive: true });
    for (let i = 0; i < runs; i++) {
      try {
        const report = await analyzeVideo({
          sport,
          angleSets: [{ angle, frames }],
          onUsage: (u) => usages.push(u),
        });
        const v = parseVerdicts(report);
        await fs.writeFile(path.join(reportsDir, `${file}.run${i + 1}.md`), report);
        got.push(v);
        console.log(`  run ${i + 1}: ${sport === "hitting" ? "Load" : "Load/Balance"} ${v.first}, ${sport === "hitting" ? "Unload" : "Separation"} ${v.second}`);
      } catch (err) {
        got.push({ first: "error", second: "error" });
        console.log(`  run ${i + 1}: ERROR ${err.message}`);
      }
    }

    // Cost per upload = one swing-finder call + one analysis call.
    if (usages.length > 0) {
      const avg = (key) => usages.reduce((s, u) => s + (u[key] || 0), 0) / usages.length;
      const input = avg("input_tokens");
      const output = avg("output_tokens");
      const analysis = dollars(MODEL, { input_tokens: input, output_tokens: output });
      const cost = analysis == null
        ? " (no price on file for this model)"
        : `; per upload about $${(analysis + finderCost).toFixed(3)} (analysis $${analysis.toFixed(3)} + finder $${finderCost.toFixed(4)})`;
      console.log(`  analysis tokens per run (avg of ${usages.length}): ${Math.round(input)} in, ${Math.round(output)} out${cost}`);
    }

    const stable = got.every((v) => v.first === got[0].first && v.second === got[0].second);
    console.log(`  stable across runs: ${stable ? "yes" : "NO (verdicts changed between runs)"}`);
    if (want.load || want.unload) {
      // A run that errored is not a wrong call: track it separately so a crash
      // isn't mistaken for the rubric or the sampling getting it wrong.
      const answered = got.filter((v) => v.first !== "error");
      const wrong = answered.some(
        (v) => (want.load && v.first !== want.load) || (want.unload && v.second !== want.unload),
      );
      const errored = answered.length < got.length;
      const status = wrong ? "MISMATCH" : errored ? "ERROR" : "MATCH";
      console.log(`  expected load=${want.load ?? "-"} unload=${want.unload ?? "-"}: ${status}${status === "ERROR" ? ` (answered runs all correct; ${got.length - answered.length} run(s) errored)` : ""}`);
      results.push({ file, speed, ok: status === "MATCH", wrong });
    }
    console.log("");
  }

  if (dry || findOnly) process.exit(0);

  const normal = results.filter((r) => r.speed === "normal");
  const slow = results.filter((r) => r.speed === "slow");
  const summarize = (label, group) => {
    const failed = group.filter((r) => !r.ok);
    console.log(`${label}: ${group.length - failed.length} of ${group.length} matched`);
    for (const r of failed) console.log(`  ${r.wrong ? "MISMATCH" : "ERROR   "} ${r.file}`);
    return failed.length;
  };
  const normalWrong = normal.some((r) => r.wrong);
  const normalFailed = summarize("Normal-speed clips (count toward ready to merge)", normal);
  const slowFailed = summarize("Slow-motion clips (reported only, do not count)", slow);
  console.log("");
  if (normal.length === 0) {
    console.log("No normal-speed clips with expected verdicts: NOT ready to merge.");
  } else {
    console.log(normalFailed === 0 ? "All normal-speed clips matched." : "Normal-speed clips did not all match: NOT ready to merge.");
  }
  if (slow.length > 0 && slowFailed === 0 && normalWrong) {
    console.log(
      "NOTE: slow-motion clips all matched but normal-speed clips did not. The swing is likely" +
        " getting too few frames at normal speed; find the swing in the video and sample it densely in lib/frames.js.",
    );
  }
  process.exit(normal.length > 0 && normalFailed === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
