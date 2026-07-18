# VfB Ticket Monitor – direkte Ticketseite

Der Monitor öffnet direkt die öffentliche Auswärtsspiel-Seite:

`https://tickets.vfb.de/shop?wes=empty_session_103&language=1&shopid=103&nextstate=2&lpShortcutId=4`

Dadurch muss die Kachel „Auswärtsspiele“ nicht mehr angeklickt werden.

## GitHub-Secrets

- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

## Installation

Alle Dateien ins bestehende Repository hochladen und die vorhandenen Dateien
ersetzen. Danach den Workflow unter GitHub Actions manuell starten.

Beim ersten erfolgreichen Lauf wird nur `state.json` befüllt. Eine E-Mail wird
erst bei einem späteren Wechsel von „Gästebereich ausverkauft“ zu einem
anderen Status verschickt.
