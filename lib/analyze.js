// Claude vision call + rubric logic.
//
// Responsibility boundary: this module knows about the Anthropic API and the
// coaching rubric. It does NOT know about HTTP, uploads, or FFmpeg — it takes
// already-extracted frames and returns the coaching report text.

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";

// Default to the current flagship. Overridable via env without a code change.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

// Lazy so importing this module doesn't require the key to be present yet.
// The client reads ANTHROPIC_API_KEY from the environment.
let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Run the swing analysis on a set of frames.
 * @param {Array<{ timeSeconds: number, base64: string, mediaType: string }>} frames
 * @returns {Promise<string>} the coaching report (markdown-ish plain text)
 */
export async function analyzeSwing(frames) {
  // Interleave a short label before each frame so the model can cite timestamps.
  const content = [
    {
      type: "text",
      text:
        `Here are ${frames.length} frames sampled in order across a single swing, ` +
        `filmed from the open side. Analyze the swing against the PPD Load/Unload ` +
        `checkpoints and return the coaching report.`,
    },
  ];

  for (const frame of frames) {
    content.push({
      type: "text",
      text: `Frame at ~${frame.timeSeconds.toFixed(1)}s:`,
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: frame.mediaType,
        data: frame.base64,
      },
    });
  }

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    // medium effort keeps demo latency reasonable while still reasoning through
    // the frames; raise to "high" if you want the most rigorous read.
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
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

export { MODEL };
