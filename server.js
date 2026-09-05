const express = require("express");
const fs = require("fs");
const path = require("path");
const meesho = require("./meesho");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data", "accounts.json");
const load = () => { try { return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch { return []; } };
const saveAll = (l) => fs.writeFileSync(DATA, JSON.stringify(l, null, 2));
const pub = ({ password, ...a }) => ({ ...a, hasSession: meesho.hasSession(a.id) });
const patch = (id, changes) => { const l = load(); const a = l.find((x) => x.id === id); if (a) Object.assign(a, changes); saveAll(l); return a; };

const cache = {}; // id -> { otps, fetchedAt, error }
let settings = { intervalMin: 10 };
const PARALLEL = 3; // Chrome tabs fetched at the same time

// small concurrency limiter
async function runAll(items, fn) {
  const q = [...items]; const workers = [];
  for (let i = 0; i < PARALLEL; i++) workers.push((async () => { while (q.length) await fn(q.shift()); })());
  await Promise.all(workers);
}

async function doLogin(account, opts) {
  patch(account.id, { status: "logging_in", lastError: null });
  try {
    const { otps, storeName, ...info } = await meesho.login(account, opts);
    if (otps && otps.length) cache[account.id] = { otps, fetchedAt: Date.now(), error: null };
    const changes = { ...info, status: "ok", lastLogin: Date.now(), lastError: null };
    if (storeName) { changes.storeName = storeName; if (account.autoName !== false) changes.name = storeName; }
    return patch(account.id, changes);
  } catch (e) {
    return patch(account.id, { status: "error", lastError: shortErr(e) });
  }
}
const shortErr = (e) => String(e.message || e).split("\n")[0].replace(/Call log:.*$/s, "").trim().slice(0, 180);

async function doFetch(account, allowRelogin = true) {
  try {
    const { otps, storeName } = await meesho.fetchOtps(account);
    cache[account.id] = { otps, fetchedAt: Date.now(), error: null };
    const changes = { status: "ok", lastError: null, slug: account.slug };
    if (storeName) { changes.storeName = storeName; if (account.autoName !== false) changes.name = storeName; }
    patch(account.id, changes);
  } catch (e) {
    if (e.needsLogin && allowRelogin) {
      const fresh = await doLogin(account);
      if (fresh.status === "ok") { if (cache[account.id]?.otps?.length) return; return doFetch({ ...account, ...fresh }, false); }
    }
    cache[account.id] = { otps: cache[account.id]?.otps || [], fetchedAt: Date.now(), error: shortErr(e) };
    patch(account.id, { status: e.needsLogin ? "needs_login" : "error", lastError: shortErr(e) });
  }
}

function view() {
  const accounts = load();
  const byAccount = accounts.map((a) => ({ ...pub(a), otps: cache[a.id]?.otps || [], fetchedAt: cache[a.id]?.fetchedAt || null, error: cache[a.id]?.error || null }));
  const map = {};
  for (const a of byAccount) for (const o of a.otps) {
    (map[o.carrier] ??= { carrier: o.carrier, totalReturns: 0, entries: [] });
    map[o.carrier].totalReturns += o.count;
    map[o.carrier].entries.push({ accountId: a.id, accountName: a.name, email: a.email, otp: o.otp, count: o.count, time: o.time });
  }
  const byCarrier = Object.values(map).sort((x, y) => y.totalReturns - x.totalReturns);
  return { byAccount, byCarrier, totalReturns: byCarrier.reduce((s, c) => s + c.totalReturns, 0), settings: { ...settings, browserMode: meesho.getMode() } };
}

// ---------- accounts ----------
app.get("/api/accounts", (req, res) => res.json(load().map(pub)));

app.post("/api/accounts", async (req, res) => {
  const { email, password, name, returnsUrl } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  const list = load();
  if (list.some((a) => a.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: "This email is already added" });
  const slug = (returnsUrl || "").match(/fulfillment\/([^/]+)\/returns/)?.[1] || "";
  const account = { id: String(Date.now()), name: name || email.split("@")[0], autoName: !name, email, password, slug, supplierId: "", status: "new", addedAt: Date.now() };
  list.push(account); saveAll(list);
  const after = await doLogin(account); // hidden; use 'Manual login' if Meesho asks for SMS-OTP/captcha
  if (after.status === "ok" && !cache[account.id]?.otps?.length) await doFetch({ ...account, ...after }, false);
  res.status(201).json(pub(load().find((a) => a.id === account.id)));
});

app.put("/api/accounts/:id", (req, res) => {
  const { name, password, returnsUrl } = req.body || {};
  const changes = {};
  if (name) { changes.name = name; changes.autoName = false; }
  if (password) changes.password = password;
  if (returnsUrl) changes.slug = returnsUrl.match(/fulfillment\/([^/]+)\/returns/)?.[1] || "";
  const a = patch(req.params.id, changes);
  a ? res.json(pub(a)) : res.status(404).json({ error: "Not found" });
});

app.delete("/api/accounts/:id", (req, res) => {
  saveAll(load().filter((a) => a.id !== req.params.id));
  meesho.clearSession(req.params.id); delete cache[req.params.id];
  res.json({ ok: true });
});

// Relogin selected (or all) accounts, then fetch their OTPs
app.post("/api/accounts/relogin", async (req, res) => {
  const ids = req.body?.ids;
  const targets = load().filter((a) => !ids || ids.includes(a.id));
  await runAll(targets, async (a) => { const r = await doLogin(a); if (r.status === "ok" && !cache[a.id]?.otps?.length) await doFetch({ ...a, ...r }, false); });
  res.json(view());
});

// Same as relogin, but waits up to 5 min so you can finish captcha / SMS-OTP in the Chrome window
app.post("/api/accounts/:id/manual-login", async (req, res) => {
  const a = load().find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const r = await doLogin(a, { interactive: true });
  if (r.status === "ok" && !cache[a.id]?.otps?.length) await doFetch({ ...a, ...r }, false);
  res.json(view());
});

// ---------- OTPs ----------
app.get("/api/otps", (req, res) => res.json(view()));

app.post("/api/refresh", async (req, res) => {
  const id = req.body?.accountId;
  const targets = load().filter((a) => !id || a.id === id);
  await runAll(targets, (a) => doFetch(a));
  res.json(view());
});

// ---------- schedule ----------
let timer = null;
function schedule() {
  clearInterval(timer);
  if (settings.intervalMin > 0) timer = setInterval(() => runAll(load(), (a) => doFetch(a)).catch(() => {}), settings.intervalMin * 60000);
}
app.get("/api/settings", (req, res) => res.json({ ...settings, browserMode: meesho.getMode() }));
app.post("/api/settings/browser-mode", (req, res) => { const m = req.body?.mode; if (m === "hidden" || m === "visible") meesho.setMode(m); res.json({ browserMode: meesho.getMode() }); });
app.post("/api/settings", (req, res) => {
  const m = parseInt(req.body?.intervalMin); if (!isNaN(m) && m >= 0) settings.intervalMin = m;
  schedule(); res.json(settings);
});
schedule();

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Meesho OTP app → http://localhost:${PORT}  (open from phone: http://<this-PC-IP>:${PORT})`));
