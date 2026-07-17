import { chromium } from "playwright";
import fs from "node:fs/promises";

const START_URL = "https://tickets.vfb.de/";
const STATE_FILE = "state.json";
const SOLD_OUT_TEXT = "gästebereich ausverkauft";

const requiredEnv = [
  "VFB_USERNAME",
  "VFB_PASSWORD",
  "EMAIL_ENDPOINT",
  "EMAIL_SECRET",
];

for (const name of requiredEnv) {
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

async function clickFirstVisible(page, selectors, description) {
  const locator = await firstVisible(page, selectors);
  if (!locator) {
    throw new Error(`${description} wurde nicht gefunden.`);
  }
  await locator.click();
}

async function fillFirstVisible(page, selectors, value, description) {
  const locator = await firstVisible(page, selectors);
  if (!locator) {
    throw new Error(`${description} wurde nicht gefunden.`);
  }
  await locator.fill(value);
}

async function dismissConsent(page) {
  const selectors = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Zustimmen")',
    'button:has-text("Einverstanden")',
    '[aria-label*="akzeptieren" i]',
  ];

  const button = await firstVisible(page, selectors, 1200);
  if (button) {
    await button.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function isAlreadyLoggedIn(page) {
  const logoutOrAccount = await firstVisible(
    page,
    [
      'text=/Abmelden/i',
      'text=/Mein Konto/i',
      'text=/Meine Tickets/i',
      'text=/Profil/i',
    ],
    1200
  );

  if (logoutOrAccount) {
    return true;
  }

  const loginLink = await firstVisible(
    page,
    [
      'a:has-text("Anmelden")',
      'button:has-text("Anmelden")',
      'a:has-text("Login")',
      'button:has-text("Login")',
    ],
    1200
  );

  return !loginLink;
}

async function openLogin(page) {
  const loginEntry = await firstVisible(page, [
    'a:has-text("Anmelden")',
    'button:has-text("Anmelden")',
    'a:has-text("Login")',
    'button:has-text("Login")',
    'a[href*="login" i]',
    'a[href*="signin" i]',
    'a[href*="account" i]',
    '[aria-label*="anmelden" i]',
    '[aria-label*="login" i]',
  ]);

  if (!loginEntry) {
    throw new Error('Link oder Button "Anmelden" wurde nicht gefunden.');
  }

  await loginEntry.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1200);
  await dismissConsent(page);
}

async function login(page) {
  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await dismissConsent(page);

  if (await isAlreadyLoggedIn(page)) {
    console.log("Bereits eingeloggt – Login wird übersprungen.");
    return;
  }

  console.log('Nicht eingeloggt – klicke auf "Anmelden".');
  await openLogin(page);

  await fillFirstVisible(
    page,
    [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ],
    process.env.VFB_USERNAME,
    "Benutzername-/E-Mail-Feld"
  );

  await fillFirstVisible(
    page,
    [
      'input[type="password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[autocomplete="current-password"]',
    ],
    process.env.VFB_PASSWORD,
    "Passwortfeld"
  );

  await clickFirstVisible(
    page,
    [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Anmelden")',
      'button:has-text("Login")',
      'button:has-text("Einloggen")',
    ],
    "Login-Schaltfläche"
  );

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1800);

  const passwordStillVisible = await firstVisible(
    page,
    [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ],
    1200
  );

  if (passwordStillVisible) {
    throw new Error(
      "Login scheint fehlgeschlagen zu sein. Prüfe Zugangsdaten oder ob CAPTCHA/2FA verlangt wird."
    );
  }

  console.log("Login wurde ausgeführt.");
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
  ]);

  if (!tile) {
    throw new Error('Kachel "Auswärtsspiele" wurde nicht gefunden.');
  }

  await tile.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  await page.waitForSelector(".event-link", {
    timeout: 30_000,
  });
}

async function readEvents(page) {
  return page.locator(".event-link").evaluateAll((buttons) =>
    buttons.map((button, index) => {
      const eventRoot = button.closest(".event");
      const title =
        eventRoot?.querySelector(".event-title")?.textContent?.trim() ||
        button.getAttribute("aria-label")?.trim() ||
        `Spiel ${index + 1}`;

      const status = button.textContent?.replace(/\s+/g, " ").trim() || "";
      const id =
        button.getAttribute("data-performanceid") ||
        button.getAttribute("data-eventid") ||
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
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();

try {
  await login(page);
  await openAwayGames(page);

  const events = await readEvents(page);

  if (events.length === 0) {
    throw new Error("Keine Spiele mit .event-link gefunden.");
  }

  const previous = await loadState();
  const next = { ...previous };

  for (const event of events) {
    const id = clean(event.id);
    const title = clean(event.title);
    const status = clean(event.status);
    const currentNormalized = normalize(status);
    const oldNormalized = normalize(previous[id]?.status);

    console.log(`${title} -> ${status}`);

    const wasSoldOut = oldNormalized.includes(SOLD_OUT_TEXT);
    const isSoldOut = currentNormalized.includes(SOLD_OUT_TEXT);

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
