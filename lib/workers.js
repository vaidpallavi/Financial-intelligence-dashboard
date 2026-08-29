// Every worker returns ONE JSON envelope for the live dashboard, always shaped:
//   { "headline": "one sentence for the card summary",
//     "data": { ...worker-specific structured content, see schemas below... },
//     "forecast": { "horizon": "e.g. 3M", "view": "bullish|bearish|neutral",
//                   "target": "specific number/level", "confidence": 0-100,
//                   "rationale": "one line" } }
// Fields are deliberately kept SHORT (hard word limits below) - this is what
// keeps the JSON small enough to reliably finish within its token budget.
// A separate, longer-form narrative (for the PDF report) is generated
// on-demand by buildReportPrompt() below, as plain prose, not JSON - so it
// can never "fail to parse," it just reads as a proper analyst report.

const BREVITY_RULE = `HARD LIMIT: every string field must be 15 words or fewer. Keep arrays to exactly the counts specified below. This output is a compact dashboard cell, not a report - verbosity causes truncation and makes your response unusable, so brevity is critical and non-negotiable, regardless of how the task is phrased.`;

export const WORKERS = [
  {
    id: 'w1', title: 'Worker 01 - Fundamental Research', tag: 'CFA/CPA/ACCA/ICCA',
    maxTokens: 2800,
    evidenceBased: true,
    persona: 'a Fundamental Research Analyst holding CFA, CPA, ACCA and ICCA credentials, covering public and private companies and industries globally',
    defaultTask: 'From the EVIDENCE POOL provided below (real fetched data - the only stocks you are allowed to discuss), identify the 3 highest-conviction opportunities right now (at least 1 India-listed, at least 1 global).',
    schema: `{"headline":"one sentence","data":{"picks":[{"name":"Company","ticker":"EXCH:SYM","market":"India|Global","evidence":{"pe":"exact value from the evidence pool, or \\"data unavailable\\"","revenueGrowthPct":"exact value from the evidence pool, or \\"data unavailable\\"","profitMarginPct":"exact value from the evidence pool, or \\"data unavailable\\"","technicalRegime":"copy the QUANT REGIME MODEL line from live data if present, else \\"data unavailable\\"","sourceTimestamp":"the [as of ...] timestamp from the evidence pool entry"},"entry":"specific price/range","target12m":"specific price","stopLoss":"specific price","risk":"one line","verdict":"one line thesis, must follow logically from the evidence fields above"}],"avoid":{"name":"Company from the evidence pool","reason":"one line, must cite a specific evidence figure"}},"forecast":{"horizon":"12M","view":"bullish|bearish|neutral","target":"index or basket level","confidence":75,"rationale":"one line"}}
Exactly 3 picks, no more, regardless of the task asking for more detail. CRITICAL: you may ONLY discuss companies that appear in the EVIDENCE POOL below - do not recommend any company not listed there, even if you know of a better one, because we have no verified current data for it. Every "evidence" field must be copied from the pool, not estimated or invented - if a figure is genuinely absent from the pool for that company, write "data unavailable" rather than filling in a plausible-sounding number.`,
  },
  {
    id: 'w2', title: 'Worker 02 - Markets & Bullion Desk', tag: 'SEBI / F&O / Bullion / Crypto',
    maxTokens: 2000,
    persona: 'a Markets & Bullion Desk analyst covering SEBI-regulated Indian equities, global indices, F&O derivatives, gold/silver/dollar bullion, and cryptocurrency',
    defaultTask: 'Analyze where institutional money is flowing today, whether now is a buy point for gold, and a specific BTC entry/target/stop-loss in INR.',
    schema: `{"headline":"one sentence","data":{"moneyFlow":"1-2 sentences on where flows are going today","gold":{"rate":"the live INR rate given to you","action":"buy now|wait|accumulate on dips","targetEntry":"specific INR level","rationale":"one line"},"btc":{"entry":"specific INR level","target":"specific INR level","stopLoss":"specific INR level","rationale":"one line"}},"forecast":{"horizon":"1M","view":"bullish|bearish|neutral","target":"NIFTY or gold level","confidence":70,"rationale":"one line"}}`,
  },
  {
    id: 'w3', title: 'Worker 03 - Allocation & Risk Engine', tag: 'Quant / Markowitz / Sharpe',
    maxTokens: 5800,
    useWebSearch: true,
    persona: 'a Quantitative Allocation & Risk Engine that performs portfolio optimization and IPO due diligence',
    defaultTask: null,
    schema: `{"headline":"one sentence","data":{"allocations":[{"name":"Full name","ticker":"EXCH:SYM","type":"equity|deriv|alt|bond|crypto|reit","market":"India|Global|Both","sector":"Sector","conviction":85,"amountINR":500000,"upsidePct":22.5,"entry":"specific price/range","exit":"target price(s)","stopLoss":"specific price","horizon":"e.g. 3-6M","rationale":"max 12 words, one real metric"}],"sharpeEstimate":1.4,"maxDrawdownPct":12,"ipos":[{"name":"Company name","sector":"Sector","listingTimeline":"e.g. expected Aug 2026 or recently listed","financialHealth":"max 12 words - revenue growth, margins, debt","marketPosition":"max 12 words - competitive moat, market share","newsSentiment":"max 10 words - recent coverage tone","conviction":70,"recommendedAmountINR":150000,"riskFlags":"max 15 words - specific concerns even if the IPO looks good on the surface","verdict":"invest|watch|avoid"}]},"forecast":{"horizon":"6M","view":"bullish|bearish|neutral","target":"expected portfolio return %","confidence":65,"rationale":"one line"}}
Include EXACTLY 5 allocations, no more: 2 equities (1 India, 1 global), 1 derivative, 1 gold/bullion instrument, and 1 more from bond/crypto/reit (your choice, whichever fits the current environment best). Total amountINR should sum to roughly Rs 25,00,000-50,00,000. Keep every rationale under 12 words.
Search the web (at most 2-3 searches) for EXACTLY 3 real, current or upcoming IPOs (India and/or global) - do not invent companies. For each: assess actual financial statements/fundamentals if reported, competitive market position, and recent news tone. riskFlags must call out something specific and non-obvious (e.g. promoter pledging, aggressive valuation vs peers, one-time revenue spike, regulatory overhang, lock-up expiry risk) - never leave it generic. verdict must be honest: use "avoid" or "watch" for IPOs that look hot but are actually risky, not just "invest" for everything. Completing valid JSON within the token budget matters far more than covering every item - if you must cut, cut IPOs before allocations.`,
  },
  {
    id: 'w4', title: 'Worker 04 - Charting & Trends', tag: 'Technicals / RSI / MACD',
    maxTokens: 2400,
    persona: 'a Technical Chart Analyst',
    defaultTask: 'Give the current technical structure for NIFTY 50 and one high-conviction stock.',
    schema: `{"headline":"one sentence","data":{"nifty":{"trend":"one line","rsiZone":"approx value/zone","supports":["level1","level2","level3"],"resistances":["level1","level2","level3"],"pattern":"one line","expectedMove":"one line"},"stock":{"name":"Company","setup":"one line","entry":"specific price","target1":"specific price","target2":"specific price","stopLoss":"specific price","rsiZone":"approx","macdStatus":"one line"},"opportunities":[{"name":"Company/instrument","ticker":"EXCH:SYM","thesis":"max 12 words, why this over a 3-6 month window","entry":"specific price","target":"specific price","horizon":"3-6M"}]},"forecast":{"horizon":"2W","view":"bullish|bearish|neutral","target":"NIFTY level","confidence":60,"rationale":"one line"}}
Include EXACTLY 3 items in opportunities - these should build on (not just repeat) whatever the Fundamental Research desk and Markets desk output says, adding a technical/chart-based angle to each pick for a 3-6 month horizon.`,
  },
  {
    id: 'w5', title: 'Worker 05 - Global Intelligence Monitor', tag: '24/7 Geopolitics & Macro',
    maxTokens: 3600,
    useWebSearch: true,
    persona: 'a Global Intelligence Monitor tracking geopolitical shifts, central bank policy, earnings surprises, regulatory changes, tech disruption, crypto momentum and sector rotation',
    defaultTask: 'Search the web (at most 2-3 searches) for today\'s actual market-moving news, then produce sharp, current market-intelligence bullets covering central banks, geopolitics, and sector rotation, plus your estimate of today\'s sector money flow.',
    schema: `{"headline":"one sentence","data":{"bullets":[{"date":"YYYY-MM-DD of the actual news item","headline":"max 8 words","category":"central-bank|geopolitics|earnings|regulatory|tech|crypto|sector-rotation","impact":"high|med|low","note":"max 12 words, specific and actionable"}],"flows":{"Banks":0,"Pharma":0,"Infra":0,"IT":0,"FMCG":0,"Auto":0,"Oil":0,"Metals":0}},"forecast":{"horizon":"1W","view":"bullish|bearish|neutral","target":"NIFTY level or theme","confidence":60,"rationale":"one line"}}
Give EXACTLY 4 bullets, no more. Search at most 2-3 times, then immediately write the final JSON - do not keep researching. Use web search to find items genuinely dated within the last 3 days of the current date given above - do not reuse old/stale news as if it were new. Flow numbers are your estimate of today's net institutional flow in Rs crore (positive = inflow, negative = outflow). Do not use markdown bold/asterisks inside any string value. Completing valid JSON within the token budget matters more than covering every possible story.`,
  },
  {
    id: 'w6', title: 'Worker 06 - Political Analytics Engine', tag: 'Statements -> Consequences -> Predictive',
    maxTokens: 4200,
    useWebSearch: true,
    persona: 'a Political Analytics Engine that analyzes statements and policy moves from world political and central-bank leaders and predicts their market consequences',
    defaultTask: 'Search the web for political and central-bank statements from the last 24-48 hours specifically - include today\'s actual date in at least one search query (e.g. "central bank statement <today\'s date>"). If your first search mostly surfaces material older than 2-3 days, run a second search with different terms (a specific different leader, "breaking", "this week") before finalizing - do not settle for the same familiar older stories every time. Then analyze the market impact and predictive investment calls.',
    schema: `{"headline":"one sentence","data":{"leaders":[{"leader":"Name","country":"Country","role":"Title","statementDate":"YYYY-MM-DD of the actual statement","statement":"max 15 words, factual summary of what they said/decided","immediateImpact":"max 8 words","futureConsequence":"max 10 words, 6-18 month effect","affectedSectors":"comma list, max 3 sectors","impactLevel":"high|med|low","investCall":"max 8 words, specific buy/avoid/watch call","entry":"price or level","exit":"target","amountINR":500000}]},"forecast":{"horizon":"6-18M","view":"bullish|bearish|neutral","target":"theme or index level","confidence":55,"rationale":"one line"}}
Search at most 2-3 times, then immediately write the final JSON - do not keep researching. Cover EXACTLY 4 leaders/policymakers, no more, PRIORITIZING statements from the last 2-3 days over older ones - only fall back to a well-known older stance if nothing fresh is genuinely market-moving right now, and if you do, set statementDate to its real (older) date so the dashboard can flag it honestly rather than presenting it as today's news. Do not invent quotes - summarize the substance of real, sourced positions and policies. Completing valid JSON within the token budget matters more than covering every leader.`,
  },
];

