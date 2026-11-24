# immo-erp-mcp (inoffiziell)

> **Inoffiziell:** Dieses Projekt ist nicht vom Hersteller der Software und wird von ihm nicht unterstützt. Es nutzt
> die interne, undokumentierte API der immo-erp-Weboberfläche. Bitte nur mit eigenem Zugang und im
> Rahmen der Nutzungsbedingungen verwenden. Platzhalter wie `1234567_FIRMA_PRD` durch die eigenen Werte
> ersetzen.

MCP-Server für **immo-erp** (Alias für eine Immobilienverwaltungs-Software). Er sucht Objekte (Häuser nach Straße), Wirtschaftseinheiten,
Einheiten, Mietverträge und Kontakte und **liest nur**: Er schickt ausschließlich `GET`-Anfragen an die
immo-erp-API. Der Login läuft über den Keycloak des Herstellers mit Passwort und TOTP-Code und hält die Sitzung
danach selbst so lange wie möglich am Leben.

## Installation

Voraussetzung ist Node.js 20 oder neuer.

```bash
git clone <repo-url> wodis-mcp && cd wodis-mcp
npm install          # baut automatisch nach dist/
```

### Aktualisieren

Updates kommen über Git. Die Login-Sitzung (`~/.wodis-mcp/session.json`) bleibt dabei erhalten, ein neuer
Login ist **nicht** nötig.

```bash
cd /pfad/zu/wodis-mcp
node dist/index.js version --check   # zeigt laufende Version und neue Commits
npm run self-update                  # git pull --ff-only → npm ci → npm run build
```

Danach den MCP-Server im Client **neu starten bzw. neu verbinden**, damit die neue Version läuft.

* Für Agenten: `wodis_server_info` mit `checkForUpdates: true` meldet, ob ein Update da ist. Was sich
  geändert hat, steht in [CHANGELOG.md](CHANGELOG.md).
* Agenten ohne Shell-Zugriff: Mit `WODIS_ALLOW_SELF_UPDATE=1` in der MCP-Konfiguration gibt es zusätzlich
  das Tool `wodis_self_update`. Es ist standardmäßig aus, weil es Code aus dem Repository nachlädt.
* `self-update` bricht ab, wenn im Installationsordner lokale Änderungen liegen. Es überschreibt nie
  etwas stillschweigend. Für ein privates Repository braucht der Rechner Lesezugriff auf GitHub,
  zum Beispiel über einen Deploy-Key.

### In Claude Code einbinden

```bash
claude mcp add wodis -e WODIS_DATABASE=1234567_FIRMA_PRD -- node /pfad/zu/wodis-mcp/dist/index.js
```

### In andere MCP-Clients einbinden (Grok-Agent, Claude Desktop, Cursor, …)

```json
{
  "mcpServers": {
    "wodis": {
      "command": "node",
      "args": ["/pfad/zu/wodis-mcp/dist/index.js"],
      "env": {
        "WODIS_DATABASE": "1234567_FIRMA_PRD"
      }
    }
  }
}
```

## Login

Es gibt drei Wege. Alle enden in derselben gespeicherten Sitzung.

| Weg | Ablauf | Passwort im Chat? |
|---|---|---|
| **Tools** (für Agenten) | `wodis_login`, danach `wodis_login_otp` mit dem 6-stelligen Code | Nur wenn es als Parameter übergeben wird. Mit `WODIS_USERNAME`/`WODIS_PASSWORD` in der Konfiguration geht nur der Code durch den Chat |
| **Login-Seite** | `wodis_login_page` öffnet `http://127.0.0.1:<port>/<geheim>/`. Dort Passwort, Code und ggf. Datenbank eingeben | Nein |
| **Terminal** | `node dist/index.js login` (Eingabe im Terminal) oder `node dist/index.js login-page` (Login-Seite ohne laufenden MCP-Client) | Nein |

Ablauf in Keycloak: zuerst Benutzername, dann Passwort, dann der Code aus der Authenticator-App
(TOTP), dann eine automatisch abgeschickte Seite „Auto Persist Tab ID“ (der Server schickt dort wie der Browser eine neue UUID als `tab_id`), dann die Datenbankauswahl. Die Auswahl übernimmt der Server automatisch, wenn nur eine
Datenbank angeboten wird oder `WODIS_DATABASE` gesetzt ist. Danach tauscht er den Code per PKCE gegen
die Tokens. Details zum erfassten Ablauf stehen in [scripts/wodis_client/AUTH.md](scripts/wodis_client/AUTH.md).

### So lange wie möglich angemeldet bleiben

* „Angemeldet bleiben“ wird beim Login immer gesetzt.
* Gespeichert werden Access- und Refresh-Token sowie die **Keycloak-SSO-Cookies**. Das Passwort wird
  **nie** gespeichert.
* Solange der Server läuft, erneuert er den Token alle `WODIS_KEEPALIVE_MINUTES` (Standard 30). Der
  Refresh-Token lebt 10 Stunden, wird bei jeder Erneuerung neu ausgestellt und hält die SSO-Sitzung aktiv.
* Ist der Refresh-Token doch abgelaufen, zum Beispiel weil der Rechner aus war, meldet sich der Server mit
  den gespeicherten SSO-Cookies **still neu an**, ohne Passwort und ohne Code.
