// ---------------------------------------------------------------------------
// Transparent client classification (Phase 7).
//
// Deterministic, rule-based reading of the User-Agent header. This is
// REPORTING ONLY: a classification never blocks a request by itself — the
// synchronous rate limiter (lib/rate-limit.ts) is the only thing that ever
// returns 429, and it applies equally to classified bots and humans.
// Misclassifying a human as a bot must stay cheap: the worst consequence is
// that their view is annotated (and later excluded from popularity rankings),
// never a lockout.
//
// Rules are intentionally boring and inspectable:
//   - no/empty UA                      → "suspicious" (browsers always send one)
//   - known crawler / CLI / library UA → "bot"
//   - automation markers               → "suspicious"
//   - everything else                  → "human"
// ---------------------------------------------------------------------------

export const CLIENT_CLASSES = ["human", "bot", "suspicious"] as const;

export type ClientClass = (typeof CLIENT_CLASSES)[number];

/**
 * Known crawlers, fetchers, and non-browser HTTP clients. Kept lowercase —
 * matching runs against a lowercased UA. Extend deliberately: every pattern
 * here is visible in code review and in the README policy table.
 */
const BOT_PATTERNS: RegExp[] = [
  /bot\b/i, // googlebot, bingbot, gptbot, twitterbot, ...
  /\bbots?\//i,
  /crawler|spider|crawl\b/i,
  /slurp/i,
  /curl\//i,
  /wget/i,
  /python-requests|python-urllib|aiohttp|httpx/i,
  /node-fetch|undici|axios\//i,
  /go-http-client|okhttp|java\/|libwww|httpclient|scrapy/i,
  /lighthouse|semrush|ahrefs|bytespider|petalbot|perplexitybot|ccbot|claudebot/i,
  /facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|embedly|quora link preview/i,
];

/**
 * Automation markers that are not a named crawler: headless browsers and
 * test drivers. Treated as "suspicious" (not conclusively a bot — headless
 * Chromium is also embedded in many legitimate kiosk/preview tools).
 */
const AUTOMATION_PATTERNS: RegExp[] = [
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer|playwright|selenium|webdriver/i,
  /electron\//i,
];

/**
 * Classify one request's User-Agent. Pure and deterministic — the same UA
 * always yields the same class, so tests and consumers can reason about it.
 */
export function classifyClient(userAgent: unknown): ClientClass {
  if (typeof userAgent !== "string" || userAgent.trim().length === 0) {
    return "suspicious";
  }
  for (const pattern of BOT_PATTERNS) {
    if (pattern.test(userAgent)) return "bot";
  }
  for (const pattern of AUTOMATION_PATTERNS) {
    if (pattern.test(userAgent)) return "suspicious";
  }
  return "human";
}

/** True when a class should be excluded from popularity ranking inputs. */
export function isRankingEligible(clientClass: ClientClass | undefined | null): boolean {
  return clientClass !== "bot";
}
