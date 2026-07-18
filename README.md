# VfB Ticket Monitor – `.event-container`

Diese Version verwendet den tatsächlichen Karten-Selektor der Seite:

```text
.events .event-container
```

Dadurch werden nur die echten Veranstaltungskarten ausgewertet. Navigation,
„Ticket kaufen“, „Ticket Onlineshops“ und „VIP-Ticket-Shop“ werden ignoriert.

## Benötigte GitHub-Secrets

- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

## Installation

Alle Dateien in das vorhandene Repository hochladen und die bisherigen
Dateien ersetzen. Danach den Workflow manuell starten.

Im Log sollte zuerst zum Beispiel stehen:

```text
3 Veranstaltungskarte(n) gefunden.
```

Danach sollten nur die echten Spiele mit ihrem Status erscheinen.
