// POST /api/swing-analyzer/analyze
//
// Routing layer for the swing analyzer. Wires the upload -> frames -> Claude
// pipeline together; owns nothing else. The video and Claude logic live in
// @/lib and are reused unchanged from the original app.

import { NextResponse } from "next/server";
import { writeFile, rm, mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { extractFrames } from "@/lib/frames";
import { analyzeSwing } from "@/lib/analyze";

// FFmpeg + child_process + fs require the Node.js runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB — short swing clips only

export async function POST(request) {
  let uploadDir;
  try {
    const form = await request.formData();
    const file = form.get("video");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No video was uploaded." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "That video is too large. Please keep clips under 30 MB." },
        { status: 400 },
      );
    }
    if (file.type && !file.type.startsWith("video/")) {
      return NextResponse.json({ error: "Please upload a video file." }, { status: 400 });
    }

    // Write the upload to a temp file so FFmpeg can read it by path.
    const buf = Buffer.from(await file.arrayBuffer());
    uploadDir = await mkdtemp(path.join(os.tmpdir(), "ppd-upload-"));
    const videoPath = path.join(uploadDir, "video");
    await writeFile(videoPath, buf);

    const frames = await extractFrames(videoPath);
    const report = await analyzeSwing(frames);

    return NextResponse.json({ report, frameCount: frames.length });
  } catch (err) {
    console.error("Analysis failed:", err);
    return NextResponse.json(
      { error: err?.message || "Something went wrong analyzing the swing." },
      { status: 500 },
    );
  } finally {
    // Always delete the uploaded video — nothing is kept.
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  }
}
