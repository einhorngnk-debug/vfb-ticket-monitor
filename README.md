# VfB Ticket Monitor v2

Diese Version klickt zuerst auf **Anmelden**, falls der Shop noch nicht eingeloggt ist.
Danach werden Benutzername und Passwort aus GitHub-Secrets eingetragen und
anschließend die Kachel **Auswärtsspiele** geöffnet.

## GitHub-Secrets

Unter `Settings → Secrets and variables → Actions`:

- `VFB_USERNAME`
- `VFB_PASSWORD`
- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

## Aktualisierung eines bestehenden Repositories

Ersetze mindestens:

- `monitor.js`
- `.github/workflows/monitor.yml`

Die Dateien `package.json`, `state.json` und `README.md` können ebenfalls ersetzt werden.

## Test

Unter `Actions → VfB Ticket Monitor → Run workflow` manuell starten.

Beim ersten erfolgreichen Lauf wird nur `state.json` initialisiert.
Eine E-Mail kommt erst bei einem späteren Wechsel von
`Gästebereich ausverkauft` zu einem anderen Status.

Bei einem Fehler werden `failure.png` und `failure.html` als Artifact hochgeladen.

## Grenzen

CAPTCHA, Warteschlange und Zwei-Faktor-Anmeldung werden nicht umgangen.
