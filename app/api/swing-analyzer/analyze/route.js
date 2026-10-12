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
import { extractFrames } from "@/lib/frames";
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

    // Write each upload to a temp file so FFmpeg can read it by path.
    uploadDir = await mkdtemp(path.join(os.tmpdir(), "ppd-upload-"));
    const angleSets = [];
    for (let i = 0; i < clips.length; i++) {
      const buf = Buffer.from(await clips[i].file.arrayBuffer());
      const videoPath = path.join(uploadDir, `video${i + 1}`);
      await writeFile(videoPath, buf);
      const frames = await extractFrames(videoPath);
      angleSets.push({ angle: clips[i].angle, frames });
    }

    const report = await analyzeVideo({ sport, angleSets });
    const frameCount = angleSets.reduce((sum, set) => sum + set.frames.length, 0);

    return NextResponse.json({ report, frameCount, clipCount: angleSets.length });
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
