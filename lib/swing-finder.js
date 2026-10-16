// Swing finder: asks a small, cheap Claude model where bat-ball contact
// happens in a clip, so frames.js can sample the swing densely.
//
// Responsibility boundary: this module knows about the Anthropic API. It does
// NOT know about FFmpeg or the coaching rubric — it takes small thumbnail
// frames (from extractThumbnails in frames.js) and returns a contact time.
//
// Any failure (no swing found, refusal, API error) returns null, and the
// caller falls back to even sampling across the whole clip.

import Anthropic from "@anthropic-ai/sdk";

const FINDER_MODEL = process.env.PPD_FINDER_MODEL || "claude-haiku-5-5";

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM =
  "You find the moment of bat-ball contact in baseball and softball swing videos. " +
  "You are given small frames from one video in time order, each labeled with its frame number.";

const SCHEMA = {
  type: "object",
  properties: {
    swing_found: { type: "boolean" },
    contact_frame: { type: "integer" },
  },
  required: ["swing_found", "contact_frame"],
  additionalProperties: false,
};

/**
 * Find the contact time in a clip.
 * @param {Array<{ timeSeconds: number, base64: string, mediaType: string }>} thumbs
 * @param {{ onUsage?: (usage: object) => void }} [options]
 * @returns {Promise<number | null>} contact time in seconds, or null
 */
export async function findContactTime(thumbs, { onUsage } = {}) {
  if (!thumbs || thumbs.length < 3) return null;

  const content = [];
  thumbs.forEach((t, i) => {
    content.push({ type: "text", text: `Frame ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: t.mediaType, data: t.base64 } });
  });
  content.push({
    type: "text",
    text:
      "Which frame shows the bat meeting the ball (contact)? If contact falls between two " +
      "frames, give the closer one. If the hitter swings more than once, use the first swing. " +
      "If no swing is visible, set swing_found to false and contact_frame to 0.",
  });

  try {
    const response = await getClient().messages.create({
      model: FINDER_MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    onUsage?.(response.usage);
    if (response.stop_reason !== "end_turn") return null;

    const text = response.content.find((b) => b.type === "text")?.text;
    const answer = JSON.parse(text);
    const n = answer.contact_frame;
    if (!answer.swing_found || !Number.isInteger(n) || n < 1 || n > thumbs.length) return null;
    return thumbs[n - 1].timeSeconds;
  } catch (err) {
    console.error("Swing finder failed; using even sampling:", err?.message);
    return null;
  }
}

export { FINDER_MODEL };