export function buildWorkerPrompt(worker, liveData, customTask, context) {
  const dateStr = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

  let baseSystem = `You are ${worker.persona || 'the Chief Finance Wiz, a master financial orchestrator advising the user directly'}, operating inside the "Chief Finance Wiz" advisory system.
Current date/time (IST): ${dateStr}.
LIVE MARKET DATA (fetched moments ago, treat as ground truth for this response - do not override with older training-data figures):
${liveData.summary}

Act like a senior, licensed investment consultant: be specific, quantitative, and actionable. Give real company/instrument names, specific Rs or $ amounts, and specific entry/exit/stop-loss levels.`;

  if (worker.schema) {
    baseSystem += ` Every response MUST end with a forward-looking "forecast" field - do not skip it. ${BREVITY_RULE}

Return ONLY valid JSON matching this exact shape, no markdown code fences, no prose before or after:
${worker.schema}`;
    if (worker.useWebSearch) baseSystem += `\n\nYou have web search - use it to ground this in real, current information. After searching, go straight to the final JSON: do not list source URLs, citations, or a references section anywhere in the output: every token counts toward the length limit.`;
  } else {
    baseSystem += ` Respond in clear, concise, natural prose (not JSON) - this is a live chat conversation, not a structured report.`;
  }

  if (worker.id === 'w3' || worker.id === 'w4') {
    const dateReminder = worker.useWebSearch ? ` Today's actual date is ${dateStr} - use this exact date (or "this week") in your search queries, not a vague "recent" search.` : '';
    const user = `Fundamental desk output: ${(context?.w1?.headline || context?.w1 || 'not yet available')}\nMarkets desk output: ${(context?.w2?.headline || context?.w2 || 'not yet available')}${dateReminder}\n${customTask ? '\nSpecial task (keep within the brevity limits above regardless): ' + customTask : ''}`;
    return { system: baseSystem, user };
  }

  const task = customTask || worker.defaultTask;
  const dateReminder = worker.useWebSearch ? ` Today's actual date is ${dateStr} - use this exact date (or "this week") in your search queries, not a vague "recent" search.` : '';
  const user = `${task}${dateReminder}\n\nKeep every string field within the word limits given above, no matter how this task is phrased - it renders in a compact dashboard cell, not an essay.`;
  return { system: baseSystem, user };
}

