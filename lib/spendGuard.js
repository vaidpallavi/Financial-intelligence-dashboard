let dateKey = todayKey();
let count = 0;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // resets at UTC midnight
}

function resetIfNewDay() {
  const k = todayKey();
  if (k !== dateKey) { dateKey = k; count = 0; }
}

export function checkAndIncrementSpendGuard() {
  resetIfNewDay();
  const limit = Number(process.env.DAILY_CLAUDE_CALL_LIMIT || 50);
  if (count >= limit) {
    const err = new Error(`Daily Claude call limit (${limit}) reached. This resets at UTC midnight. Raise DAILY_CLAUDE_CALL_LIMIT in .env if needed.`);
    err.status = 429;
    throw err;
  }
  count += 1;
  return { used: count, limit };
}

export function spendGuardStatus() {
  resetIfNewDay();
  const limit = Number(process.env.DAILY_CLAUDE_CALL_LIMIT || 50);
  return { used: count, limit, date: dateKey };
}

// NOTE: this counter lives in server memory, so it resets if the server
// restarts/redeploys. For a resume/demo project that's a fine tradeoff for
// the simplicity of not needing a database. If you want it to survive
// restarts, swap this for a row in a real DB or a Redis counter.
