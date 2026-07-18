# VfB Ticket Monitor – Cookie-Fix

Diese Version prüft die öffentlich sichtbaren Auswärtsspiele ohne Login.

Der ConsentManager-Dialog wird nacheinander über folgende Wege geschlossen:

1. sichtbare Playwright-Locators,
2. alle Frames,
3. offene Shadow DOMs,
4. einen Koordinaten-Fallback für den mittigen roten Hauptbutton.

## Benötigte Secrets

- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

## Installation

Alle Dateien dieses Pakets in das GitHub-Repository hochladen und vorhandene
Dateien ersetzen. Danach den Workflow manuell über GitHub Actions starten.

Wenn der Shop die Ticketdaten nur nach Anmeldung ausliefert, meldet der
Workflow das ausdrücklich. CAPTCHA, Warteschlangen oder Logins werden nicht
umgangen.
