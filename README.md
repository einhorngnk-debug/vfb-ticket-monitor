# VfB Ticket Monitor ohne Login

Diese Variante versucht, die öffentlich sichtbaren Auswärtsspiele ohne Anmeldung zu prüfen.

## Benötigte GitHub-Secrets

Nur diese beiden Secrets sind erforderlich:

- `EMAIL_ENDPOINT`
- `EMAIL_SECRET`

Nicht mehr benötigt:

- `VFB_USERNAME`
- `VFB_PASSWORD`
- `VFB_STATE_KEY`

Die alten Secrets dürfen bestehen bleiben, werden aber vom Workflow nicht verwendet.

## Installation

Alle Dateien aus diesem Paket in das Repository hochladen und vorhandene Dateien ersetzen.

Danach unter:

`Actions → VfB Ticket Monitor ohne Login → Run workflow`

einen manuellen Test starten.

## Verhalten

Der Monitor:

1. öffnet den öffentlichen VfB-Ticketshop,
2. akzeptiert nach Möglichkeit den Cookie-Dialog,
3. öffnet „Auswärtsspiele“,
4. liest öffentlich sichtbare Ticketstatus aus,
5. speichert den Ausgangszustand in `state.json`,
6. verschickt eine E-Mail, wenn ein Status von
   „Gästebereich ausverkauft“ zu einem anderen Status wechselt.

## Wichtiger Hinweis

Diese Version funktioniert nur, wenn der VfB-Shop die relevanten Ticketstatus ohne Login ausliefert.

Wenn der Shop für die Auswärtsspiele zwingend eine Anmeldung verlangt, erzeugt der Workflow eine klare Fehlermeldung und lädt `failure.png` sowie `failure.html` hoch. Ein Login, CAPTCHA oder eine Warteschlange wird nicht umgangen.
