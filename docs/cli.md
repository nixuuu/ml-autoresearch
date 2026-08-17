# CLI i operowanie runem

## Komendy

```text
ml-autoresearch run [config.json] [opcje]
ml-autoresearch resume <run-directory> [opcje]
ml-autoresearch pause <run-directory> [--reason TEXT]
ml-autoresearch stop <run-directory> [--reason TEXT]
ml-autoresearch enqueue <run-directory> <hypothesis> [opcje]
ml-autoresearch validate [config.json] [opcje]
ml-autoresearch status <run-directory>
ml-autoresearch report <run-directory>
ml-autoresearch serve <run-directory> [--port PORT] [--open]
ml-autoresearch skill [list]
ml-autoresearch skill show <name|all>
```

Brak ścieżki configu dla `run` i `validate` oznacza
`./autoresearch.config.json`.

## `validate`

Ładuje config, nakłada opcjonalne override'y i sprawdza walidacje krzyżowe oraz
dostępność runnera. Nie tworzy baseline i nie uruchamia płatnej sesji agenta.

```bash
ml-autoresearch validate autoresearch.config.json
```

Wynik podsumowuje m.in. model, reasoning, mutable paths, metryki, etapy,
statystykę, cache, open research, dependency broker, kampanię i execution pool.

## `run`

```bash
ml-autoresearch run autoresearch.config.json \
  --max-experiments 20 \
  --max-wall-time-minutes 120 \
  --model openai-codex/gpt-5.6-sol \
  --thinking-level xhigh \
  --open-ui
```

| Flaga | Znaczenie |
| --- | --- |
| `--max-experiments N` | dodatnia liczba eksperymentów; nadpisuje config |
| `--max-wall-time-minutes N` | limit aktywnego czasu; `0` oznacza unlimited |
| `--model PROVIDER/MODEL` | model implementera; override tworzy pojedynczy profil CLI |
| `--thinking-level LEVEL` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--reasoning LEVEL` | alias `--thinking-level`; nie można podać obu |
| `--ui-port PORT` | port dashboardu; `0` wybiera wolny port |
| `--open-ui` | otwiera dashboard w domyślnej przeglądarce |
| `--no-ui` | wyłącza dashboard i kończy proces po researchu |

Bez `--no-ui` proces pozostaje uruchomiony po zakończeniu kampanii, aby wyniki
były nadal dostępne. Pierwsze `Ctrl+C` podczas aktywnego runu prosi o przerwanie
na bezpiecznej granicy. Drugie wymusza `SIGKILL` zarejestrowanych grup
subprocesów. Po zakończeniu researchu pojedyncze `Ctrl+C` zamyka dashboard.

## `pause`, `resume` i `stop`

```bash
ml-autoresearch pause runs/<run-id> --reason "Okno maintenance"
ml-autoresearch resume runs/<run-id>
ml-autoresearch stop runs/<run-id> --reason "Kończymy kampanię"
```

- `pause` jest odwracalne i zaczyna obowiązywać na bezpiecznej granicy;
- `resume` kontynuuje kampanię z `config.resolved.json`, pamięcią, grafem i
  kolejką; jeśli żywy proces tylko czeka w stanie paused, CLI wysyła mu sygnał
  zamiast uruchamiać drugi harness;
- `stop` jest terminalne i tak zatrzymanego runu nie można wznowić;
- niedokończony katalog eksperymentu po awarii jest przenoszony do `orphaned/`.

## `enqueue`

Dodaje hipotezę człowieka do kontrolnej kolejki runu:

```bash
ml-autoresearch enqueue runs/<run-id> \
  "Sprawdź krótsze okno treningowe" \
  --expected-gain 0.002 \
  --probability 0.4 \
  --information-gain 0.8 \
  --estimated-cost 1.5
```

`probability` i `information-gain` muszą należeć do `[0, 1]`; pozostałe
wartości muszą być nieujemne. Komenda zapisuje append-only polecenie, a harness
przejmuje ticket w kontrolowanym momencie.

## Inspekcja i raport

```bash
ml-autoresearch status runs/<run-id>
ml-autoresearch report runs/<run-id>
```

`status` zwraca JSON z liderem, best observed, frontierami, kampanią, pamięcią,
kosztami i czasami. `report` regeneruje `REPORT.md` z zapisanych artefaktów; nie
uruchamia ponownie evaluatora.

## Osobny dashboard

```bash
ml-autoresearch serve runs/<run-id> --port 0 --open
```

`serve` działa również dla zakończonego runu, obserwuje pliki na dysku i
odtwarza zapisany progress oraz transcript. Serwer nasłuchuje wyłącznie na
`127.0.0.1`.

## Skille dla LLM-ów

```bash
ml-autoresearch skill list
ml-autoresearch skill show ml-autoresearch-design-scenario
ml-autoresearch skill show all
```

Dystrybucja zawiera instrukcje projektowania scenariusza, tworzenia configu,
budowania evaluatora i operowania CLI. Polecenia można przekierować do pliku lub
wkleić do rozmowy z innym agentem.
