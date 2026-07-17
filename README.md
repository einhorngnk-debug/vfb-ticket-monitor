# VfB Ticket Monitor v3

Diese Version:

- akzeptiert den Cookie-/Datenschutzdialog auch dann, wenn er verzögert erscheint,
- meldet sich bei Bedarf an,
- speichert die Browser-Sitzung verschlüsselt,
- verwendet die gespeicherte Sitzung bei späteren Läufen,
- überwacht alle sichtbaren Auswärtsspiele.

## GitHub-Secrets

Unter `Settings → Secrets and variables → Actions` müssen fünf Secrets existieren:

- `VFB_USERNAME`
- `VFB_PASSWORD`
- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`
- `VFB_STATE_KEY`

`VFB_STATE_KEY` ist ein neuer, langer Schlüssel zur Verschlüsselung der Sitzung,
zum Beispiel mindestens 32 zufällige Zeichen. Nicht dasselbe Passwort wie beim VfB verwenden.

## Aktualisierung

Ersetze alle Projektdateien durch die Dateien aus diesem Paket.
Die Datei `auth-state.enc` darf leer starten. Nach dem ersten erfolgreichen Login
wird sie verschlüsselt befüllt und automatisch committed.

## Test

Unter `Actions → VfB Ticket Monitor → Run workflow` starten.

Beim ersten erfolgreichen Lauf wird der Ausgangszustand gespeichert.
Eine Ticket-Mail wird erst bei einem späteren Wechsel von
`Gästebereich ausverkauft` zu einem anderen Status ausgelöst.

## Sicherheit

Die Sitzung wird mit AES-256-GCM verschlüsselt. Der Schlüssel liegt nur als
GitHub Secret vor. Ohne `VFB_STATE_KEY` ist `auth-state.enc` nicht lesbar.

CAPTCHA, Warteschlange oder Zwei-Faktor-Anmeldung werden nicht umgangen.
