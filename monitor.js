import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const START_URL = "https://tickets.vfb.de/";
const STATE_FILE = "state.json";
const AUTH_FILE = "auth-state.enc";
const SOLD_OUT_TEXT = "gästebereich ausverkauft";

const requiredEnv = [
  "VFB_USERNAME",
  "VFB_PASSWORD",
  "EMAIL_ENDPOINT",
  "EMAIL_SECRET",
  "VFB_STATE_KEY",
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

function deriveKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptText(plainText, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function decryptText(payload, secret) {
  const parsed = JSON.parse(payload);
  const key = deriveKey(secret);
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");
}

async function loadEncryptedStorageState() {
  try {
    const encrypted = (await fs.readFile(AUTH_FILE, "utf8")).trim();
    if (!encrypted) return null;

    const decrypted = decryptText(encrypted, process.env.VFB_STATE_KEY);
    return JSON.parse(decrypted);
  } catch (error) {
    console.warn("Gespeicherte Sitzung konnte nicht geladen werden:", error.message);
    return null;
  }
}

async function saveEncryptedStorageState(context) {
  const state = await context.storageState();
  const encrypted = encryptText(
    JSON.stringify(state),
    process.env.VFB_STATE_KEY
  );
  await fs.writeFile(AUTH_FILE, `${encrypted}\n`, "utf8");
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

async function clickFirstVisible(page, selectors, description) {
  const locator = await firstVisible(page, selectors);
  if (!locator) throw new Error(`${description} wurde nicht gefunden.`);
  await locator.click();
}

async function fillFirstVisible(page, selectors, value, description) {
  const locator = await firstVisible(page, selectors);
  if (!locator) throw new Error(`${description} wurde nicht gefunden.`);
  await locator.fill(value);
}

async function isLoggedIn(page) {
  const loggedInMarker = await firstVisible(page, [
    'text=/Abmelden/i',
    'text=/Mein Konto/i',
    'text=/Meine Tickets/i',
    'text=/Profil/i',
  ], 1200);

  if (loggedInMarker) return true;

  const loginMarker = await firstVisible(page, [
    'a:has-text("Anmelden")',
    'button:has-text("Anmelden")',
    'a:has-text("Login")',
    'button:has-text("Login")',
  ], 1200);

  return !loginMarker;
}

async function performLogin(page) {
  await dismissConsent(page);

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
  await page.waitForTimeout(1000);

  // Der Consent-Dialog erscheint beim VfB-Shop teilweise erst auf der Loginseite.
  await dismissConsent(page);

  await fillFirstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ], process.env.VFB_USERNAME, "Benutzername-/E-Mail-Feld");

  await fillFirstVisible(page, [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
  ], process.env.VFB_PASSWORD, "Passwortfeld");

  // Falls der Dialog nach dem Ausfüllen erneut eingeblendet wurde.
  await dismissConsent(page);

  await clickFirstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Anmelden")',
    'button:has-text("Login")',
    'button:has-text("Einloggen")',
  ], "Login-Schaltfläche");

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1800);
  await dismissConsent(page);

  const passwordStillVisible = await firstVisible(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ], 1200);

  if (passwordStillVisible) {
    throw new Error(
      "Login scheint fehlgeschlagen zu sein. Prüfe Zugangsdaten oder ob CAPTCHA/2FA verlangt wird."
    );
  }
}

async function ensureLoggedIn(page, context) {
  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await dismissConsent(page);

  if (await isLoggedIn(page)) {
    console.log("Gespeicherte Sitzung ist gültig.");
    return;
  }

  console.log("Keine gültige Sitzung – Login wird ausgeführt.");
  await performLogin(page);
  await saveEncryptedStorageState(context);
  console.log("Neue Sitzung verschlüsselt gespeichert.");
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
  await dismissConsent(page);

  await page.waitForSelector(".event-link", { timeout: 30_000 });
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
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

const storedState = await loadEncryptedStorageState();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  viewport: { width: 1440, height: 1000 },
  ...(storedState ? { storageState: storedState } : {}),
});
const page = await context.newPage();

try {
  await ensureLoggedIn(page, context);
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
  await saveEncryptedStorageState(context);
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
