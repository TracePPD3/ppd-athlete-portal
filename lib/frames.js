// Frame extraction from an uploaded swing video.
//
// Responsibility boundary: this module knows about FFmpeg and the local
// filesystem. It does NOT know about Claude, HTTP, or the coaching rubric.
// It takes a video file path and returns a set of in-memory frames.
//
// Default sampling is simple: extract a few frames per second across the
// whole clip, then evenly downsample to a frame cap so the API payload stays
// bounded.
//
// Dense-swing sampling (used for hitting): at 2 fps the stride and foot plant
// can fall entirely between two frames. When the caller knows the contact
// time (from lib/swing-finder.js), the window before and just after contact is
// sampled densely and the rest of the frame cap is filled with overview frames
// from the rest of the clip. Without a contact time, default sampling is used.

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";

// Tunables — one place to adjust the sampling behavior.
// PPD_SAMPLE_FPS / PPD_MAX_FRAMES let the clip test script try other sampling
// rates without editing code. Unset, the defaults below apply (live behavior).
const SAMPLE_FPS = Number(process.env.PPD_SAMPLE_FPS) || 2; // frames extracted per second of video
const FRAME_WIDTH = 640; // px; height auto-scaled to preserve aspect ratio
const MAX_FRAMES = Number(process.env.PPD_MAX_FRAMES) || 24; // hard cap on frames sent to the model

// Dense window around contact: load, stride, foot plant, contact.
const DENSE_FPS = 10; // frames per second inside the window
const DENSE_BEFORE = 1.2; // seconds before contact
const DENSE_AFTER = 0.3; // seconds after contact

// Small frames the swing finder looks at to locate contact.
const THUMB_FPS = 4;
const THUMB_WIDTH = 320;
const MAX_THUMBS = 60;

/**
 * Extract frames from a video file.
 * @param {string} videoPath absolute path to the input video
 * @param {{ contactTime?: number | null }} [options] contactTime: seconds into
 *   the clip where the bat meets the ball; when given, sample around it densely
 * @returns {Promise<Array<{ index: number, timeSeconds: number, base64: string, mediaType: string }>>}
 */
export async function extractFrames(videoPath, { contactTime = null } = {}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ppd-frames-"));
  try {
    const overview = await extractJpegs(videoPath, path.join(workDir, "overview"), {
      fps: SAMPLE_FPS,
      width: FRAME_WIDTH,
    });
    if (overview.length === 0) {
      throw new Error(
        "No frames could be extracted — the file may be corrupt or not a supported video.",
      );
    }

    let selected;
    if (contactTime == null) {
      selected = evenlySample(overview, MAX_FRAMES);
    } else {
      // Start on the dense frame grid so frame times land on whole tenths
      // and no two frames share the same "~X.Xs" label in the prompt.
      const start = Math.max(0, Math.round((contactTime - DENSE_BEFORE) * DENSE_FPS) / DENSE_FPS);
      const end = contactTime + DENSE_AFTER;
      const dense = await extractJpegs(videoPath, path.join(workDir, "dense"), {
        fps: DENSE_FPS,
        width: FRAME_WIDTH,
        start,
        duration: end - start,
      });
      const denseKept = evenlySample(dense, MAX_FRAMES);
      const lastDense = denseKept.length ? denseKept[denseKept.length - 1].timeSeconds : end;
      const outside = overview.filter((f) => f.timeSeconds < start || f.timeSeconds > lastDense);
      const overviewKept = evenlySample(outside, Math.max(0, MAX_FRAMES - denseKept.length));
      selected = [...overviewKept, ...denseKept].sort((a, b) => a.timeSeconds - b.timeSeconds);
    }
    return await loadFrames(selected);
  } finally {
    // Best-effort cleanup of the temp frame directory.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Small frames across the whole clip, for the swing finder.
 * @param {string} videoPath absolute path to the input video
 * @returns {Promise<Array<{ index: number, timeSeconds: number, base64: string, mediaType: string }>>}
 */
export async function extractThumbnails(videoPath) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ppd-thumbs-"));
  try {
    const thumbs = await extractJpegs(videoPath, workDir, { fps: THUMB_FPS, width: THUMB_WIDTH });
    return await loadFrames(evenlySample(thumbs, MAX_THUMBS));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadFrames(selected) {
  const frames = [];
  for (let i = 0; i < selected.length; i++) {
    const buf = await fs.readFile(selected[i].file);
    frames.push({
      index: i + 1,
      timeSeconds: selected[i].timeSeconds,
      base64: buf.toString("base64"),
      mediaType: "image/jpeg",
    });
  }
  return frames;
}

// Extract JPEG frames at `fps`, optionally only from `start` for `duration`
// seconds. Returns [{ file, timeSeconds }] in time order.
async function extractJpegs(videoPath, outDir, { fps, width, start = 0, duration }) {
  await fs.mkdir(outDir, { recursive: true });
  const seek = start > 0 ? ["-ss", start.toFixed(3)] : [];
  const limit = duration ? ["-t", duration.toFixed(3)] : [];
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    ...seek,
    "-i",
    videoPath,
    ...limit,
    "-vf",
    `fps=${fps},scale=${width}:-1`,
    "-fps_mode",
    "passthrough",
    "-q:v",
    "3",
    path.join(outDir, "frame_%04d.jpg"),
  ]);
  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
  // ffmpeg names frames frame_0001.jpg (1-indexed) at a steady `fps`, so the
  // file number gives an approximate timestamp for the model.
  return files.map((f) => ({
    file: path.join(outDir, f),
    timeSeconds: start + (parseInt(f.match(/frame_(\d+)\.jpg/)[1], 10) - 1) / fps,
  }));
}

function evenlySample(items, cap) {
  if (items.length <= cap) return items;
  if (cap <= 0) return [];
  if (cap === 1) return [items[0]];
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