* Neu einloggen mit Code musst du dich erst, wenn die maximale SSO-Sitzungsdauer von Keycloak
  abgelaufen ist. Beim Hersteller sind das **5 Tage** nach dem Login (`ssoSessionValidUntil` in
  `wodis_auth_status`).
* Läuft länger als etwa 10 Stunden gar nichts, zum Beispiel weil der Rechner über Nacht aus ist, kann
  Keycloak die SSO-Sitzung vorher beenden. Ob das passiert, ist noch nicht geprüft. Ein Keepalive auf
  einem Rechner, der immer läuft, verhindert das.
* Damit die Sitzung auch ohne laufenden MCP-Client nicht abläuft, kannst du den Keepalive als Cronjob
  einrichten:

  ```cron
  */30 * * * * /usr/bin/env node /pfad/zu/wodis-mcp/dist/index.js keepalive >/dev/null 2>&1
  ```

  Der Befehl endet mit Exit-Code `1`, wenn ein neuer Login nötig ist.

## Werkzeuge

| Tool | Zweck |
|---|---|
| `wodis_auth_status` | Login-Status und Gültigkeit von Token und SSO-Sitzung |
| `wodis_login`, `wodis_login_otp`, `wodis_login_select_database`, `wodis_login_page`, `wodis_logout` | Anmeldung und Abmeldung |
| `wodis_search_objekte` | Häuser nach `strasse` (Teil der Adresse), `bezeichnung` oder Nummer der Wirtschaftseinheit |
| `wodis_get_objekt` | Objekt mit Adresse, Flächen, Merkmalen und allen Einheiten |
| `wodis_search_wirtschaftseinheiten`, `wodis_get_wirtschaftseinheit` | Wirtschaftseinheiten |
| `wodis_search_einheiten`, `wodis_get_einheit` | Einheiten inkl. Vermietungsstatus, Ist-/Planmiete und Leerstand |
| `wodis_list_einheit_mietvertraege` | Alle Verträge einer Einheit |
| `wodis_get_mietvertrag`, `wodis_search_mietvertraege` | Mietverträge mit Mietstruktur, Kündigung und Kaution |
| `wodis_get_mietkonto` | Mietkonto eines Vertrags: Kontobewegungen (Sollstellungen, Zahlungen, Storni) mit laufendem Saldo und Summen. Positiver Saldo = Rückstand, negativer Saldo = Guthaben |
| `wodis_search_kontakte`, `wodis_get_kontakt` | Mieter und Firmen mit Kontaktdaten |
| `wodis_list_mandanten` | Mandanten |

Typischer Ablauf: `wodis_search_objekte(strasse)` → `wodis_get_objekt` → `wodis_get_einheit` →
`wodis_get_mietvertrag` → `wodis_get_kontakt`, für Zahlungen und Rückstände `wodis_get_mietkonto`.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `WODIS_DATABASE` | – | **Empfohlen.** Datenbank für die automatische Auswahl, z. B. `1234567_FIRMA_PRD` (das Konto hat auch `…_EDU`) |
| `WODIS_IDP_HINT` | – | Nicht nötig und nicht empfohlen. Der Server geht denselben Weg wie der Browser |
| `WODIS_USERNAME` / `WODIS_PASSWORD` | – | Optional für Agenten-Logins ohne Passwort im Chat |
| `WODIS_MCP_HOME` | `~/.wodis-mcp` | Ordner für `session.json` (Rechte `0600`) |
| `WODIS_SESSION_KEY` | – | Passphrase, verschlüsselt `session.json` mit AES-256-GCM |
| `WODIS_KEEPALIVE_MINUTES` | `30` | Abstand der automatischen Erneuerung |
| `WODIS_LOGIN_HOST` / `WODIS_LOGIN_PORT` | `127.0.0.1` / zufällig | Adresse der Login-Seite. Für Server zum Beispiel `0.0.0.0` und `8787` |
| `WODIS_LOGIN_PUBLIC_URL` | – | Öffentliche URL der Login-Seite hinter einem Proxy |
| `WODIS_OPEN_BROWSER` | `1` | `0` öffnet die Login-Seite nicht automatisch |
| `WODIS_DEBUG` | – | `1` protokolliert die Login-Schritte. Seitentitel und Feldnamen, nie Werte |

## Sicherheit

* Die Datenwerkzeuge nutzen nur `GET`. Der einzige `POST` außerhalb des Logins ist die
  Token-Erneuerung bei Keycloak.
* Werden Passwörter im Chat übergeben, landen sie im Modell und im Gesprächsverlauf. Besser sind die
  Login-Seite, das Terminal oder Umgebungsvariablen.
* `session.json` enthält gültige Zugangsdaten zu echten Mieterdaten. Die Datei gehört **nie** in Git,
  sie ist in `.gitignore`. Auf Servern `WODIS_SESSION_KEY` setzen.
* Die immo-erp-API ist intern und undokumentiert (erfasst mit Version 26.198). Feldnamen können sich mit
  Updates ändern.

## Entwicklung

```bash
npm run dev -- status     # direkt aus src/ via tsx
npm run typecheck
npm run build
```
