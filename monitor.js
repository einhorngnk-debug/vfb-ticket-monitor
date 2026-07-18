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

async function clickConsentInFrame(frame) {
  const candidates = [
    frame.getByRole("button", { name: /alle akzeptieren/i }).first(),
    frame.getByText(/alle akzeptieren/i, { exact: true }).first(),
    frame.locator('button:has-text("Alle akzeptieren")').first(),
    frame.locator('a:has-text("Alle akzeptieren")').first(),
    frame.locator('input[value*="Alle akzeptieren" i]').first(),
    frame.locator('[aria-label*="Alle akzeptieren" i]').first(),
    frame.getByRole("button", { name: /ablehnen/i }).first(),
    frame.getByText(/ablehnen/i, { exact: true }).first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 500 })) {
        await candidate.click({ force: true, timeout: 3000 });
        return true;
      }
    } catch {
      // nächsten Kandidaten probieren
    }
  }

  return false;
}

async function clickConsentInShadowDom(page) {
  return page.evaluate(() => {
    const wanted = /^(alle akzeptieren|ablehnen)$/i;

    function visit(root) {
      const elements = root.querySelectorAll("*");

      for (const element of elements) {
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const value = (element.getAttribute?.("value") || "").trim();
        const label = (element.getAttribute?.("aria-label") || "").trim();

        const tag = element.tagName?.toLowerCase();
        const clickable =
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          element.getAttribute?.("role") === "button";

        if (
          clickable &&
          (wanted.test(text) || wanted.test(value) || wanted.test(label))
        ) {
          element.click();
          return true;
        }

        if (element.shadowRoot && visit(element.shadowRoot)) {
          return true;
        }
      }

      return false;
    }

    return visit(document);
  }).catch(() => false);
}

async function consentStillVisible(page) {
  const visibleText = await page
    .getByText(/Privatsphäre-Einstellungen/i)
    .first()
    .isVisible({ timeout: 700 })
    .catch(() => false);

  if (visibleText) return true;

  for (const frame of page.frames()) {
    const frameVisible = await frame
      .getByText(/Privatsphäre-Einstellungen/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);

    if (frameVisible) return true;
  }

  return false;
}

async function dismissConsent(page) {
  // ConsentManager lädt den Dialog verzögert nach. Deshalb länger warten.
  await page.waitForTimeout(1800);

  for (let attempt = 1; attempt <= 10; attempt++) {
    for (const frame of page.frames()) {
      if (await clickConsentInFrame(frame)) {
        console.log(`Cookie-Dialog per Locator geschlossen (Versuch ${attempt}).`);
        await page.waitForTimeout(1000);
        if (!(await consentStillVisible(page))) return true;
      }
    }

    if (await clickConsentInShadowDom(page)) {
      console.log(`Cookie-Dialog im Shadow DOM geschlossen (Versuch ${attempt}).`);
      await page.waitForTimeout(1000);
      if (!(await consentStillVisible(page))) return true;
    }

    await page.waitForTimeout(600);
  }

  // Letzte Rückfallebene: Der ConsentManager-Dialog ist im Screenshot mittig.
  // Klick auf den roten Hauptbutton "Alle akzeptieren".
  if (await consentStillVisible(page)) {
    const viewport = page.viewportSize();
    if (viewport) {
      await page.mouse.click(
        Math.round(viewport.width * 0.50),
        Math.round(viewport.height * 0.525)
      );
      await page.waitForTimeout(1200);

      if (!(await consentStillVisible(page))) {
        console.log("Cookie-Dialog per Koordinaten-Fallback geschlossen.");
        return true;
      }
    }
  }

  // Der Dialog darf nicht einfach per CSS versteckt werden, weil er Klicks
  // und Scroll-Locks hinterlassen kann. Deshalb bei Misserfolg klar abbrechen.
  if (await consentStillVisible(page)) {
    throw new Error(
      "Der Cookie-Dialog konnte trotz Locator-, Frame-, Shadow-DOM- und Koordinaten-Fallback nicht geschlossen werden."
    );
  }

  return false;
}

async function firstVisible(page, selectors, timeout = 3000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    } catch {
      // nächsten Selektor probieren
    }
  }
  return null;
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

  await tile.click({ timeout: 10_000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await dismissConsent(page);

  const eventLink = await firstVisible(page, [
    ".event-link",
    "[data-performanceid]",
    "[data-eventid]",
  ], 12_000);

  if (!eventLink) {
    throw new Error(
      "Auf der öffentlichen Auswärtsspiel-Seite wurden keine Ticket-Elemente gefunden. Möglicherweise sind die Daten nur nach Login sichtbar."
    );
  }
}

async function readEvents(page) {
  return page.locator(".event-link, [data-performanceid], [data-eventid]")
    .evaluateAll((items) => {
      const seen = new Set();

      return items
        .map((item, index) => {
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
        .filter((event) => {
          if (seen.has(event.id)) return false;
          seen.add(event.id);
          return true;
        });
    });
}

async function sendEmail(eventName, status, pageUrl) {
  const response = await fetch(process.env.EMAIL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
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
  viewport: { width: 1440, height: 1000 },
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
