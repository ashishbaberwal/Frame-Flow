import { describe, expect, it } from "vitest";

import {
  CLIENT_CLASSES,
  classifyClient,
  isRankingEligible,
} from "../src/lib/client-signals.js";

/**
 * Client-signal classification (Phase 7). Pure functions, so these tests are
 * the full behavioral spec: UAs in, classes out, same input ever after.
 * The classification never blocks a request — it only annotates analytics —
 * so a false "bot" is a reporting debounce, never a lockout.
 */

const HUMAN_UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
];

const BOT_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  "Mozilla/5.0 (compatible; Twitterbot/1.0)",
  "curl/8.7.1",
  "Wget/1.25.0",
  "python-requests/2.32.3",
  "python-urllib3/2.2.1",
  "axios/1.12.0",
  "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  "Go-http-client/2.0",
  "okhttp/4.12.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "WhatsApp/2.24.1.79 A",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
  "My Tiny Crawler v0.1",
  "Screaming Frog SEO Spider/20.0",
];

const SUSPICIOUS_UAS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Puppeteer/23.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Playwright/1.47.0",
  "Mozilla/5.0 (X11; Linux x86_64) Selenium/4.25.0",
  "Mozilla/5.0 (X11; Linux x86_64) webdriver/1.0",
  "Mozilla/5.0 Electron/32.0.0 Chrome/128.0.0.0 Safari/537.36",
];

describe("classifyClient", () => {
  it("classifies real browser UAs as human", () => {
    for (const ua of HUMAN_UAS) {
      expect(classifyClient(ua), ua).toBe("human");
    }
  });

  it("classifies crawler, CLI and library UAs as bot", () => {
    for (const ua of BOT_UAS) {
      expect(classifyClient(ua), ua).toBe("bot");
    }
  });

  it("classifies automation markers as suspicious", () => {
    for (const ua of SUSPICIOUS_UAS) {
      expect(classifyClient(ua), ua).toBe("suspicious");
    }
  });

  it("classifies missing or empty UAs as suspicious — browsers always send one", () => {
    expect(classifyClient(undefined)).toBe("suspicious");
    expect(classifyClient(null)).toBe("suspicious");
    expect(classifyClient(42)).toBe("suspicious");
    expect(classifyClient("")).toBe("suspicious");
    expect(classifyClient("   ")).toBe("suspicious");
  });

  it("is deterministic and case-insensitive for known patterns", () => {
    expect(classifyClient("Googlebot/2.1")).toBe(classifyClient("Googlebot/2.1"));
    expect(classifyClient("curl/8.0")).toBe("bot");
    expect(classifyClient("CURL/8.0")).toBe("bot");
  });

  it("always returns a member of CLIENT_CLASSES", () => {
    for (const ua of [...HUMAN_UAS, ...BOT_UAS, ...SUSPICIOUS_UAS, undefined, ""]) {
      expect(CLIENT_CLASSES).toContain(classifyClient(ua));
    }
  });
});

describe("isRankingEligible", () => {
  it("excludes only explicit bot classifications", () => {
    expect(isRankingEligible("human")).toBe(true);
    expect(isRankingEligible("suspicious")).toBe(true);
    expect(isRankingEligible("bot")).toBe(false);
  });

  it("treats unclassified events (legacy NULL column) as eligible", () => {
    expect(isRankingEligible(undefined)).toBe(true);
    expect(isRankingEligible(null)).toBe(true);
  });
});
