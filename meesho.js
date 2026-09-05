/**
 * meesho.js — logs in to supplier.meesho.com (email + password) with real Chrome,
 * saves the session per account, and reads the Returns-page OTP widget.
 *
 * Browser mode:
 *   "hidden"  = real Chrome in new-headless mode (no window). Tried first.
 *   "visible" = a normal Chrome window. Used automatically if Meesho blocks hidden mode,
 *               and always for 'Manual login' (captcha / SMS-OTP).
 * Lines marked "SELECTOR" are the ones to adjust if Meesho changes its layout.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "https://supplier.meesho.com";
const LOGIN_URL = BASE + "/panel/v3/new/root/login";
const DATA_DIR = path.join(__dirname, "data");
const SESS_DIR = path.join(DATA_DIR, "sessions");
const DEBUG_DIR = path.join(DATA_DIR, "debug");
const MODE_FILE = path.join(DATA_DIR, "browser-mode.json");
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const sessionFile = (id) => path.join(SESS_DIR, `${id}.json`);
const hasSession = (id) => fs.existsSync(sessionFile(id));
const clearSession = (id) => { try { fs.unlinkSync(sessionFile(id)); } catch {} };
const returnsUrl = (slug) => `${BASE}/panel/v3/new/fulfillment/${slug}/returns/overview`;
const isLoginPage = (url) => /\/login|\/signin|\/auth/i.test(url) || /\/root\/?$/.test(url) || url.replace(/\/$/, "") === BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ BROWSER
let mode = process.env.BROWSER_MODE || (() => { try { return JSON.parse(fs.readFileSync(MODE_FILE, "utf8")).mode; } catch { return "hidden"; } })();
function setMode(m) { mode = m; try { fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m })); } catch {} console.log(`[browser] mode → ${m}`); }

const browsers = { hidden: null, visible: null };
const ARGS = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--window-size=1366,900",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const OFFSCREEN = process.env.BROWSER_ONSCREEN !== "1"; // visible-mode window is parked off-screen (out of sight) unless BROWSER_ONSCREEN=1

async function launch(visible) {
  const channels = [process.env.BROWSER_CHANNEL, "chrome", "msedge", null].filter((c, i, a) => c !== undefined && a.indexOf(c) === i);
  let lastErr;
  for (const channel of channels) {
    try {
      const args = visible && OFFSCREEN ? [...ARGS, "--window-position=-32000,-32000"] : ARGS;
      const b = await chromium.launch({ headless: !visible, args, ...(channel ? { channel } : {}) });
      console.log(`[browser] launched ${channel || "bundled chromium"} (${visible ? "visible window" : "hidden"})`);
      return b;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
function getBrowser(visible) {
  const key = visible ? "visible" : "hidden";
  if (!browsers[key]) {
    browsers[key] = launch(visible).then((b) => { b.on("disconnected", () => { browsers[key] = null; }); return b; })
      .catch((e) => { browsers[key] = null; throw e; });
  }
  return browsers[key];
}

async function newContext(account, visible) {
  const browser = await getBrowser(visible);
  const opts = { viewport: { width: 1366, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" };
  if (hasSession(account.id)) opts.storageState = sessionFile(account.id);
  const context = await browser.newContext(opts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  return context;
}

async function dumpDebug(page, name) {
  try { await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(DEBUG_DIR, `${name}.html`), await page.content()); } catch {}
}

/** Brings the (off-screen) Chrome window on-screen for the user, or parks it back off-screen. */
async function moveWindow(page, onScreen) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const bounds = onScreen ? { left: 60, top: 40, width: 1366, height: 900, windowState: "normal" } : { left: -32000, top: -32000, windowState: "normal" };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds });
    if (onScreen) await page.bringToFront().catch(() => {});
    await cdp.detach().catch(() => {});
  } catch {}
}

/** Best-effort close of promo popups ("Update Now!", "Abhi Opt-in Karo!" …). Never waits long. */
async function dismissPopups(page) {
  try {
    await page.keyboard.press("Escape");
    await sleep(300);
    // SELECTOR: popup containers
    const boxes = page.locator('[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="overlay" i]');
    for (const box of (await boxes.all()).slice(0, 4)) {
      if (!(await box.isVisible().catch(() => false))) continue;
      const txt = await box.innerText().catch(() => "");
      if (/OTP:/.test(txt)) continue; // that's the OTP list — keep it
      // SELECTOR: close control = aria-label close, close icon, or an icon-only button (the X)
      let x = box.locator('button[aria-label*="close" i], [data-testid*="close" i], svg[data-testid="CloseIcon"]').first();
      if (!(await x.count())) x = box.locator('button, [role="button"]').filter({ hasNotText: /\S/ }).first();
      if (await x.count()) { await x.click({ timeout: 1500, force: true }).catch(() => {}); await sleep(400); }
    }
  } catch {}
}

