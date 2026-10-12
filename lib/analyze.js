// Claude vision call + rubric logic.
//
// Responsibility boundary: this module knows about the Anthropic API and the
// coaching rubrics. It does NOT know about HTTP, uploads, or FFmpeg — it takes
// already-extracted frames and returns the coaching report text.
//
// Modes: "hitting" (one open-side clip) and "pitching" (one or two clips:
// open side and/or behind). Each mode's rubric lives in lib/prompts/.

import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./prompts/index.js";

// Default to the current flagship. Overridable via env without a code change.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

// Lazy so importing this module doesn't require the key to be present yet.
// The client reads ANTHROPIC_API_KEY from the environment.
let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Human-readable angle name used in the prompt text the model sees.
function angleLabel(angle) {
  return angle === "behind" ? "behind" : "open side";
}

function imageBlock(frame) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: frame.mediaType,
      data: frame.base64,
    },
  };
}

// Build the user message content (labeled text + frames) for a mode.
function buildContent(sport, angleSets) {
  const content = [];

  if (sport === "hitting") {
    // Hitting stays single-clip. This wording is unchanged from the version
    // that was tuned for stable verdicts, on purpose.
    const frames = angleSets[0].frames;
    content.push({
      type: "text",
      text:
        `Here are ${frames.length} frames sampled in order across a single swing, ` +
        `filmed from the open side. Analyze the swing against the PPD Load/Unload ` +
        `checkpoints and return the coaching report.`,
    });
    for (const frame of frames) {
      content.push({
        type: "text",
        text: `Frame at ~${frame.timeSeconds.toFixed(1)}s:`,
      });
      content.push(imageBlock(frame));
    }
    return content;
  }

  // Pitching: one frame set per angle, each clearly labeled so the model can
  // say which angle every observation came from.
  const angleNames = angleSets.map((set) => angleLabel(set.angle)).join(" and ");
  content.push({
    type: "text",
    text:
      `Here are frame sets from a single pitching delivery. Angles provided: ` +
      `${angleNames}. Within each set the frames are sampled in order. Analyze ` +
      `the delivery against the PPD Load/Balance and Separation checkpoints, ` +
      `cite which angle each observation came from, and return the coaching report.`,
  });
  for (const set of angleSets) {
    const label = angleLabel(set.angle);
    content.push({
      type: "text",
      text: `${label.toUpperCase()} VIEW: ${set.frames.length} frames in order.`,
    });
    for (const frame of set.frames) {
      content.push({
        type: "text",
        text: `[${label}] Frame at ~${frame.timeSeconds.toFixed(1)}s:`,
      });
      content.push(imageBlock(frame));
    }
  }
  return content;
}

/**
 * Run the analysis for a mode on one or more angle sets of frames.
 * @param {{
 *   sport: "hitting" | "pitching",
 *   angleSets: Array<{
 *     angle: string,
 *     frames: Array<{ timeSeconds: number, base64: string, mediaType: string }>
 *   }>
 * }} args
 * @returns {Promise<string>} the coaching report (markdown-ish plain text)
 */
export async function analyzeVideo({ sport, angleSets }) {
  const system = getSystemPrompt(sport); // throws on an unknown mode

  if (!Array.isArray(angleSets) || angleSets.length === 0) {
    throw new Error("No frames were provided for analysis.");
  }
  if (angleSets.some((set) => !set.frames || set.frames.length === 0)) {
    throw new Error("One of the clips produced no frames.");
  }
  if (sport === "hitting" && angleSets.length > 1) {
    throw new Error("Hitting analysis takes a single clip.");
  }

  const content = buildContent(sport, angleSets);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    // high effort for more careful, thorough reasoning — trades a little latency
    // for steadier verdicts (reduces borderline flip-flopping between runs on
    // the same clip).
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to analyze this video.");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("The model returned an empty analysis.");
  }
  return text;
}

// Kept so older callers (the current route) keep working: a hitting swing,
// one open-side frame set.
export async function analyzeSwing(frames) {
  return analyzeVideo({
    sport: "hitting",
    angleSets: [{ angle: "open side", frames }],
  });
}

export { MODEL };
