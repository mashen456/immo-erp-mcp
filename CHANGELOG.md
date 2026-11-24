# Changelog

Neue Einträge oben. Nach jedem Update den MCP-Server neu starten. Die Login-Sitzung bleibt erhalten,
sofern ein Eintrag nichts anderes sagt.

## 0.3.1

* Doku: Die Sitzung hält sich selbst am Leben. Agenten sollen keine Cronjobs, Timer oder täglichen
  Prüfungen einrichten. Ein neuer Login mit Code ist erst nach `ssoSessionValidUntil` (5 Tage) nötig.
  Das steht auch in den Server-Hinweisen für Agenten.

## 0.3.0

* Neu: Tool `wodis_get_mietkonto`. Es zeigt die Kontobewegungen des Mietkontos zu einem Mietvertrag
  (Sollstellungen, Zahlungen, Storni) mit laufendem Saldo, Summen (Soll/Haben/Saldo), Zeitraumfilter
  (`von`/`bis`) und Seiten (max. 50 je Seite).
* Saldo = Soll − Haben: positiv bedeutet Rückstand des Mieters, negativ Guthaben. Das Tool gibt den
  Kontostand zusätzlich als Text aus („Guthaben 120.00 €“).
* API: `GET /buchungswesen/private/kontenanzeigen/compact-konten` (Konto zum Vertrag) und
  `GET /buchungswesen/private/kontenanzeigen-mietenbuchhaltung-auskunft` (Bewegungen).

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
