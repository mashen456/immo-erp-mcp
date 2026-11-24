# immo-erp – read-only TypeScript client

A typed, **read-only** client for the internal REST API behind the immo-erp web app
(`https://<erp-host>`). It covers property stock, units, rental contracts and tenants.

All data calls are `GET`. The only other request is the optional Keycloak
token refresh, which changes no business data. The client exposes no
create, update or delete calls.

## Setup

```bash
npm install
export WODIS_ACCESS_TOKEN='eyJhbGciOi...'     # required (Bearer JWT, without "Bearer ")
export WODIS_REFRESH_TOKEN='eyJhbGciOi...'    # optional, enables auto-renewal
npx tsx api_client.ts                          # runs the example walkthrough
```

| Env var | Meaning |
|---|---|
| `WODIS_ACCESS_TOKEN` | Keycloak access token. Valid for about 12 h. |
| `WODIS_REFRESH_TOKEN` | Keycloak refresh token. Valid for about 10 h. Used on expiry or 401/403. |
| `WODIS_COOKIE` | Optional raw `Cookie` header. Not needed in testing. |
| `WODIS_BASE_URL` | Default `https://<erp-host>`. |
| `WODIS_MANDANT` | Optional default Mandant filter for list calls, e.g. `1040` or `1040,1010`. |

You can also pass a config object instead of using env vars:

```ts
import { WodisYuneoClient } from './api_client.ts';
const client = new WodisYuneoClient({
  accessToken, refreshToken,
  mandantNummern: [1040],
  onTokenRefresh: (t) => saveSomewhere(t.access_token, t.refresh_token),
});
```

### Getting a token

1. Log in to immo-erp in Chrome.
2. Open DevTools → Network and select any `/api/...` request.
3. Copy the value of the `authorization` request header without the `Bearer ` prefix.

Getting a refresh token is harder. The SPA uses Keycloak's PKCE flow and keeps the
refresh token in memory, so the easiest source is the response of
`POST <auth-host>/realms/global/protocol/openid-connect/token` in the
Network tab (`refresh_token` field).

## Auth details (observed)

* OIDC Authorization Code + PKCE against `https://<auth-host>/realms/global`.
  The public client id is `<public-client-id>`.
* The token scope carries the database (`yuneo_database:<debitor>_<NAME>_PRD`), so the
  token alone selects the tenant database. No extra tenant header is needed.
* Every API call sends `Authorization: Bearer <jwt>` and `locale_id: de`. The client sends both.
  Mandant scoping is done per request with the `mandantNummern=` query parameter.
* Refresh: `grant_type=refresh_token&client_id=<above>&refresh_token=...` (form-encoded).
  The client does this automatically when the JWT has less than 60 s left, or on 401/403.

## Endpoints

Base: `https://<erp-host>/api`

| Method | Endpoint | Client method |
|---|---|---|
| GET | `/querschnitt/private/mandanteninfrastruktur` | `getMandanten()` |
| GET | `/querschnitt/private/me` | `getMe()` |
| GET | `/wohnungsbestand/private/wirtschaftseinheiten` | `listWirtschaftseinheiten(q)`, `searchWirtschaftseinheiten(text)` |
| GET | `/wohnungsbestand/private/wirtschaftseinheiten/{id}` | `getWirtschaftseinheit(id)` – includes `objekte[]` |
| GET | `/wohnungsbestand/private/wirtschaftseinheiten/{id}/objekte?pageNumber=` | `listWirtschaftseinheitObjekte(id, page)` |
| GET | `/wohnungsbestand/private/objekte` | `listObjekte(q)`, `searchObjekte(text)` |
| GET | `/wohnungsbestand/private/objekte?adresse=` | `searchObjekteByAdresse(street)`: the "Objekte" category of the global search (houses by street) |
| GET | `/querschnitt/private/transaktionen/{kennung}` | `getTransaktion('MIBU-OBJEKT')`: category metadata and permissions |
| GET | `/wohnungsbestand/private/objekte/{id}` | `getObjekt(id)` |
| GET | `/wohnungsbestand/private/objekte/{id}/verwaltungseinheiten?pageNumber=` | `listObjektVerwaltungseinheiten(id, page)` |
| GET | `/wohnungsbestand/private/verwaltungseinheiten` | `listVerwaltungseinheiten(q)` – includes `nutzungsart` (Wohnraum / gewerbliche Nutzung / …) |
| GET | `/wohnungsbestand/private/verwaltungseinheiten/{id}` | `getVerwaltungseinheit(id)` – area, Etage/Lage, address, current contract, Ist-/Planmiete, Nichtvermietung, Merkmale |
| GET | `/mietenbuchhaltung/private/mietvertraege` | `listMietvertraege(q)`, `searchMietvertraege(text)`, `listMietvertraegeForVerwaltungseinheit(ve)` |
| GET | `/mietenbuchhaltung/private/mietvertraege/{id}` | `getMietvertrag(id)` – full contract: Mietstruktur with validity, Kündigung, Kontakte + Rollen, Kaution, Zahlungsart |
| GET | `/mietenbuchhaltung/private/mietvertraege/detail-mietvertrag/{id}` | `getMietvertragKompakt(id)` – side-panel summary incl. `vermietungsstatus` |
| GET | `/geschaeftspartner/private/kontakte` | `listKontakte(q)`, `searchKontakte(text)` |
| GET | `/geschaeftspartner/private/kontakte-naturlich/{id}` | `getKontaktNatuerlich(id)` |
| GET | `/geschaeftspartner/private/kontakte-juristisch/{id}` | `getKontaktJuristisch(id)` |
| — | — | `getKontakt(id, kontakttyp?)` picks the right one (falls back on 404) |

