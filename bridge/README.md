# Magnit phone bridge

This bridge provides one owner with a phone sized view of a browser open to the official Magnit website, plus an authenticated HTTP MCP endpoint. It uses the visible Magnit website and browser interactions; it does not call the mobile app's signed API or automate a hidden checkout API. The official website returned `Forbidden` and an automation-check message during initial review, so catalog, authentication, cart, and checkout compatibility remain unverified; this code does not evade that restriction.

## Current scope

- `magnit_open_home` opens `https://magnit.ru/`.
- `magnit_search_products` opens the official site search URL with `term=`, `shopType=`, and optional `shopCode=`. The term route is reported by a public Magnit MCP project as live tested on 2026-08-20; the layout can change.
- `magnit_page_summary` reads visible product-card text and a restricted set of visible button/link references. It never returns screenshots, page HTML, form values, or login/payment page text.
- `magnit_click_reference` can click only a fresh visible reference with the exact text returned by the last page summary. It blocks checkout, order, purchase, and payment actions.
- The phone page shows a protected screenshot of the same browser. The owner enters the Magnit ID phone number and SMS code on Magnit's own page. The bridge never requests, stores, or logs those values as application credentials.
- The browser profile is persistent in a Docker volume so Magnit ID may remain signed in between sessions. Use **Забыть вход** in the phone page and delete the `magnit-profile` volume when you want the account session removed.

The account session and browser profile are sensitive. Deploy one private bridge per owner, keep the data volume private and encrypted at rest where available, and put the service behind HTTPS. This service does not submit the final purchase or payment; the user reviews and confirms those actions manually in the phone browser.

## Experimental Android and Termux mode

This mode runs Node MCP on the Android phone and does not require a VPS, but it relies on Playwright's experimental Android API and has not been validated on a real handset here. Android version, Chrome version, ADB pairing, and Playwright support can affect startup.

1. In Termux install Node, npm, ADB tools, and Git:

   ```sh
   pkg update
   pkg install nodejs-lts npm android-tools git
   ```

2. Install project dependencies without downloading desktop browser binaries:

   ```sh
   cd bridge
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
   ```

3. Enable Android Developer Options → Wireless debugging, pair Termux, then connect using the pairing and connection address/port shown by Android. Do not expose ADB outside the phone. The ADB daemon must be reachable at `127.0.0.1:5037` from Termux.

   ```sh
   adb pair <pair-address-and-port-shown-by-Android>
   adb connect <connect-address-and-port-shown-by-Android>
   adb devices
   ```

4. Install Chrome 105 or later. In Chrome, enable **Enable command line on non-rooted devices**. Keep the screen awake while using the service because screenshot capture needs an active Android display.

5. Run with `BROWSER_MODE=android`. Use the exact serial printed by `adb devices` if multiple devices are connected. Only Chrome and Chrome Beta package names are accepted; the service opens a new tab and doesn't take over existing tabs.

   ```sh
   export BROWSER_MODE=android
   export ANDROID_DEVICE_SERIAL='<serial from adb devices>'
   export ANDROID_CHROME_PACKAGE=com.android.chrome
   export MCP_BEARER_TOKEN='<long random secret>'
   export PHONE_ACCESS_SECRET='<different long random secret>'
   export PUBLIC_BASE_URL='https://<your-https-address>'
   export TRUST_PROXY=1 COOKIE_SECURE=1 HOST=127.0.0.1 PORT=8080
   npm start
   ```

   The Android mode uses the selected Chrome package's shared profile. Sign out of Magnit manually on the official page; the bridge does not erase or clear the shared Android browser profile. Use `com.chrome.beta` when that package is installed.

6. Sites requires a public HTTPS MCP URL. Configure a secure tunnel separately to `http://127.0.0.1:8080`; this project does not expose it automatically. Keep MCP and phone passphrases private, and never publish ADB or DevTools ports.

## Deploy

Use a private Docker host that can run headed Chromium under Xvfb and provides a stable public HTTPS URL. The host must provide outbound access to Magnit's official site and HTTPS termination. A TLS reverse proxy must overwrite `X-Forwarded-For` and forward `Host` and `X-Forwarded-Proto`; do not expose the container port directly to the public internet.

1. Copy `.env.example` to `.env` and set `PUBLIC_BASE_URL` to the final HTTPS address. Set two different random secrets, each at least 32 characters:

   ```sh
   openssl rand -base64 48
   ```

   Put one result in `MCP_BEARER_TOKEN` and a different result in `PHONE_ACCESS_SECRET`. Keep `.env` private and out of source control.

2. Configure the reverse proxy for HTTPS and route the host to the container's port `8080`. The included compose file keeps the container port private and requires the secrets above. Use the host's persistent disk for the `magnit-profile` volume.

3. Build and start:

   ```sh
   docker compose up --build -d
   ```

4. Open `PUBLIC_BASE_URL` on the phone, enter `PHONE_ACCESS_SECRET`, then sign into Magnit ID on the official Magnit page. The browser is 390 × 844 CSS pixels and the screenshot updates every few seconds.

5. Configure the Sites integration with `MCP_BRIDGE_URL` set to `PUBLIC_BASE_URL/mcp` and `MCP_BRIDGE_TOKEN` set to the same value as `MCP_BEARER_TOKEN`. Keep both values in runtime secrets, never in tracked files. If the Site has no bridge configuration, the MCP tools must report setup required.

## MCP

The endpoint is `POST /mcp`, protected by `Authorization: Bearer <MCP_BEARER_TOKEN>`. It implements `server/discover`, `initialize`, `tools/list`, and `tools/call` using stateless JSON-RPC. Only these actions are exposed:

| Tool | Behavior |
| --- | --- |
| `magnit_status` | Report the current safe page address and page type |
| `magnit_open_home` | Open the Magnit home page |
| `magnit_search_products` | Search Magnit's current official catalog page |
| `magnit_page_summary` | Read visible product cards and safe action references |
| `magnit_click_reference` | Click an exact, current visible reference; never submits purchase/payment actions |

The MCP browser cannot navigate to arbitrary URLs, inspect hidden page data, execute JavaScript, inspect credentials, or click final order/payment controls. The phone UI is protected separately with a passphrase, an HttpOnly SameSite cookie, CSRF checks, and rate limits. Configure the proxy to supply only its own trusted `X-Forwarded-For` value.

## Limits

- The official website, authentication flow, product-card markup, store coverage, and availability can change. The implementation currently recognizes the public `article.unit-catalog-product-preview` card selector; it may need updating if Magnit changes its page.
- The remote or Android browser may be denied by Magnit's access controls. The service makes no promise that sign-in, product search, or basket actions will work, and it does not attempt anti-bot workarounds.
- Magnit ID may require additional verification or an in-page challenge. Complete that directly in the protected phone view.
- This is one private browser/profile per deployment, not a multi-user service. Do not make the phone page public or share its access passphrase.
- Checkout preparation may be possible through the visible official page, but MCP deliberately stops before final order/payment actions. Review the exact items, address, delivery method, and total and submit manually in Magnit's browser.

## Local checks

```sh
npm test
```

Tests cover the fixed Magnit navigation/search contract, cross-domain restrictions, purchase-action blocking, secret-field detection, output redaction, constant-time secret comparison, and signed phone-session expiry/tampering. A live login or purchase test requires the owner's Magnit ID session and must be completed manually; this repository does not perform a real order.
