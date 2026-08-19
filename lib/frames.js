// Frame extraction from an uploaded swing video.
//
// Responsibility boundary: this module knows about FFmpeg and the local
// filesystem. It does NOT know about Claude, HTTP, or the coaching rubric.
// It takes a video file path and returns a set of in-memory frames.
//
// Sampling is intentionally simple: extract a few frames per second across the
// whole clip, then evenly downsample to a frame cap so the API payload stays
// bounded. (No adaptive/scene-aware sampling.)

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";

// Tunables — one place to adjust the sampling behavior.
const SAMPLE_FPS = 2; // frames extracted per second of video
const FRAME_WIDTH = 640; // px; height auto-scaled to preserve aspect ratio
const MAX_FRAMES = 24; // hard cap on frames sent to the model

/**
 * Extract frames from a video file.
 * @param {string} videoPath absolute path to the input video
 * @returns {Promise<Array<{ index: number, timeSeconds: number, base64: string, mediaType: string }>>}
 */
export async function extractFrames(videoPath) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ppd-frames-"));
  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `fps=${SAMPLE_FPS},scale=${FRAME_WIDTH}:-1`,
      "-fps_mode",
      "passthrough",
      "-q:v",
      "3",
      path.join(workDir, "frame_%04d.jpg"),
    ]);

    const files = (await fs.readdir(workDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    if (files.length === 0) {
      throw new Error(
        "No frames could be extracted — the file may be corrupt or not a supported video.",
      );
    }

    const selected = evenlySample(files, MAX_FRAMES);

    const frames = [];
    for (const file of selected) {
      const buf = await fs.readFile(path.join(workDir, file));
      // ffmpeg names frames frame_0001.jpg (1-indexed). Recover the original
      // sample index to approximate a timestamp for the model.
      const originalIndex = parseInt(file.match(/frame_(\d+)\.jpg/)[1], 10);
      frames.push({
        index: originalIndex,
        timeSeconds: (originalIndex - 1) / SAMPLE_FPS,
        base64: buf.toString("base64"),
        mediaType: "image/jpeg",
      });
    }
    return frames;
  } finally {
    // Best-effort cleanup of the temp frame directory.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function evenlySample(items, cap) {
  if (items.length <= cap) return items;
  const out = [];
  const step = (items.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) {
    out.push(items[Math.round(i * step)]);
  }
  return out;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not resolve a binary path."));
      return;
    }
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export { MAX_FRAMES, SAMPLE_FPS };
