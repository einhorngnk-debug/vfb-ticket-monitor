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

const clean = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const normalize = (value) =>
  clean(value).toLocaleLowerCase("de-DE");

async function closeCookieDialog(page) {
  await page.waitForTimeout(1800);

  for (let attempt = 1; attempt <= 10; attempt++) {
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
            await page.waitForTimeout(800);
            return;
          }
        } catch {
          // Weiter versuchen.
        }
      }
    }

    const clickedShadow = await page.evaluate(() => {
      const wanted = /^(alle akzeptieren|ablehnen)$/i;

      function walk(root) {
        for (const element of root.querySelectorAll("*")) {
          const text = (element.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const label = (element.getAttribute?.("aria-label") || "").trim();
          const value = (element.getAttribute?.("value") || "").trim();
          const clickable =
            ["BUTTON", "A", "INPUT"].includes(element.tagName) ||
            element.getAttribute?.("role") === "button";

          if (
            clickable &&
            (wanted.test(text) || wanted.test(label) || wanted.test(value))
          ) {
            element.click();
            return true;
          }

          if (element.shadowRoot && walk(element.shadowRoot)) {
            return true;
          }
        }
        return false;
      }

      return walk(document);
    }).catch(() => false);

    if (clickedShadow) {
      await page.waitForTimeout(800);
      return;
    }

    await page.waitForTimeout(500);
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
      await page.waitForTimeout(1000);
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
  await page.waitForTimeout(1500);

  const pageText = normalize(await page.locator("body").innerText());

  if (!pageText.includes("veranstaltungen")) {
    throw new Error("Die Veranstaltungsseite wurde nicht korrekt geladen.");
  }

  if (
    !pageText.includes("gästebereich") &&
    !pageText.includes("mitglieder:") &&
    !pageText.includes("vfb stuttgart")
  ) {
    throw new Error(
      "Auf der direkten Ticketseite wurden keine Auswärtsspiel-Informationen gefunden."
    );
  }
}

async function readEvents(page) {
  return page.evaluate(() => {
    const clean = (value) =>
      String(value ?? "").replace(/\s+/g, " ").trim();

    const result = [];
    const seen = new Set();

    const statusNodes = [...document.querySelectorAll("a, button")].filter((el) => {
      const text = clean(el.textContent).toLocaleLowerCase("de-DE");
      return (
        text.includes("gästebereich") ||
        text.startsWith("mitglieder:") ||
        text.includes("verkaufsstart") ||
        text.includes("ticket")
      );
    });

    for (const [index, statusNode] of statusNodes.entries()) {
      let root =
        statusNode.closest("[data-performanceid]") ||
        statusNode.closest(".event") ||
        statusNode.closest("article") ||
        statusNode.closest("li") ||
        statusNode.parentElement;

      // Nach oben laufen, bis ein Block mit Gegner und Datum gefunden wird.
      let probe = root;
      for (let i = 0; i < 6 && probe; i++, probe = probe.parentElement) {
        const text = clean(probe.innerText);
        if (
          text.includes("VfB Stuttgart") &&
          /\d{1,2}\.\d{1,2}\.\d{4}/.test(text)
        ) {
          root = probe;
          break;
        }
      }

      const blockText = clean(root?.innerText);
      const lines = blockText
        .split(/\n+/)
        .map(clean)
        .filter(Boolean);

      let title =
        root?.querySelector(".event-title")?.textContent ||
        root?.querySelector("h1, h2, h3, h4")?.textContent ||
        "";

      title = clean(title);

      if (!title) {
        const opponentLines = lines.filter(
          (line) =>
            line !== "VfB Stuttgart" &&
            !line.includes("Gästebereich") &&
            !line.startsWith("Mitglieder:") &&
            !/\d{1,2}\.\d{1,2}\.\d{4}/.test(line) &&
            !line.includes("Bundesliga") &&
            !line.includes("DFB-Pokal") &&
            line.length > 3 &&
            line.length < 100
        );

        title = opponentLines[0]
          ? `${opponentLines[0]} - VfB Stuttgart`
          : `Auswärtsspiel ${index + 1}`;
      }

      const status = clean(statusNode.textContent);
      const id =
        statusNode.getAttribute("data-performanceid") ||
        root?.getAttribute?.("data-performanceid") ||
        statusNode.getAttribute("href") ||
        `${title}-${index}`;

      if (!status || seen.has(id)) continue;
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
    throw new Error("Keine Ticketstatus auf der direkten Ticketseite gefunden.");
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
