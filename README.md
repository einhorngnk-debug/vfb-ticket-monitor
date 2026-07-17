# VfB Ticket Monitor

Dieser Monitor meldet per Google Apps Script, wenn ein Auswärtsspiel zuvor
"Gästebereich ausverkauft" war und später einen anderen Buttonstatus zeigt.

## GitHub-Secrets

Unter `Settings → Secrets and variables → Actions` anlegen:

- `VFB_USERNAME` – Login-E-Mail oder Benutzername
- `VFB_PASSWORD` – Ticketshop-Passwort
- `EMAIL_ENDPOINT` – Google-Apps-Script-Web-App-URL mit `/exec`
- `EMAIL_SECRET` – dasselbe Secret wie in `Code.gs`

Keine Zugangsdaten in Dateien oder Commits schreiben.

## Installation

Alle Dateien dieses Projekts in das öffentliche GitHub-Repository hochladen.
Dann unter `Actions → VfB Ticket Monitor → Run workflow` einmal manuell testen.

Beim ersten erfolgreichen Lauf wird nur `state.json` initialisiert.
Eine E-Mail wird erst bei einem späteren Wechsel von
"Gästebereich ausverkauft" zu einem anderen Status ausgelöst.

## Grenzen

Der Code umgeht weder CAPTCHA noch Warteschlange noch Zwei-Faktor-Anmeldung.
Wenn der Shop eine solche Prüfung verlangt, schlägt der Lauf kontrolliert fehl
und lädt einen Screenshot als GitHub-Artifact hoch.

Die Selektoren sind absichtlich tolerant. Falls der Loginaufbau anders ist,
kann `monitor.js` anhand des Fehler-Screenshots angepasst werden.
