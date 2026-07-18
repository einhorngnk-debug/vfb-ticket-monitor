# VfB Ticket Monitor – bereinigter Parser

Diese Version öffnet direkt die öffentliche Auswärtsspiel-Seite und wertet
nur echte Veranstaltungskarten aus.

Nicht mehr als Ticketstatus erfasst werden:

- `Tickets`
- `VIP-Ticket-Shop`
- Navigationselemente

Im Log sollten nur echte Spiele erscheinen, zum Beispiel:

- F.C. Hansa Rostock - VfB Stuttgart
- FC Bayern München - VfB Stuttgart
- TSG Hoffenheim - VfB Stuttgart

## Benötigte GitHub-Secrets

- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

## Installation

Alle Dateien in das bestehende Repository hochladen und die vorhandenen
Dateien ersetzen. Danach den Workflow manuell starten.
