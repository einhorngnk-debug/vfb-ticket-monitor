import { chromium } from "playwright";
import fs from "node:fs/promises";

const TICKET_URL =
  "https://tickets.vfb.de/shop?wes=empty_session_103&language=1&shopid=103&nextstate=2&lpShortcutId=4";

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

async function closeCookieDialog(page) {
  await page.waitForTimeout(1400);

  for (let attempt = 1; attempt <= 8; attempt++) {
    for (const frame of page.frames()) {
      const candidates = [
        frame.getByRole("button", { name: /alle akzeptieren/i }).first(),
        frame.getByText(/alle akzeptieren/i, { exact: true }).first(),
        frame.locator('button:has-text("Alle akzeptieren")').first(),
        frame.locator('[aria-label*="Alle akzeptieren" i]').first(),
        frame.getByRole("button", { name: /ablehnen/i }).first(),
      ];

      for (const candidate of candidates) {
        try {
          if (await candidate.isVisible({ timeout: 350 })) {
            await candidate.click({ force: true, timeout: 2500 });
            await page.waitForTimeout(700);
            return;
          }
        } catch {
          // nächsten Kandidaten probieren
        }
      }
    }

    await page.waitForTimeout(450);
  }

  const consentVisible = await page
    .getByText(/Privatsphäre-Einstellungen/i)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  if (consentVisible) {
    const viewport = page.viewportSize();
    if (viewport) {
      await page.mouse.click(
        Math.round(viewport.width * 0.5),
        Math.round(viewport.height * 0.525)
      );
      await page.waitForTimeout(900);
    }
  }
}

async function openTicketPage(page) {
  await page.goto(TICKET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await closeCookieDialog(page);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  await page.locator(".events .event-container").first().waitFor({
    state: "visible",
    timeout: 20_000,
  });

  const count = await page.locator(".events .event-container").count();

  if (count === 0) {
    throw new Error("Keine Veranstaltungskarten gefunden.");
  }

  console.log(`${count} Veranstaltungskarte(n) gefunden.`);
}

async function readEvents(page) {
  const cards = page.locator(".events .event-container");
  const count = await cards.count();
  const events = [];

  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);

    const data = await card.evaluate((element, cardIndex) => {
      const clean = (value) =>
        String(value ?? "").replace(/\s+/g, " ").trim();

      const lines = (element.innerText || "")
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);

      const titleLineIndex = lines.findIndex((line) =>
        line.includes("VfB Stuttgart")
      );

      let title = "";

      if (titleLineIndex >= 0) {
        const current = lines[titleLineIndex];

        if (current.includes(" - ") || current.startsWith("VfB Stuttgart")) {
          title = current;
        } else if (titleLineIndex > 0) {
          title = `${lines[titleLineIndex - 1]} ${current}`;
        } else {
          title = current;
        }
      }

      title = clean(title);

      const statusCandidates = [...element.querySelectorAll("a, button, [role='button']")]
        .map((node) => clean(node.textContent))
        .filter(Boolean)
        .filter((text) => {
          const lower = text.toLocaleLowerCase("de-DE");

          return (
            lower.includes("gästebereich") ||
            lower.startsWith("mitglieder:") ||
            lower.includes("verkaufsstart") ||
            lower.includes("jetzt kaufen") ||
            lower.includes("ausverkauft") ||
            lower.includes("nicht verfügbar")
          );
        });

      const status =
        statusCandidates.at(-1) ||
        lines.find((line) => {
          const lower = line.toLocaleLowerCase("de-DE");

          return (
            lower.includes("gästebereich") ||
            lower.startsWith("mitglieder:") ||
            lower.includes("verkaufsstart") ||
            lower.includes("jetzt kaufen") ||
            lower.includes("ausverkauft") ||
            lower.includes("nicht verfügbar")
          );
        }) ||
        "";

      const id =
        element.getAttribute("data-performanceid") ||
        element.querySelector("[data-performanceid]")?.getAttribute("data-performanceid") ||
        element.getAttribute("data-eventid") ||
        element.querySelector("[data-eventid]")?.getAttribute("data-eventid") ||
        title ||
        `event-${cardIndex + 1}`;

      return {
        id: clean(id),
        title,
        status: clean(status),
      };
    }, index);

    if (!data.title) {
      console.warn(`Karte ${index + 1} ohne Spieltitel übersprungen.`);
      continue;
    }

    if (!data.status) {
      console.warn(`Karte ${index + 1} ohne Ticketstatus übersprungen: ${data.title}`);
      continue;
    }

    events.push(data);
  }

  return events;
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

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  viewport: { width: 1440, height: 1100 },
});

const page = await context.newPage();

try {
  await openTicketPage(page);

  const events = await readEvents(page);

  if (events.length === 0) {
    throw new Error("Keine Veranstaltungskarten mit Ticketstatus ausgelesen.");
  }

  const previous = await loadState();
  const next = {};

  for (const event of events) {
    const id = clean(event.id);
    const title = clean(event.title);
    const status = clean(event.status);

    console.log(`${title} -> ${status}`);

    const oldStatus = normalize(previous[id]?.status);
    const newStatus = normalize(status);

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
