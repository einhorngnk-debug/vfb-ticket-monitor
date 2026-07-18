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
  await page.waitForTimeout(1500);

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
  await page.waitForTimeout(1200);

  const pageText = normalize(await page.locator("body").innerText());

  if (!pageText.includes("veranstaltungen")) {
    throw new Error("Die Veranstaltungsseite wurde nicht korrekt geladen.");
  }
}

async function readEvents(page) {
  return page.evaluate(() => {
    const clean = (value) =>
      String(value ?? "").replace(/\s+/g, " ").trim();

    const datePattern = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/;
    const result = [];
    const seen = new Set();

    // Nur Blöcke berücksichtigen, die tatsächlich eine Spielkarte darstellen:
    // - enthalten "VfB Stuttgart"
    // - enthalten ein Datum
    // - enthalten genau einen roten Status-/Aktionsbereich am Kartenende
    const allElements = [...document.querySelectorAll("div, article, li, section")];

    for (const element of allElements) {
      const text = clean(element.innerText);

      if (!text.includes("VfB Stuttgart")) continue;
      if (!datePattern.test(text)) continue;

      const childrenWithSamePattern = [...element.children].filter((child) => {
        const childText = clean(child.innerText);
        return childText.includes("VfB Stuttgart") && datePattern.test(childText);
      });

      // Nur den kleinsten passenden Karten-Container nehmen.
      if (childrenWithSamePattern.length > 0) continue;

      const interactive = [...element.querySelectorAll("a, button")];

      const statusNode = interactive.find((node) => {
        const statusText = clean(node.textContent);
        const lower = statusText.toLocaleLowerCase("de-DE");

        if (!statusText) return false;
        if (lower === "tickets") return false;
        if (lower.includes("vip-ticket-shop")) return false;
        if (lower.includes("startseite")) return false;
        if (lower.includes("anmelden")) return false;

        return (
          lower.includes("gästebereich") ||
          lower.startsWith("mitglieder:") ||
          lower.includes("verkaufsstart") ||
          lower.includes("jetzt kaufen") ||
          lower.includes("nicht verfügbar") ||
          lower.includes("ausverkauft")
        );
      });

      if (!statusNode) continue;

      const heading =
        element.querySelector("h1, h2, h3, h4, h5, h6")?.textContent || "";

      const lines = element.innerText
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);

      let title = clean(heading);

      if (!title || !title.includes("VfB Stuttgart")) {
        const vfbLine = lines.find((line) => line.includes("VfB Stuttgart"));
        if (vfbLine) {
          title = vfbLine;
        }
      }

      if (!title) continue;

      const status = clean(statusNode.textContent);

      const idSource =
        statusNode.getAttribute("data-performanceid") ||
        element.getAttribute("data-performanceid") ||
        element.querySelector("[data-performanceid]")?.getAttribute("data-performanceid") ||
        title;

      const id = clean(idSource);

      if (!id || seen.has(id)) continue;
      seen.add(id);

      result.push({ id, title, status });
    }

    return result;
  });
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
    throw new Error("Keine echten Veranstaltungskarten mit Ticketstatus gefunden.");
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
