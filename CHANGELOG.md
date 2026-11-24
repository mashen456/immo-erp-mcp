# Changelog

Neue Einträge oben. Nach jedem Update den MCP-Server neu starten. Die Login-Sitzung bleibt erhalten,
sofern ein Eintrag nichts anderes sagt.

## 0.2.0

* Neu: Update-Pfad über Git: `npm run self-update` bzw. `wodis-mcp update`
  (git pull --ff-only → npm ci → npm run build), `wodis-mcp version --check`.
* Neu: Tool `wodis_server_info` mit Version, Commit und optionaler Update-Prüfung.
* Neu: Tool `wodis_self_update`, nur mit `WODIS_ALLOW_SELF_UPDATE=1`.
* Die Version wird nur noch in `package.json` gepflegt.

## 0.1.0

* Erste Version: 12 Lese-Tools (Objekte, Wirtschaftseinheiten, Einheiten, Mietverträge, Kontakte, Mandanten).
* Login per Tool, lokaler Login-Seite oder Terminal, inkl. TOTP, „Auto Persist Tab ID“ und Datenbankauswahl.
* Lange Sitzungen: Refresh, Keepalive, stille Neuanmeldung mit SSO-Cookies, Sperre bei mehreren Prozessen.
