const API_URL = 'https://api.anthropic.com/v1/messages';

export async function callClaude({ system, messages, maxTokens = 1500, useWebSearch = false }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server. Add it to your .env file (see .env.example).');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const body = { model, max_tokens: maxTokens, system, messages };
  if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Anthropic API ${r.status}: ${errBody.slice(0, 300)}`);
  }
  const json = await r.json();
  const text = (json.content || []).map(b => b.text || '').join('');
  return text;
}