// ------------------------------------------------------------------ LOGIN
/** Fills "Email Id or mobile number" + "Password" and presses "Log in". Returns false if the form isn't there. */
async function fillLoginForm(page, account) {
  const pass = page.locator('input[type="password"]').first();                          // SELECTOR
  const ok = await pass.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  if (!ok) return false;
  let email = page.locator('input[name="emailOrPhone"]').first();                         // SELECTOR (floating label sits on top → never click it)
  if (!(await email.count())) email = page.locator('input[type="text"], input[type="email"]').first();
  await email.focus(); await email.fill(""); await email.pressSequentially(account.email, { delay: 10 });
  await pass.focus(); await pass.fill(""); await pass.pressSequentially(account.password, { delay: 10 });
  await sleep(400);
  const btn = page.locator('button:has-text("Log in"), button:has-text("Login"), button[type="submit"]').first(); // SELECTOR
  if (!(await btn.isEnabled().catch(() => false))) { await pass.press("Tab"); await sleep(500); }
  if (await btn.isEnabled().catch(() => false)) {
    await btn.click({ timeout: 4000 }).catch(() => btn.click({ force: true, timeout: 3000 })).catch(() => pass.press("Enter"));
  } else await pass.press("Enter");
  return true;
}

/**
 * Logs in and reads OTPs right away. interactive=true → visible window, waits up to 5 min for captcha / SMS-OTP.
 * Resolves { slug, supplierId, otps }.
 */
async function login(account, { interactive = false } = {}) {
  const visible = interactive || mode === "visible";
  clearSession(account.id);
  const context = await newContext(account, visible);
  const page = await context.newPage();
  try {
    if (interactive) await moveWindow(page, true);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(800);
    const filled = await fillLoginForm(page, account);
    if (!filled) {
      await dumpDebug(page, `login-form-not-found-${account.id}`);
      if (!visible) {
        // hidden Chrome got blocked → switch to a visible window permanently and retry once
        await context.close().catch(() => {});
        setMode("visible");
        return login(account, { interactive });
      }
      if (!interactive) throw new Error("Meesho login form not found (see data/debug). Try 'Manual login'.");
    }

    const deadline = Date.now() + (interactive ? 5 * 60 * 1000 : 40000);
    while (Date.now() < deadline) {
      await sleep(500);
      if (page.isClosed()) throw new Error("The Chrome tab was closed before login finished.");
      if (!isLoginPage(page.url())) break;
      const txt = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      if (/invalid|incorrect|wrong password|not registered|does not exist/.test(txt))
        throw new Error("Meesho says the email or password is wrong.");
      if (!interactive && /enter otp|verification code|otp sent|captcha/.test(txt))
        throw new Error("Meesho is asking for SMS-OTP/captcha. Use 'Manual login' and complete it in the Chrome window.");
    }
    if (isLoginPage(page.url())) {
      await dumpDebug(page, `login-failed-${account.id}`);
      throw new Error("Login did not complete (screenshot saved in data/debug).");
    }

    // logged in → grab the store name from Home, then go straight to Returns
    const info = await discover(page, account);
    await sleep(800);
    info.storeName = await readStoreName(page);
    let otps = [];
    if (info.slug) {
      try { otps = await readOtpsOnPage(page, { ...account, ...info }); } catch (e) { console.log("[otp after login]", e.message); }
    }
    await context.storageState({ path: sessionFile(account.id) });
    return { ...info, otps };
  } catch (e) {
    if (!page.isClosed()) await dumpDebug(page, `login-error-${account.id}`).catch(() => {});
    throw e;
  } finally {
    if (interactive && !page.isClosed()) await moveWindow(page, false);
    await context.close().catch(() => {});
  }
}

/** Reads the store name from the panel ("Welcome back, SPARROW PRIME" on Home, or the sidebar header). */
async function readStoreName(page) {
  try {
    const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const m = body.match(/Welcome back,\s*([^\n]+)/i);                                  // SELECTOR: Home greeting
    if (m) return m[1].trim();
    const side = await page.locator('aside, nav, [class*="sidebar" i]').first().innerText({ timeout: 3000 }).catch(() => "");
    const first = side.split("\n").map((t) => t.trim()).find((t) => t && !/notices|support/i.test(t));
    return first || "";
  } catch { return ""; }
}
const homeUrl = (slug) => `${BASE}/panel/v3/new/growth/${slug}/home`;

