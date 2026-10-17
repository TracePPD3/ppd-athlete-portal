// POST /api/swing-analyzer/analyze
//
// Routing layer for the analyzer. Wires the upload -> frames -> Claude
// pipeline together; owns nothing else. The video and Claude logic live in
// @/lib.
//
// Form fields:
//   sport   "hitting" (default) or "pitching"
//   video   the first clip (required)
//   angle   "open" or "behind" (pitching; hitting is always open side)
//   video2  optional second clip (pitching only)
//   angle2  the angle of the second clip

import { NextResponse } from "next/server";
import { writeFile, rm, mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { openClip } from "@/lib/frames";
import { findContactTime } from "@/lib/swing-finder";
import { analyzeVideo } from "@/lib/analyze";

// FFmpeg + child_process + fs require the Node.js runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB per clip
const SPORTS = ["hitting", "pitching"];

// Anything mentioning "behind" is the behind view; everything else is open side.
function normalizeAngle(value) {
  return String(value || "").toLowerCase().includes("behind")
    ? "behind"
    : "open side";
}

// Returns an error message if the upload is unusable, otherwise null.
function checkClip(file) {
  if (!file || typeof file === "string") return "No video was uploaded.";
  if (file.size > MAX_UPLOAD_BYTES) {
    return "That video is too large. Please keep clips under 30 MB.";
  }
  if (file.type && !file.type.startsWith("video/")) {
    return "Please upload a video file.";
  }
  return null;
}

function fail(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
  let uploadDir;
  try {
    const form = await request.formData();

    const sport = String(form.get("sport") || "hitting").toLowerCase();
    if (!SPORTS.includes(sport)) return fail("Unknown analysis mode.");

    const file1 = form.get("video");
    const problem1 = checkClip(file1);
    if (problem1) return fail(problem1);

    // The second clip is optional. An empty file input counts as "not sent".
    const rawFile2 = form.get("video2");
    const hasSecond =
      rawFile2 && typeof rawFile2 !== "string" && rawFile2.size > 0;

    const clips = [
      { file: file1, angle: sport === "hitting" ? "open side" : normalizeAngle(form.get("angle")) },
    ];

    if (hasSecond) {
      if (sport === "hitting") return fail("Hitting takes a single clip.");
      const problem2 = checkClip(rawFile2);
      if (problem2) return fail(problem2);
      clips.push({ file: rawFile2, angle: normalizeAngle(form.get("angle2")) });
      if (clips[0].angle === clips[1].angle) {
        return fail("Please choose two different angles (open side and behind).");
      }
    }

    // Seconds spent in each step, summed across clips, to see where upload
    // time goes on the server. Logged and returned; the page doesn't show it.
    const timings = { saveUpload: 0, decode: 0, finder: 0, frames: 0, analysis: 0 };
    const startedAt = performance.now();
    let stepStart = startedAt;
    const endStep = (name) => {
      const now = performance.now();
      timings[name] += (now - stepStart) / 1000;
      stepStart = now;
    };

    // Write each upload to a temp file so FFmpeg can read it by path.
    uploadDir = await mkdtemp(path.join(os.tmpdir(), "ppd-upload-"));
    const angleSets = [];
    for (let i = 0; i < clips.length; i++) {
      const buf = Buffer.from(await clips[i].file.arrayBuffer());
      const videoPath = path.join(uploadDir, `video${i + 1}`);
      await writeFile(videoPath, buf);
      endStep("saveUpload");
      // Hitting: find contact first, then sample the swing densely so foot
      // plant isn't missed between frames. If contact isn't found, this falls
      // back to even sampling. Pitching keeps the even sampling it was tuned on.
      // One decode makes the overview frames and the finder's thumbnails
      // ("decode" timing); "frames" is the dense swing window plus selection.
      const clip = await openClip(videoPath, { thumbnails: sport === "hitting" });
      try {
        endStep("decode");
        let contactTime = null;
        if (sport === "hitting") {
          contactTime = await findContactTime(clip.thumbnails);
          endStep("finder");
          console.log(`Swing finder: ${contactTime == null ? "no contact found, even sampling" : `contact at ${contactTime.toFixed(2)}s`}`);
        }
        const frames = await clip.frames({ contactTime });
        endStep("frames");
        angleSets.push({ angle: clips[i].angle, frames, contactTime });
      } finally {
        await clip.close();
      }
    }

    const report = await analyzeVideo({ sport, angleSets });
    endStep("analysis");
    const frameCount = angleSets.reduce((sum, set) => sum + set.frames.length, 0);
    for (const name of Object.keys(timings)) timings[name] = Number(timings[name].toFixed(1));
    timings.total = Number(((performance.now() - startedAt) / 1000).toFixed(1));
    console.log(`Analyze timings (s): ${JSON.stringify(timings)}`);

    // contactTime (hitting only; null = finder fell back to even sampling) is
    // for checking the swing finder; the page doesn't display it.
    return NextResponse.json({
      report,
      frameCount,
      clipCount: angleSets.length,
      contactTime: angleSets[0].contactTime ?? null,
      timings,
    });
  } catch (err) {
    console.error("Analysis failed:", err);
    return NextResponse.json(
      { error: err?.message || "Something went wrong analyzing the video." },
      { status: 500 },
    );
  } finally {
    // Always delete the uploaded videos — nothing is kept.
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  }
}
