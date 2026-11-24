import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LoginError } from './auth/keycloak.js';
import type { LoginPage } from './auth/login-page.js';
import { NotLoggedInError, type TokenManager } from './auth/token-manager.js';
import {
  odataAnd,
  odataContains,
  odataEq,
  WodisApiError,
  WodisYuneoClient,
  type ListQuery,
  type PagedResponse,
} from './wodis/client.js';
import { checkForUpdates, commit, repoRoot, selfUpdate, version } from './update.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const NOISE = new Set(['rechteSet', 'authorizationDetails', 'entityTag']);

/** Drop permission blocks, nulls and empty arrays to keep tool output small. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (NOISE.has(k) || val === null || val === undefined) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      out[k] = clean(val);
    }
    return out;
  }
  return v;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const r = await fn();
    return text(typeof r === 'string' ? r : JSON.stringify(clean(r), null, 1));
  } catch (e) {
    if (e instanceof NotLoggedInError || e instanceof LoginError) return text(e.message, true);
    if (e instanceof WodisApiError) return text(`Wodis-API-Fehler ${e.status}: ${e.body.slice(0, 400)}`, true);
    return text(`Fehler: ${(e as Error).message}`, true);
  }
}

function page<T>(r: PagedResponse<T>, q: ListQuery) {
  return {
    totalItems: r.page.totalItemsCount ?? undefined,
    returned: r.page.items.length,
    skip: q.skip ?? 0,
    hasMore: r.page.items.length >= (q.top ?? 20),
    items: r.page.items,
  };
}

const paging = {
  top: z.number().int().min(1).max(50).optional().describe('Anzahl Treffer (1–50, Standard 20)'),
  skip: z.number().int().min(0).optional().describe('Offset zum Weiterblättern'),
  orderby: z.string().optional().describe('OData-Sortierung, z. B. "bezeichnung asc" oder "nummer desc"'),
};
const q = (a: { top?: number; skip?: number; orderby?: string }, filter?: string): ListQuery => ({
  top: a.top ?? 20,
  skip: a.skip,
  orderby: a.orderby,
  filter,
});

const READ = { readOnlyHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, tm: TokenManager, loginPage: LoginPage): void {
  const client = new WodisYuneoClient({
    baseUrl: tm.cfg.baseUrl,
    locale: tm.cfg.locale,
    tokenProvider: (force) => tm.getAccessToken(force),
  });

  // ---- Auth -------------------------------------------------------------------

  server.registerTool(
    'wodis_auth_status',
    {
      title: 'Wodis: Anmeldestatus',
      description: 'Zeigt, ob eine Wodis-Sitzung besteht, für welchen Benutzer und welche Datenbank, und wie lange Token und SSO-Sitzung gültig sind.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => tm.currentStatus()),
  );

  server.registerTool(
    'wodis_login',
    {
      title: 'Wodis: Login starten',
      description:
        'Startet den Wodis-Login (Aareon Keycloak). Ohne Parameter werden WODIS_USERNAME/WODIS_PASSWORD aus der Server-Konfiguration genutzt (empfohlen, ' +
        'dann geht kein Passwort durch den Chat). Antwort "otp_required": danach wodis_login_otp mit dem 6-stelligen Code aus der Authenticator-App aufrufen. ' +
        'Alternative ohne Passwort im Chat: wodis_login_page.',
      inputSchema: {
        username: z.string().optional().describe('Wodis-Benutzername / E-Mail (optional, sonst WODIS_USERNAME)'),
        password: z.string().optional().describe('Passwort (optional, sonst WODIS_PASSWORD)'),
      },
    },
    async ({ username, password }) => run(() => tm.login(username, password)),
  );

  server.registerTool(
    'wodis_login_otp',
    {
      title: 'Wodis: TOTP-Code senden',
      description: 'Zweiter Login-Schritt: den aktuellen 6-stelligen Code aus der Authenticator-App übermitteln. Gilt ca. 30 Sekunden.',
      inputSchema: { code: z.string().describe('6-stelliger Code aus der Authenticator-App') },
    },
    async ({ code }) => run(() => tm.submitOtp(code)),
  );

  server.registerTool(
    'wodis_login_select_database',
    {
      title: 'Wodis: Datenbank wählen',
      description: 'Nur nötig, wenn der Login "database_required" meldet: eine der angebotenen Datenbanken wählen (z. B. "..._PRD").',
      inputSchema: { database: z.string() },
    },
    async ({ database }) => run(() => tm.selectDatabase(database)),
  );

  server.registerTool(
    'wodis_login_page',
    {
      title: 'Wodis: Login-Seite öffnen',
      description:
        'Öffnet eine lokale Login-Seite (Benutzername, Passwort, TOTP) und gibt deren URL zurück. Passwort und Code gehen dabei nicht durch den Chat. ' +
        'Danach mit wodis_auth_status prüfen, ob der Login abgeschlossen ist.',
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const url = await loginPage.open();
        return `Login-Seite: ${url}\nBitte dort anmelden (Passwort, dann Code aus der Authenticator-App). Danach wodis_auth_status aufrufen.`;
      }),
  );

  server.registerTool(
    'wodis_logout',
    {
      title: 'Wodis: Abmelden',
      description: 'Beendet die Wodis-Sitzung bei Keycloak und löscht die gespeicherten Tokens und Cookies.',
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => run(async () => (await tm.logout(), 'Abgemeldet, Sitzung gelöscht.')),
  );

  // ---- Server / Updates -------------------------------------------------------------

  const runningVersion = `${version()} (${commit() ?? 'no git checkout'})`;

  server.registerTool(
    'wodis_server_info',
    {
      title: 'Wodis: Server-Version und Updates',
      description:
        'Zeigt die laufende Version des MCP-Servers. checkForUpdates=true holt den Stand des Git-Remotes (nur lesend) und listet neue Commits. ' +
        'Update: im Installationsordner "npm run self-update" ausführen (oder wodis_self_update, falls freigeschaltet), danach den MCP-Server neu starten. Die Login-Sitzung bleibt erhalten.',
      inputSchema: { checkForUpdates: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ checkForUpdates: check }) =>
      run(async () => ({
        running: runningVersion,
        installDir: repoRoot,
        selfUpdateToolEnabled: tm.cfg.allowSelfUpdate,
        ...(check ? checkForUpdates() : { installed: `${version()} (${commit() ?? '?'})` }),
      })),
  );

  if (tm.cfg.allowSelfUpdate) {
    server.registerTool(
      'wodis_self_update',
      {
        title: 'Wodis: Server aktualisieren',
        description:
          'Aktualisiert den MCP-Server aus dem Git-Remote (git pull --ff-only, npm ci, npm run build). Bricht bei lokalen Änderungen ab. ' +
          'Danach muss der MCP-Client den Server neu starten/verbinden; die Login-Sitzung bleibt erhalten. Nur nach Rückfrage beim Benutzer aufrufen.',
        inputSchema: { confirm: z.literal(true).describe('Muss true sein – Bestätigung, dass das Update gewollt ist') },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async () =>
        run(async () => {
          const r = selfUpdate();
          return {
            ...r,
            next: r.ok
              ? r.restartRequired
                ? 'Update installiert. Jetzt den MCP-Server neu starten/verbinden, damit die neue Version läuft.'
                : 'Bereits aktuell, kein Neustart nötig.'
              : 'Update fehlgeschlagen, alte Version läuft unverändert weiter.',
          };
        }),
    );
  }

  // ---- Bestand ------------------------------------------------------------------

  server.registerTool(
    'wodis_search_objekte',
    {
      title: 'Wodis: Objekte (Häuser) suchen',
      description:
        'Sucht Objekte/Gebäude – wie die Kategorie "Objekte" der globalen Suche. "strasse" sucht in der Adresse (Teilstring, z. B. "Muster"), ' +
        '"bezeichnung" in der Bezeichnung. Liefert id, WE-/Objektnummer, Adresse, Anzahl Einheiten, Fläche.',
      inputSchema: {
        strasse: z.string().optional().describe('Teil der Straße/Adresse'),
        bezeichnung: z.string().optional().describe('Teil der Objektbezeichnung'),
        wirtschaftseinheitNummer: z.number().int().optional(),
        ...paging,
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const filter = odataAnd(
          a.bezeichnung ? odataContains('bezeichnung', a.bezeichnung) : undefined,
          a.wirtschaftseinheitNummer !== undefined ? odataEq('wirtschaftseinheitNummer', a.wirtschaftseinheitNummer) : undefined,
        );
        const query = q(a, filter);
        const r = a.strasse ? await client.searchObjekteByAdresse(a.strasse, query) : await client.listObjekte(query);
        return page(r, query);
      }),
  );

  server.registerTool(
    'wodis_get_objekt',
    {
      title: 'Wodis: Objekt-Details',
      description: 'Details zu einem Objekt (Gebäude): Adresse, Wirtschaftseinheit, Baujahr, Flächen, Merkmale und alle Einheiten (Verwaltungseinheiten).',
      inputSchema: { id: z.string().describe('Objekt-ID (GUID) aus wodis_search_objekte') },
      annotations: READ,
    },
    async ({ id }) =>
      run(async () => {
        const obj = await client.getObjekt(id);
        const have = obj.verwaltungseinheiten?.length ?? 0;
        if (have < obj.anzahlVerwaltungseinheiten) {
          const all = [];
          for (let p = 1; p <= 25; p++) {
            const r = await client.listObjektVerwaltungseinheiten(id, p);
            all.push(...r.page.items);
            if (r.page.items.length < 20) break;
          }
          obj.verwaltungseinheiten = all;
        }
        return { ...obj, merkmale: WodisYuneoClient.merkmaleAsRecord(obj.merkmalszuordnungen), merkmalszuordnungen: undefined };
      }),
  );

  server.registerTool(
    'wodis_search_wirtschaftseinheiten',
    {
      title: 'Wodis: Wirtschaftseinheiten suchen',
      description: 'Listet/sucht Wirtschaftseinheiten (WE) nach Bezeichnung. Liefert Nummer, Bezeichnung, Anzahl Objekte/Einheiten, Fläche.',
      inputSchema: { text: z.string().optional().describe('Teil der Bezeichnung'), ...paging },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const query = q(a, a.text ? odataContains('bezeichnung', a.text) : undefined);
        return page(await client.listWirtschaftseinheiten(query), query);
      }),
  );

  server.registerTool(
    'wodis_get_wirtschaftseinheit',
    {
      title: 'Wodis: Wirtschaftseinheit-Details',
      description: 'Details zu einer Wirtschaftseinheit inkl. ihrer Objekte (Gebäude mit Adresse).',
      inputSchema: { id: z.string().describe('WE-ID (GUID)') },
      annotations: READ,
    },
    async ({ id }) => run(() => client.getWirtschaftseinheit(id)),
  );

  server.registerTool(
    'wodis_search_einheiten',
    {
      title: 'Wodis: Einheiten suchen',
      description: 'Listet Einheiten (Verwaltungseinheiten: Wohnungen, Gewerbe, Stellplätze) gefiltert nach WE-/Objektnummer oder Bezeichnung, inkl. Nutzungsart.',
      inputSchema: {
        wirtschaftseinheitNummer: z.number().int().optional(),
        objektNummer: z.number().int().optional(),
        bezeichnung: z.string().optional(),
        ...paging,
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const query = q(
          a,
          odataAnd(
            a.wirtschaftseinheitNummer !== undefined ? odataEq('wirtschaftseinheitNummer', a.wirtschaftseinheitNummer) : undefined,
            a.objektNummer !== undefined ? odataEq('objektNummer', a.objektNummer) : undefined,
            a.bezeichnung ? odataContains('bezeichnung', a.bezeichnung) : undefined,
          ),
        );
        return page(await client.listVerwaltungseinheiten(query), query);
      }),
  );

  server.registerTool(
    'wodis_get_einheit',
    {
      title: 'Wodis: Einheit-Details',
      description: 'Details zu einer Einheit: Fläche, Etage/Lage, Adresse, aktueller Mietvertrag, Ist-/Planmiete, Leerstand, Merkmale. Enthält "vermietungsstatus".',
      inputSchema: { id: z.string().describe('Einheit-ID (GUID) aus wodis_get_objekt oder wodis_search_einheiten') },
      annotations: READ,
    },
    async ({ id }) =>
      run(async () => {
        const ve = await client.getVerwaltungseinheit(id);
        return {
          vermietungsstatus: WodisYuneoClient.vermietungsstatus(ve),
          merkmale: WodisYuneoClient.merkmaleAsRecord(ve.merkmalszuordnungen),
          ...ve,
          merkmalszuordnungen: undefined,
        };
      }),
  );

  // ---- Vermietung -----------------------------------------------------------------

  server.registerTool(
    'wodis_list_einheit_mietvertraege',
    {
      title: 'Wodis: Mietverträge einer Einheit',
      description: 'Alle Mietverträge einer Einheit (aktuell und historisch, inkl. LEERSTAND-Verträge), neueste zuerst.',
      inputSchema: { einheitId: z.string().describe('Einheit-ID (GUID)'), top: paging.top },
      annotations: READ,
    },
    async ({ einheitId, top }) =>
      run(async () => {
        const ve = await client.getVerwaltungseinheit(einheitId);
        const query: ListQuery = { top: top ?? 20 };
        return page(await client.listMietvertraegeForVerwaltungseinheit(ve, query), query);
      }),
  );

  server.registerTool(
    'wodis_get_mietvertrag',
    {
      title: 'Wodis: Mietvertrag-Details',
      description:
        'Mietvertrag mit Mietstruktur (Kaltmiete, Vorauszahlungen, gültig ab/bis), Kündigung, Kontakten/Rollen, Kaution, Zahlungsart. ' +
        'kompakt=true liefert die Kurzansicht inkl. Saldo und Vermietungsstatus.',
      inputSchema: { id: z.string().describe('Mietvertrag-ID (GUID)'), kompakt: z.boolean().optional() },
      annotations: READ,
    },
    async ({ id, kompakt }) => run(() => (kompakt ? client.getMietvertragKompakt(id) : client.getMietvertrag(id))),
  );

  server.registerTool(
    'wodis_search_mietvertraege',
    {
      title: 'Wodis: Mietverträge suchen',
      description: 'Sucht Mietverträge nach Bezeichnung (meist Mietername), Status ("Aktiv", "NichtMehrAktiv") oder WE-/Objektnummer.',
      inputSchema: {
        text: z.string().optional().describe('Teil der Bezeichnung, z. B. Nachname'),
        status: z.string().optional().describe('z. B. "Aktiv"'),
        wirtschaftseinheitNummer: z.number().int().optional(),
        objektNummer: z.number().int().optional(),
        ...paging,
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const query = q(
          a,
          odataAnd(
            a.text ? odataContains('bezeichnung', a.text) : undefined,
            a.status ? odataEq('status', a.status) : undefined,
            a.wirtschaftseinheitNummer !== undefined ? odataEq('wirtschaftseinheitNummer', a.wirtschaftseinheitNummer) : undefined,
            a.objektNummer !== undefined ? odataEq('objektNummer', a.objektNummer) : undefined,
          ),
        );
        query.orderby ??= 'beginn desc';
        return page(await client.listMietvertraege(query), query);
      }),
  );

  // ---- Kontakte ---------------------------------------------------------------------

  server.registerTool(
    'wodis_search_kontakte',
    {
      title: 'Wodis: Kontakte suchen',
      description: 'Sucht Kontakte (Mieter, Firmen) nach Name/Bezeichnung.',
      inputSchema: { text: z.string().describe('Teil des Namens'), ...paging },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const query = q(a, odataContains('bezeichnung', a.text));
        return page(await client.listKontakte(query), query);
      }),
  );

  server.registerTool(
    'wodis_get_kontakt',
    {
      title: 'Wodis: Kontakt-Details',
      description: 'Kontakt/Mieter mit Adressen, Telefonnummern, E-Mails und Geschäftsbeziehungen.',
      inputSchema: {
        id: z.string().describe('Kontakt-ID (GUID), z. B. hauptmieter.id aus einem Mietvertrag'),
        kontakttyp: z.enum(['NaturlichePerson', 'JuristischePerson']).optional(),
      },
      annotations: READ,
    },
    async ({ id, kontakttyp }) => run(() => client.getKontakt(id, kontakttyp)),
  );

  server.registerTool(
    'wodis_list_mandanten',
    {
      title: 'Wodis: Mandanten',
      description: 'Alle Mandanten, auf die der Benutzer Zugriff hat (ID ↔ Nummer).',
      inputSchema: {},
      annotations: READ,
    },
    async () => run(() => client.getMandanten()),
  );
}
