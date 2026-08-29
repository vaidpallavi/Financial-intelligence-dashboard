/**
 * Finds the first balanced {...} object in a block of text and parses it.
 * Handles: markdown code fences around the JSON, prose before/after it, and
 * braces/quotes inside string values (so a rationale like "aim for {growth}"
 * doesn't confuse the brace counter). Returns a specific, actionable reason
 * on failure instead of just "invalid JSON".
 */
export function extractJsonObject(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();

  const start = t.indexOf('{');
  if (start === -1) return { ok: false, reason: 'No JSON object found in the response.' };

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (e) {
          return { ok: false, reason: `JSON was malformed: ${e.message}` };
        }
      }
    }
  }
  return { ok: false, reason: 'The response was cut off before the JSON finished (likely hit the token limit) - try a shorter custom task, or this worker\'s max_tokens can be raised in lib/workers.js.' };
}
