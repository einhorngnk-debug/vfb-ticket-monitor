import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAGE_URL =
  process.env.PAGE_URL ||
  "https://tickets.vfb.de/shop?wes=empty_session_103&language=1&shopid=103&nextstate=2&lpShortcutId=4";

const EMAIL_ENDPOINT = process.env.EMAIL_ENDPOINT || "";
const EMAIL_SECRET = process.env.EMAIL_SECRET || "";

const STATE_FILE = path.join(__dirname, "state.json");
const SOLD_OUT_TEXT = "Gästebereich ausverkauft";

function clean(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(value) {
  return clean(value).replace(/\s*!+\s*$/, "");
}

function isSoldOut(status) {
  return normalizeStatus(status)
    .toLocaleLowerCase("de-DE")
    .includes(SOLD_OUT_TEXT.toLocaleLowerCase("de-DE"));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    console.warn(`state.json konnte nicht gelesen werden: ${error.message}`);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function closeCookieDialog(page) {
  const candidates = [
    page.getByRole("button", { name: /alle akzeptieren/i }),
    page.getByRole("button", { name: /akzeptieren/i }),
    page.getByRole("button", { name: /zustimmen/i }),
    page.getByRole("button", { name: /einverstanden/i }),
    page.locator("#onetrust-accept-btn-handler"),
    page.locator('[data-testid*="accept"]'),
  ];

  for (const candidate of candidates) {
    try {
      const button = candidate.first();

      if (await button.isVisible({ timeout: 1200 })) {
        await button.click({ timeout: 3000 });
        console.log("Cookie-Dialog geschlossen.");
        return;
      }
    } catch {
      // Nächsten möglichen Button prüfen.
    }
  }

  console.log("Kein sichtbarer Cookie-Dialog gefunden.");
}

async function readEvents(page) {
  const selector = ".events .event-container";

  await page.waitForSelector(selector, {
    state: "attached",
    timeout: 30000,
  });

  return page.locator(selector).evaluateAll((cards) => {
    const cleanText = (value) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return cards
      .map((card) => {
        const home = cleanText(
          card.querySelector(".event-title .text-home")?.textContent
        );

        const delimiter =
          cleanText(
            card.querySelector(".event-title .text-delimiter")?.textContent
          ) || "-";

        const guest = cleanText(
          card.querySelector(".event-title .text-guest")?.textContent
        );

        let title = [home, delimiter, guest].filter(Boolean).join(" ");

        let structuredData = null;

        try {
          const json = card.querySelector(
            'script[type="application/ld+json"]'
          )?.textContent;

          if (json) {
            structuredData = JSON.parse(json);
          }
        } catch {
          structuredData = null;
        }

        if (!home || !guest) {
          const structuredTitle = cleanText(structuredData?.name);

          if (structuredTitle) {
            title = structuredTitle.replace(
              /(\S)-(?=VfB Stuttgart\b)/,
              "$1 - "
            );
          }
        }

        /*
         * Verkaufsstatus ausschließlich aus dem Event-Button lesen.
         * Andere Kartentexte wie ÖPNV-Hinweise werden dadurch ignoriert.
         */
        const status =
          cleanText(
            card.querySelector(".event-footer .event-button a b")?.textContent
          ) ||
          cleanText(
            card.querySelector(".event-footer .event-button a")?.textContent
          );

        const button = card.querySelector(
          ".event-footer .event-button a"
        );

        const relativeHref = button?.getAttribute("href") || "";
        const eventId = button?.getAttribute("data-eventid") || "";

        let pageUrl = cleanText(structuredData?.url);

        if (!pageUrl && relativeHref) {
          try {
            pageUrl = new URL(relativeHref, window.location.href).href;
          } catch {
            pageUrl = window.location.href;
          }
        }

        return {
          eventId: cleanText(eventId),
          title: cleanText(title),
          status: cleanText(status),
          pageUrl: cleanText(pageUrl || window.location.href),
        };
      })
      .filter(
        (event) =>
          event.title &&
          event.status &&
          event.title.includes("VfB Stuttgart")
      );
  });
}

async function sendEmail({ title, oldStatus, newStatus, pageUrl }) {
  if (!EMAIL_ENDPOINT || !EMAIL_SECRET) {
    console.warn(
      `Keine E-Mail gesendet: EMAIL_ENDPOINT oder EMAIL_SECRET fehlt (${title}).`
    );
    return false;
  }

  const url = new URL(EMAIL_ENDPOINT);
  url.searchParams.set("secret", EMAIL_SECRET);
  url.searchParams.set("eventName", title);
  url.searchParams.set("status", `${oldStatus} -> ${newStatus}`);
  url.searchParams.set("pageUrl", pageUrl || PAGE_URL);

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `E-Mail-Endpunkt antwortete mit HTTP ${response.status}: ${body.slice(
        0,
        300
      )}`
    );
  }

  console.log(`E-Mail gesendet: ${title}`);
  return true;
}

function buildStateKey(event) {
  return event.eventId ? `event-${event.eventId}` : event.title;
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      locale: "de-DE",
      viewport: { width: 1440, height: 1200 },
    });

    console.log(`Öffne: ${PAGE_URL}`);

    await page.goto(PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await closeCookieDialog(page);

    await page
      .waitForLoadState("networkidle", {
        timeout: 15000,
      })
      .catch(() => {
        console.log(
          "Networkidle nicht erreicht; die bereits geladene Seite wird ausgewertet."
        );
      });

    const events = await readEvents(page);

    console.log(`${events.length} Veranstaltungskarte(n) gefunden.`);

    if (events.length === 0) {
      throw new Error(
        "Keine VfB-Auswärtsveranstaltungen gefunden. state.json wird nicht verändert."
      );
    }

    for (const event of events) {
      console.log(`${event.title} -> ${event.status}`);
    }

    const previousState = loadState();
    const nextState = {};
    const notifications = [];

    for (const event of events) {
      const key = buildStateKey(event);
      const previous = previousState[key];

      const oldStatus =
        typeof previous === "string" ? previous : previous?.status || "";

      nextState[key] = {
        eventId: event.eventId,
        title: event.title,
        status: event.status,
        pageUrl: event.pageUrl,
        checkedAt: new Date().toISOString(),
      };

      /*
       * Benachrichtigung nur beim gewünschten Übergang:
       * vorher ausverkauft, jetzt ein anderer Status.
       *
       * Beim ersten Lauf wird nur state.json angelegt.
       */
      if (
        oldStatus &&
        isSoldOut(oldStatus) &&
        !isSoldOut(event.status)
      ) {
        notifications.push({
          title: event.title,
          oldStatus,
          newStatus: event.status,
          pageUrl: event.pageUrl,
        });
      }
    }

    saveState(nextState);
    console.log("state.json aktualisiert.");

    if (notifications.length === 0) {
      console.log(
        "Keine Änderung von „Gästebereich ausverkauft“ zu einem anderen Status."
      );
      return;
    }

    for (const notification of notifications) {
      await sendEmail(notification);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Monitor fehlgeschlagen:");
  console.error(error);
  process.exitCode = 1;
});
