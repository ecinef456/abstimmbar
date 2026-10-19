---
title: Ergebnisse
description: Ergebnisse je Durchführung ansehen, zwischen Durchführungen wechseln, als CSV exportieren, archivieren oder löschen.
---

# Ergebnisse ansehen und exportieren

Nach der Durchführung finden Sie alle Antworten in der **Ergebnisansicht** —
im Fragenset über **„Ergebnisse“** (oder im Raum über das Diagramm-Symbol am
Set). Für Lernkontrollen gibt es keine Ergebnisansicht; dort sehen Sie im Set
die Zahl der Versuche und den Anteil richtiger Antworten.

![Ergebnisseite: Auswahl der Durchführung, KI-Kurzbericht, Balken einer Einzelauswahl, Wortliste und CSV-Export](../bilder/ergebnisse.png)

## Durchführungen

Jede Präsentation (bzw. jeder Quiz-Block) wird als eigene **Durchführung**
gespeichert. Über das Auswahlfeld **„Termin auswählen“** oben wechseln Sie
zwischen ihnen; jede ist nach ihrem Datum benannt („Durchführung vom …“), die
neueste ist vorausgewählt, und eine noch laufende trägt den Zusatz „läuft
noch“. Daneben stehen die Zahl der Stimmen und der Papierkorb zum Löschen
genau dieser Durchführung.

Für jede Frage sehen Sie die Auswertung — Balken bei Auswahlfragen (richtige
Antworten grün mit „Richtig“), Likert-Verteilung, Prioritäten, Sortierung,
Wortwolke, Freitext, Mindmap und Vier-Felder-Matrix. Wurde mit dem
[Aufzeichnungsmodus](aufzeichnung.md) abgestimmt, weist die Auswertung die
Stimmen **vor Ort** und **aus der Aufzeichnung** getrennt aus.
[Vorher-Nachher-Fragen](fragen.md#vorher-nachher-fragen-experten-modus)
stehen gegenübergestellt.

Im Experten-Modus mit eingerichteter KI können Sie außerdem einen
**Kurzbericht erstellen**, Freitext auswerten und eine Wortwolke **mit KI
optimieren** (siehe [KI-Assistenz](ki-assistenz.md)).

### Mindmap und Vier-Felder-Matrix

- **Mindmap:** Der Begriffsbaum mit Anzahlen; nach einer Bewertung zusätzlich
  Balken an den Begriffen und eine **Rangliste**.
- **Vier-Felder-Matrix:** als Brett und als Liste der Karten nach Feldern
  gruppiert; ausgeblendete Karten und KI-Sammelkarten („Zusammenfassung“)
  sind markiert. Mit Bewertung kommen Balken an den Karten und eine Rangliste
  hinzu — solange die Bewertung noch verborgen läuft, erscheint stattdessen
  ein Hinweis.

## CSV-Export

Oben auf der Ergebnisseite wählen Sie den **Export-Umfang** — **nur dieser
Termin** (die ausgewählte Durchführung) oder **alle Termine (inkl. Archiv)** —
und laden die CSV-Datei herunter. Sie ist mit **Semikolon** getrennt und als
UTF-8 mit Kennung gespeichert, sodass ein deutsches Excel sie mit Umlauten
direkt öffnet.

Die Datei enthält **eine Zeile je Antwort, Begriff oder Karte, je Frage und je
Durchführung**. Die Spalten:

| Spalte | Inhalt |
|---|---|
| `durchfuehrung` | Nummer der Durchführung |
| `gestartet` | Beginn der Durchführung (Datum und Uhrzeit) |
| `frage_nr`, `frage` | Position und Text der Frage |
| `antwort` | Antworttext, Begriff, Mindmap-Pfad („Ast > Begriff“) oder Kartentitel |
| `richtig` | `x` bei richtigen Antworten |
| `stimmen` | Anzahl der Stimmen bzw. Nennungen |
| `vor_ort`, `aufzeichnung` | Aufteilung der Stimmen bei Abstimmung aus einer Aufzeichnung |
| `prozent` | bei der Likert-Skala der Anteil je Skalenstufe |
| `bewertung` | Ergebnis einer Bewertungsphase (Mindmap, Vier-Felder-Matrix) |
| `beschreibung`, `kategorie`, `zone`, `x`, `y`, `stapel` | nur Vier-Felder-Matrix: Details jeder Karte |

Einige Fragetypen nutzen die Spalten etwas anders:

- **Likert-Skala:** Nach den Skalenstufen folgen Zusammenfassungszeilen für
  die obere und die untere Hälfte der Skala, die neutrale Mitte und die
  Enthaltungen.
- **Prioritäten:** `stimmen`, `vor_ort` und `aufzeichnung` enthalten den
  Durchschnitt, das Minimum und das Maximum der Punkte.
- **Sortierung:** `stimmen` enthält, wie oft ein Element an der richtigen
  Stelle lag (in Prozent), `prozent` seine Position in der Lösung; eine
  Zusammenfassungszeile nennt den Anteil komplett richtiger Reihenfolgen.
- **Wortwolke und Freitext:** eine Zeile je Begriff bzw. Antwort, mit Ihren
  Zusammenführungen und ohne ausgeblendete Einträge.
- **Mindmap:** eine Zeile je sichtbarem Begriff.
- **Vier-Felder-Matrix:** eine Zeile je sichtbarer Karte; x und y liegen
  zwischen −1 und 1, `stapel` nennt den Stapel. Mit Bewertung ist die Spalte
  **bewertung** gefüllt: bei Punkten die Summe, bei Plus/Minus im Format
  „+3/−1 (2)“ (Zustimmung/Ablehnung und Saldo) – wie bei der Mindmap.

Solange die Ergebnisse einer Bewertungsphase noch verborgen sind, bleibt
`bewertung` leer.

## Archivieren oder löschen?

- **Archivieren** schließt die aktuelle Durchführung ab und bereitet eine
  leere vor: Die nächste Präsentation beginnt ohne Ergebnisse, die bisherigen
  bleiben als frühere Durchführung erhalten und lassen sich weiter auswählen
  und exportieren. Für Teilnehmende heißt das: Sie starten in der nächsten
  Präsentation neu; ihre früheren Antworten zählen dort nicht mit. Archivieren
  können Sie im Raum über das Archiv-Symbol am Set, im Menü des Sets
  (**Ergebnisse archivieren**) oder beim Start mit **Archivieren & neu
  starten**. Im einfachen Modus archiviert Abstimmbar automatisch, wenn Sie an
  einem anderen Tag erneut präsentieren.
- **Durchführung löschen** (Papierkorb neben der Auswahl) entfernt genau diese
  Durchführung mit allen Stimmen.
- **Alle löschen** entfernt alle Durchführungen des Sets, auch die
  archivierten. Gelöschte Ergebnisse lassen sich nicht wiederherstellen —
  exportieren Sie sie vorher, wenn Sie sie noch brauchen.

Ganze **Räume** archivieren Sie auf der Startseite — sie erscheinen dann unter
„Archivierte Räume“ und lassen sich wiederherstellen. Das Papierkorb-Symbol
an einem Set oder Raum **löscht endgültig** — mit allen Fragen und
Ergebnissen.
