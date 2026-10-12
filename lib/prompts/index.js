// Picks the coaching rubric (system prompt) for the selected mode.
//
// Responsibility boundary: this module only maps a mode name to its prompt
// text. It knows nothing about the Anthropic API, uploads, or FFmpeg.
// Hitting and Pitching are kept consistent in structure and vocabulary.

import { HITTING_SYSTEM_PROMPT } from "./hitting.js";
import { PITCHING_SYSTEM_PROMPT } from "./pitching.js";

export const SPORTS = ["hitting", "pitching"];

export function getSystemPrompt(sport) {
  if (sport === "hitting") return HITTING_SYSTEM_PROMPT;
  if (sport === "pitching") return PITCHING_SYSTEM_PROMPT;
  throw new Error(`Unknown analysis mode: ${sport}`);
}

export { HITTING_SYSTEM_PROMPT, PITCHING_SYSTEM_PROMPT };
