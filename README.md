# Meesho Return-OTP App (multi-account, auto login)

ECO SKU jevu: Meesho seller email + password thi login → session save → Returns page
mathi courier-wise OTP (Delhivery, Xpressbees, Shadowfax, Valmo) → Account-wise ane
Courier-wise dashboard → "Relogin selected" thi badha account ek sathe fari login.

Aa app **private API guess karti nathi** — e real Chrome (headless) kholi, tame je
page joo chho (supplier.meesho.com → Returns → "More OTPs") e j page vaanche chhe.

## Setup (Windows / Mac / Linux PC ke VPS)

1. Node.js 18+ install karo → https://nodejs.org
2. Aa folder ma terminal kholi:
   ```
   npm run setup      # express + playwright + Chromium install (ek var)
   npm start
   ```
3. Browser ma `http://localhost:3000` kholo.
   Phone mathi vaparva: same Wi-Fi par `http://<PC-no-IP>:3000`
   (24x7 joiye to ₹300–500/month no Ubuntu VPS par chalavo — OTP ne phone
   par gamé tyathi joi shakay).

## Vaparvu

- **Accounts** tab → email + password → **Login**. 30–60 sec ma login thai session save thashe ane OTP aavi jashe.
- Session expire thay to app jaate re-login kare chhe. Na thay to account par
  "Login needed" dekhashe → **Select all → Relogin selected**.
- **OTP** tab → Account-wise / Courier-wise, tap = copy, Refresh all.
- **Schedule** tab → server dar X minute automatic OTP fetch kare (page band hoy to pan).

## Browser mode

- **Hidden** (default): real Chrome chhupa mode ma — koi window nahi. Meesho ene block kare
  to app jaate **Visible** mode ma jai jay chhe (Schedule tab ma badli shakay).
- **Visible**: ek Chrome window khuli rahe chhe — band na karo.
- "Manual login" hamesha visible window ma thay chhe (captcha / SMS-OTP mate).
- VPS (screen vagar) par visible mode joiye to: `xvfb-run npm start`.

## Jo Meesho login vakhte SMS-OTP / captcha maange to

Server PC par `HEADLESS=0 npm start` (Windows: `set HEADLESS=0 && npm start`) chalavo
ane `POST /api/accounts/<id>/manual-login` call karo (ke Accounts ma Relogin dabaavo) —
ek Chrome window khulse, tame OTP/captcha naakhi lo, pachhi session save thai jashe
ane aagal auto-login chalshe.

## Kai kaam na kare to

`data/debug/` ma screenshot save thay chhe (login-failed-*.png, no-otp-*.png,
parse-empty-*.png). E screenshot mane moklo — `meesho.js` ma "SELECTOR" comment
vali 3–4 line badalvi pade.

## Security

- Passwords `data/accounts.json` ma ane sessions `data/sessions/` ma plain save thay chhe.
  Aa folder public server par na muksho; VPS par firewall/ password lagavo.
- Private panel automate karvu Meesho na Terms virudh hoi shake — tamari jawabdari par.