Note: `/geschaeftspartner/private/kontakte/{id}` returns **404**. Use the typed variants above.

### Paging and filters (OData-style)

* `$top`: maximum **50**. Larger values return HTTP 413. The client clamps it.
* `$skip`: offset. When it is used, `page.totalCount` and `page.totalItemsCount` come back `null`.
* `$orderby`, e.g. `nummer desc`, `beginn desc`.
* `$filter` uses OData v2 syntax. The UI search sends:
  `(substringof(toupper(bezeichnung),'TEXT') eq true)`.
  Helpers: `odataContains`, `odataEq`, `odataAnd`, `odataString`.
* `mandantNummern=1040,1010` restricts results to Mandanten.
* Sub-resources (`…/objekte`, `…/verwaltungseinheiten`) use `pageNumber=` with a fixed page size of 20.
* Unknown query params return 400 with a descriptive message.
  GUID columns (`mandantId`, `verwaltungseinheitId`) **can't be filtered**.
  Use Mandant numbers plus `wirtschaftseinheitNummer` / `objektNummer` / `verwaltungseinheitNummer`.

### Objekte search (global "YuSearch" → category "Objekte")

YuSearch in the header is a client-side navigation search. Picking **Objekte** (transaction
`MIBU-OBJEKT`, route `/de/bestand/objekt`) opens the Objekte grid, and the grid calls the list API:

* `adresse=<text>` runs a server-side "contains" search on the address (street). The grid's
  "Suchbegriff eingeben" box sends it, and the suggestion flyout uses it with `$top=5`.
* `$filter=(substringof(toupper(bezeichnung),'TEXT') eq true)` is the second suggestion call,
  on the Bezeichnung.
* "Load more" uses `$skip=50`, `100`, … with `$top=50`. Sorting uses `$orderby=bezeichnung asc|desc`
  and works on the other list columns too.

```ts
const houses = await c.searchObjekteByAdresse('Muster', { orderby: 'bezeichnung asc' });
for await (const o of c.paginate((q) => c.searchObjekteByAdresse('str', q))) { /* all pages */ }
```

`npx tsx api_client.ts <street>` runs the example walkthrough with that street search.

List responses look like
`{ page: { currentNumber, size, totalCount /*pages*/, totalItemsCount, items[] }, authorizationDetails }`.

## Examples

```ts
const c = new WodisYuneoClient();               // env-based config

// search + paginate properties
const hits = await c.searchWirtschaftseinheiten('Beispielstadt', { top: 20 });
for await (const we of c.paginate((q) => c.listWirtschaftseinheiten(q), { orderby: 'nummer asc' })) { /* ... */ }

// WE -> Gebäude -> Einheiten
const we  = await c.getWirtschaftseinheit(hits.page.items[0].id);
const obj = await c.getObjekt(we.objekte[0].id);
const ves = await c.listObjektVerwaltungseinheiten(obj.id);

// unit detail + vacancy
const ve = await c.getVerwaltungseinheit(ves.page.items[0].id);
WodisYuneoClient.vermietungsstatus(ve);          // 'vermietet' | 'leerstand' | 'unbekannt'
WodisYuneoClient.merkmaleAsRecord(ve.merkmalszuordnungen); // e.g. { nutzfläche: '74', ... }

// all contracts of a unit (history + LEERSTAND pseudo-contracts)
const mvs = await c.listMietvertraegeForVerwaltungseinheit(ve);
const mv  = await c.getMietvertrag(ve.aktuellerMietvertrag!.id);

// tenant
const tenant = await c.getKontakt(mv.hauptmieter!.id, mv.hauptmieter!.kontaktart);
console.log(tenant.bezeichnung ?? tenant.name, tenant.telefonnummern, tenant.emails, tenant.adressen);

// active residential contracts in Mandant 1040
await c.listMietvertraege({ mandantNummern: [1040], filter: "(status eq 'Aktiv')", orderby: 'beginn desc' });
```

## Caveats

* **Short-lived auth.** Access tokens last about 12 h and refresh tokens about 10 h
  (bounded by the SSO session, `session_exp`). Once the SSO session expires you need a
  fresh browser login. The automatic refresh was written against Keycloak's standard
  `refresh_token` grant but **wasn't exercised live**. Testing it would have rotated the
  browser's session tokens.
* **Rooms (Zimmer)** aren't a fixed field. immo-erp stores them as customer-defined *Merkmale*.
  In this tenant only `nutzfläche` and a few admin Merkmale exist. Use `merkmaleAsRecord()`.
* **Unit type.** `nutzungsart` on the VE list (`Wohnraum`, `gewerbliche Nutzung`, …) and on
  contracts is the best type indicator. Stellplätze/Garagen are usually separate Objekte
  (e.g. OBJ 98/99) and may have an empty `nutzungsart` and `istmiete: null`.
* **Vacancy** shows up as `aktuellerNichtvermietungsgrund` on the VE, as
  `vermietungsstatus` ("Vermietet"/…) in the compact contract, or as an active contract
  with `bezeichnung = "LEERSTAND"`.
* Legal-entity contacts (`JuristischePerson`) have `name` but no `bezeichnung`.
* Responses include a `rechteSet` (permissions) block, typed but usually ignorable.
* The web app itself POSTs UI preferences to `/querschnitt/private/einstellungen` while you
  browse. This client never does.
* This is an undocumented internal API, so field names may change between immo-erp releases
  (observed version 26.198).
