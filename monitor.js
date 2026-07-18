import { chromium } from "playwright";
import fs from "node:fs/promises";

const START_URL = "https://tickets.vfb.de/";
const STATE_FILE = "state.json";
const SOLD_OUT_TEXT = "gästebereich ausverkauft";

for (const name of ["EMAIL_ENDPOINT", "EMAIL_SECRET"]) {
  if (!process.env[name]) {
    throw new Error(`GitHub Secret ${name} fehlt.`);
  }
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value).toLocaleLowerCase("de-DE");
}

async function firstVisible(page, selectors, timeout = 2500) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    } catch {
      // Nächsten Selektor versuchen.
    }
  }

  return null;
}

async function dismissConsent(page) {
  const selectors = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Alles akzeptieren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Zustimmen")',
    'button:has-text("Einverstanden")',
    '[aria-label*="alle akzeptieren" i]',
    '[aria-label*="akzeptieren" i]',
  ];

  for (let attempt = 1; attempt <= 8; attempt++) {
    const button = await firstVisible(page, selectors, 900);

    if (button) {
      console.log(`Cookie-Dialog gefunden (Versuch ${attempt}).`);
      await button.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function openAwayGames(page) {
  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await dismissConsent(page);

  const tile = await firstVisible(page, [
    'a:has-text("AUSWÄRTS SPIELE")',
    'button:has-text("AUSWÄRTS SPIELE")',
    'a:has-text("Auswärtsspiele")',
    'button:has-text("Auswärtsspiele")',
    'a:has-text("Auswärts Spiele")',
    'button:has-text("Auswärts Spiele")',
    'text=/auswärts\s*spiele/i',
  ], 5000);

  if (!tile) {
    throw new Error('Die öffentliche Kachel „Auswärtsspiele“ wurde nicht gefunden.');
  }

  await tile.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1800);
  await dismissConsent(page);

  const eventLink = await firstVisible(page, [
    ".event-link",
    '[data-performanceid]',
    '[data-eventid]',
  ], 10_000);

  if (!eventLink) {
    const loginVisible = await firstVisible(page, [
      'a:has-text("Anmelden")',
      'button:has-text("Anmelden")',
      'input[type="password"]',
    ], 1200);

    if (loginVisible) {
      throw new Error(
        "Die Auswärtsspiele sind öffentlich nicht vollständig sichtbar. Der Shop verlangt an dieser Stelle offenbar einen Login."
      );
    }

    throw new Error(
      "Auf der öffentlichen Auswärtsspiel-Seite wurden keine Ticket-Elemente gefunden."
    );
  }
}

async function readEvents(page) {
  const events = await page.locator(".event-link").evaluateAll((buttons) =>
    buttons.map((button, index) => {
      const root =
        button.closest(".event") ||
        button.closest("article") ||
        button.parentElement;

      const title =
        root?.querySelector(".event-title")?.textContent?.trim() ||
        root?.querySelector("h1, h2, h3, h4")?.textContent?.trim() ||
        button.getAttribute("aria-label")?.trim() ||
        `Spiel ${index + 1}`;

      const status =
        button.textContent?.replace(/\s+/g, " ").trim() ||
        button.getAttribute("aria-label")?.trim() ||
        "";

      const id =
        button.getAttribute("data-performanceid") ||
        button.getAttribute("data-eventid") ||
        `${title}-${index}`;

      return { id, title, status };
    })
  );

  if (events.length > 0) return events;

  return page.locator('[data-performanceid], [data-eventid]').evaluateAll((items) =>
    items.map((item, index) => {
      const root =
        item.closest(".event") ||
        item.closest("article") ||
        item.parentElement;

      const title =
        root?.querySelector(".event-title")?.textContent?.trim() ||
        root?.querySelector("h1, h2, h3, h4")?.textContent?.trim() ||
        item.getAttribute("aria-label")?.trim() ||
        `Spiel ${index + 1}`;

      const status =
        item.textContent?.replace(/\s+/g, " ").trim() ||
        item.getAttribute("aria-label")?.trim() ||
        "";

      const id =
        item.getAttribute("data-performanceid") ||
        item.getAttribute("data-eventid") ||
        `${title}-${index}`;

      return { id, title, status };
    })
  );
}

async function sendEmail(eventName, status, pageUrl) {
  const response = await fetch(process.env.EMAIL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      secret: process.env.EMAIL_SECRET,
      eventName,
      status,
      pageUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Mail-Endpunkt antwortete mit HTTP ${response.status}.`);
  }
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  viewport: {
    width: 1440,
    height: 1000,
  },
});

const page = await context.newPage();

try {
  await openAwayGames(page);

  const events = await readEvents(page);

  if (events.length === 0) {
    throw new Error("Keine öffentlich sichtbaren Ticket-Ereignisse gefunden.");
  }

  const previous = await loadState();
  const next = { ...previous };

  for (const event of events) {
    const id = clean(event.id);
    const title = clean(event.title);
    const status = clean(event.status);

    const oldStatus = normalize(previous[id]?.status);
    const newStatus = normalize(status);

    console.log(`${title} -> ${status}`);

    const wasSoldOut = oldStatus.includes(SOLD_OUT_TEXT);
    const isSoldOut = newStatus.includes(SOLD_OUT_TEXT);

    if (previous[id] && wasSoldOut && !isSoldOut) {
      await sendEmail(title, status, page.url());
      console.log(`E-Mail ausgelöst: ${title}`);
    }

    next[id] = {
      title,
      status,
      checkedAt: new Date().toISOString(),
    };
  }

  await saveState(next);
} catch (error) {
  console.error(error);

  await page.screenshot({
    path: "failure.png",
    fullPage: true,
  }).catch(() => {});

  await fs.writeFile(
    "failure.html",
    await page.content().catch(() => ""),
    "utf8"
  ).catch(() => {});

  throw error;
} finally {
  await browser.close();
}