/** Finds the Returns-page slug (…/fulfillment/<slug>/returns/…) and, if possible, the supplier id. */
async function discover(page, account) {
  let slug = account.slug || "";
  let supplierId = account.supplierId || "";
  try {
    if (!slug) {
      for (let i = 0; i < 20 && !slug; i++) { // the post-login redirect lands on /panel/v3/new/<module>/<slug>/...
        const m = page.url().match(/\/panel\/v3\/new\/(?!root\b)[^/]+\/([a-z0-9]{3,12})\//i);
        if (m) slug = m[1]; else await sleep(500);
      }
    }
    if (!slug) {
      const href = await page.locator('a[href*="/returns"]').first().getAttribute("href", { timeout: 6000 }).catch(() => null);
      let m = href && href.match(/fulfillment\/([^/]+)\/returns/);
      if (!m) {
        await dismissPopups(page);
        await page.locator('text=/^Returns$/').first().click({ timeout: 6000, force: true }).catch(() => {}); // SELECTOR: side-nav "Returns"
        await page.waitForURL(/\/returns/, { timeout: 10000 }).catch(() => {});
        m = page.url().match(/fulfillment\/([^/]+)\/returns/);
      }
      if (m) slug = m[1];
    }
    if (!supplierId) {
      supplierId = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          const m = (localStorage.getItem(k) || "").match(/"?supplier_?id"?\s*[:=]\s*"?(\d{4,9})/i);
          if (m) return m[1];
        }
        return "";
      }).catch(() => "");
    }
  } catch {}
  return { slug, supplierId };
}

// ------------------------------------------------------------------ OTPs
/** Reads OTPs for one account using its saved session (no login). Returns { otps, storeName }. Throws .needsLogin=true if the session expired. */
async function fetchOtps(account) {
  if (!hasSession(account.id)) { const e = new Error("Not logged in"); e.needsLogin = true; throw e; }
  const context = await newContext(account, mode === "visible");
  const page = await context.newPage();
  try {
    const target = account.slug ? returnsUrl(account.slug) : BASE + "/panel/v3/new/root/home";
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1000);
    if (isLoginPage(page.url())) { const e = new Error("Session expired"); e.needsLogin = true; throw e; }
    if (!account.slug) {
      const info = await discover(page, account);
      if (!info.slug) throw new Error("Could not find the Returns page. Paste your returns URL in the account settings.");
      account.slug = info.slug;
    }
    let storeName = "";
    if (!account.storeName) {                       // one-time: read the store name from Home
      if (!page.url().includes("/home")) await page.goto(homeUrl(account.slug), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await sleep(1200);
      storeName = await readStoreName(page);
    }
    const otps = await readOtpsOnPage(page, account);
    await context.storageState({ path: sessionFile(account.id) });
    return { otps, storeName };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Assumes a logged-in page; opens the Returns overview and parses the OTP widget + "More OTPs" list. */
async function readOtpsOnPage(page, account) {
  const url = returnsUrl(account.slug);
  if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (isLoginPage(page.url())) { const e = new Error("Session expired"); e.needsLogin = true; throw e; }

  const widget = page.locator("text=/OTP:/").first();                                       // SELECTOR: "<Courier> OTP:"
  const found = await widget.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  if (!found) { await dumpDebug(page, `no-otp-${account.id}`); return []; }

  let listText = "";
  const more = page.locator("text=/More OTPs/i").first();                                    // SELECTOR: "More OTPs (n)"
  if (await more.count()) {
    await dismissPopups(page);
    await more.click({ timeout: 3000, force: true }).catch(() => more.dispatchEvent("click").catch(() => {}));
    await page.locator("text=/More OTPs \\(\\d+\\)/").first().waitFor({ timeout: 5000 }).catch(() => {});
    await sleep(600);
    listText = await page.locator('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="sheet" i], [class*="popup" i]')
      .filter({ hasText: /OTP:/ }).last().innerText().catch(() => "");
  }
  const bodyText = await page.locator("body").innerText();
  const otps = mergeOtps(parseOtps(listText), parseOtps(bodyText));
  if (!otps.length) await dumpDebug(page, `parse-empty-${account.id}`);
  return otps;
}

function mergeOtps(a, b) {
  const out = [...a];
  for (const o of b) if (!out.some((x) => x.carrier === o.carrier && x.otp === o.otp)) out.push(o);
  return out;
}

/** Parses "<Courier> OTP: 7237  3 Sept, 01:57 AM ... Total Handover Count : 1" blocks. */
function parseOtps(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z ]{1,30}?)\s+OTP:\s*(\d{3,8})\s*([^\n]*)?\n[\s\S]*?Total Handover Count\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(text || ""))) {
    const carrier = m[1].trim().replace(/\s+/g, " ").replace(/^Xpress Bees$/i, "Xpressbees");
    if (out.some((o) => o.carrier === carrier && o.otp === m[2])) continue;
    out.push({ carrier, otp: m[2], time: (m[3] || "").trim(), count: parseInt(m[4], 10) || 0 });
  }
  return out;
}

module.exports = { login, fetchOtps, hasSession, clearSession, parseOtps, getMode: () => mode, setMode };
