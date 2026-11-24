# immo-erp login flow (captured 2026-11-24)

These notes come from a redacted capture of a real browser login. Only URLs, form field names,
status codes, cookie names and token lifetimes were recorded. No passwords, codes or tokens.

## Summary

| Property | Value |
|---|---|
| IdP | Keycloak `https://<auth-host>`, realm `global`, which brokers to the customer realm `1234567_FIRMA` |
| Client | `<public-client-id>` (public, no secret) |
| Flow | Authorization Code + PKCE (`S256`), `response_mode=fragment` |
| Registered redirect URI | `https://<erp-host>/de/?auth=v2` |
| MFA | **Yes.** A TOTP code (6 digits) follows the password |
| Access token | JWT, valid 12 h (`expires_in=43200`), scope `openid customer_information yuneo_database:1234567_FIRMA_PRD profile email` |
| Refresh token | JWT `typ=Refresh`, valid 10 h (`refresh_expires_in=36000`). No `offline_access` |
| SSO cookie | `KEYCLOAK_SESSION` Max-Age 432000 s (5 days). `KEYCLOAK_IDENTITY` was a session cookie in this capture, because "Angemeldet bleiben" was probably not ticked |
| Device flow | **Disabled** for this client (`unauthorized_client`) |
| Password grant | Not tested. It would not help anyway, because of the TOTP |

## Steps

1. **SPA → global realm**
   `GET /realms/global/protocol/openid-connect/auth?client_id=0A11…&redirect_uri=https://<erp-host>/de/?auth=v2&response_type=code&response_mode=fragment&scope=openid&state&nonce&code_challenge&code_challenge_method=S256`
   This shows the login page "Anmeldung bei global" with only `username` and `rememberMe`.
2. **Home-realm discovery**
   `POST /realms/global/login-actions/authenticate` with the `username` returns
   `303 /realms/global/broker/1234567_FIRMA/login?login_hint=…`.
   Shortcut: passing `kc_idp_hint=1234567_FIRMA` (and `login_hint=<user>`) in step 1 should skip this page.
3. **Customer realm login**
   This goes to `/realms/1234567_FIRMA/protocol/openid-connect/auth` with `client_id=GlobalRealm`.
   The form has `username`, `password`, `rememberMe` and `credentialId`.
4. **TOTP**
   The same `login-actions/authenticate` endpoint returns a form with field `otp`, submitted with `login=Weiter`.
5. **Back to global**
   `/realms/global/broker/1234567_FIRMA/endpoint?code=…` leads to `/realms/global/login-actions/post-broker-login`.
6. **"Auto Persist Tab ID"** (verified by a second capture)
   `GET /realms/global/login-actions/post-broker-login` returns a page titled "Auto Persist Tab ID" whose JS
   reads `sessionStorage.tab_id`, finds nothing, **generates a fresh random UUID**, stores it and auto-posts it
   as the form field `tab_id`. Posting an empty or other value makes Keycloak answer **HTTP 400 "Ungültiger
   Benutzername oder Passwort"**, even though password and TOTP were correct.
7. **Database selection** (verified)
   This is `<form id="kc-scope-selector-form">` with a `<select name="selectedValue">` that choices.js fills from
   an inline JSON array. For the captured account the options were `yuneo_database:1234567_FIRMA_EDU` and
   `yuneo_database:1234567_FIRMA_PRD`. The browser posts `selectedValue=yuneo_database:1234567_FIRMA_PRD` and
   `search_terms=` (empty), which leads to `302 /realms/global/broker/after-post-broker-login`.

   Exact fields the browser sends at each step: global username page `username, rememberMe=on`; customer
   realm `username, password, rememberMe=on, credentialId=` (no `login`); TOTP `otp, login=Weiter`;
   `tab_id=<uuid>`; `selectedValue, search_terms`. The SPA sends **no** `login_hint` and **no** `kc_idp_hint`.
   Skipping the global username step via `kc_idp_hint` is not needed.
8. **Redirect to SPA**
   The browser lands on `https://<erp-host>/de/?auth=v2#state=…&session_state=…&iss=…&code=…`.
9. **Code exchange** (no client secret)
   `POST /realms/global/protocol/openid-connect/token` (form):
   `grant_type=authorization_code, client_id, redirect_uri, code, code_verifier`
10. **Refresh**
   `POST …/token` with `grant_type=refresh_token, client_id, refresh_token`. The refresh token rotates.
   Verified live: a refresh extends the refresh token by another 10 h. A silent re-login with only the stored
   SSO cookies (no refresh token, no password) returns a new code in about 0.7 s. The SSO session ends 5 days
   after the TOTP login (`session_exp`).

## Recommended approach for the MCP server

Because a TOTP is required, a fully headless login with stored credentials is not an option
(it would mean storing the TOTP seed and defeating MFA). Do this instead:

1. **The MCP runs its own PKCE flow** with the public client and the registered redirect URI
   `https://<erp-host>/de/?auth=v2` – exactly like the SPA, without `login_hint`/`kc_idp_hint`.
2. **Interactive login only when needed.** The MCP opens a Playwright window with its own
   persistent profile (for example `~/.wodis-mcp/browser-profile`). The user enters
   password, TOTP and database, ideally with "Angemeldet bleiben" ticked. The MCP intercepts the
   navigation to the redirect URI, reads `code` from the fragment, aborts loading the SPA and
   exchanges the code itself.
3. **Keep the session alive.** Store the access and refresh token with `0600` permissions or in the
   macOS Keychain. Refresh proactively before the 10 h refresh lifetime runs out, then save the rotated
   refresh token.
4. **Silent re-login.** When the refresh token has expired, run the PKCE flow headless with
   `prompt=none` in the persistent profile. While the Keycloak SSO session cookie is valid (up to 5 days
   with "Angemeldet bleiben"), this returns a code without user interaction. Fall back to step 2 on
   `error=login_required`.

Open points to verify while implementing: how long the SSO session lasts at most (the
`session_exp` claim in the access token), whether `prompt=none` skips the database selection, and
whether requesting the scope `yuneo_database:1234567_FIRMA_PRD` skips it as well.