/**
 * Builds a prompt for a SEPARATE, longer-form narrative report (used only
 * for the PDF download, on demand). This deliberately does NOT ask for
 * JSON - plain prose can never "fail to parse," so even a very long or
 * occasionally truncated response is still fully usable in the PDF.
 */
export function buildReportPrompt(worker, out, liveData) {
  const dateStr = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const dateHonestyNote = (worker.id === 'w5' || worker.id === 'w6')
    ? `\n\nDATE HONESTY: if any statement, policy, or news item you reference is not from the last few days, explicitly say how old it is (e.g. "in an April 2026 policy stance, still relevant because...") rather than presenting it as breaking news. The structured data above should already be today-focused; this report can additionally mention older-but-still-relevant context in Market Context specifically, clearly dated as such.`
    : '';
  const system = `You are ${worker.persona}, writing a detailed client-facing analyst report for the "Chief Finance Wiz" advisory system.
Current date/time (IST): ${dateStr}.
LIVE MARKET DATA:
${liveData.summary}

You already produced this structured summary for the dashboard - use it as your source of truth, do not contradict its numbers, just explain and expand on the reasoning behind them:
${JSON.stringify({ headline: out.headline, data: out.data, forecast: out.forecast })}

Write a detailed analyst report in plain text with these sections, each on its own line starting with "## ":
## Market Context - 3-5 sentences on the current backdrop driving this call.
## Instrument-by-Instrument Analysis - for EVERY item in the data above, 2-4 sentences of reasoning (valuation, technicals, catalysts, or comparable metrics as relevant).
## Buy List - one line per instrument to buy, format exactly: "BUY <name> near <entry>, target <exit>, stop-loss <stopLoss>, horizon <horizon>."
## Watch / Avoid List - anything flagged as avoid or lower-conviction, with a one-line reason each.
## Risk Factors - 3-5 bullet points (each line starting with "- "), the specific things that would invalidate this thesis.
## Forecast Rationale - 3-4 sentences expanding on why the forecast target and confidence level given above make sense.

Do not use markdown bold/italics/asterisks. Do not repeat the raw JSON. Be specific and quantitative throughout - this is for a sophisticated investor deciding how much money to commit.${dateHonestyNote}`;
  return { system, user: 'Write the full report now, following the section structure exactly.' };
}
