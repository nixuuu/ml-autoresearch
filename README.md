# ML Autoresearch Harness

Kontrolowana pętla autonomicznych eksperymentów ML zbudowana na [Pi SDK](https://pi.dev/docs/latest/sdk), inspirowana minimalistycznym wzorcem [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

Agent Pi proponuje jedną zmianę i może edytować tylko jawnie dozwolone pliki. Osobny evaluator uruchamia powtarzalne próby, zapisuje metryki w ustalonym kontrakcie, a harness — nie agent — podejmuje decyzję `promote`, `retain`, `discard` albo `failure`. Oryginalny projekt nigdy nie jest modyfikowany: każdy kandydat działa w osobnej kopii.

`mutablePaths` może wskazywać jeden plik, wiele plików albo dedykowany katalog kandydata. Agent może więc w ramach jednej spójnej hipotezy zmieniać np. architekturę, konfigurację modelu i preprocessing, podczas gdy evaluator, split oraz holdout pozostają chronione.

## Co jest rejestrowane

- baseline oraz zagregowane metryki każdego eksperymentu;
- hipoteza, uzasadnienie, zmienione pliki i decyzja;
- seed, czas wykonania, exit code, timeout, stdout i stderr każdej próby;
- kompletny strumień zdarzeń Pi SDK w JSONL;
- append-only dziennik przebiegu, stan maszynowy i aktualizowany raport Markdown;
- osobne artefakty dla lidera zaakceptowanego przez politykę oraz najlepszego surowego wyniku — bez automatycznego nadpisywania źródeł;
- graf rodziców i alternatywny frontier checkpointów pozwalający na backtracking;
- automatycznie generowany diagram Mermaid z rodzicami, strategiami, wynikami i stanem węzłów;
- deterministyczne fakty harnessu, swobodny notatnik agenta, pytania z cyklem życia oraz prerejestrowane lekcje ze statusem dowodowym.

Log na żywo jest podzielony na jawne fazy `START`, `GOAL`, `AGENT`, `PROPOSAL`, `CHANGE`, `EVALUATION`, `RESULT`, `REFLECTION`, `CONCLUSION`, `DECISION`, `STATE` i `MEMORY`. Dzięki temu podczas długiej sesji widać, nad czym agent aktualnie pracuje, jakie wyniki uzyskała każda repetycja, kiedy zmienił się lider albo najlepszy surowy wynik oraz które wnioski, lekcje i pytania zostały utrwalone. Każda z tych linii trafia również do append-only `events.jsonl`.

Przykładowe kluczowe komunikaty:

```text
[autoresearch] exp-0002 RESULT: aggregate {validation_rmse=0.004771}; primary attempts [r1/seed=17:0.0048, ...]
[autoresearch] exp-0002 NEW LEADER: exp-0001 (validation_rmse=0.28217) -> exp-0002 (validation_rmse=0.004771)
[autoresearch] exp-0002 NEW BEST-OBSERVED: exp-0001 (...) -> exp-0002 (...) (decision=promote)
[autoresearch] exp-0002 CONCLUSION: Degree 3 captures the nonlinear signal without violating the parameter guardrail.
[autoresearch] exp-0002 MEMORY: opened question-0002: Test whether degree 4 adds a material gain.
```

## Szybki start

Wymagany jest Bun 1.3+ i skonfigurowane uwierzytelnienie Pi (np. przez `pi` i `/login` albo zmienną API odpowiedniego providera). Bun jest jednocześnie runtime'em, menedżerem paczek, test runnerem i kompilatorem aplikacji.

```bash
bun install
bun run typecheck
bun test

# Sprawdzenie konfiguracji przykładu
bun run dev validate examples/toy-regression/autoresearch.config.json

# Jedna iteracja z prawdziwym agentem Pi
bun run dev run examples/toy-regression/autoresearch.config.json --max-experiments 1

# 50 eksperymentów bez limitu wall time (zatrzymanie przez limit eksperymentów lub Ctrl+C)
bun run dev run examples/toy-regression/autoresearch.config.json \
  --max-experiments 50 \
  --max-wall-time-minutes 0 \
  --model openai-codex/gpt-5.6-sol \
  --thinking-level xhigh

# Podgląd trwającego lub zakończonego runu
bun run dev status examples/toy-regression/runs/<run-id>

# Lista instrukcji, które można przekazać agentowi/LLM-owi
bun run dev skill list
bun run dev skill show ml-autoresearch-design-scenario

# Samodzielny plik wykonywalny dla bieżącej platformy
bun run build
./dist/ml-autoresearch --help
```

## Skille dla agentów

Executable zawiera cztery skille opisujące cały proces: projektowanie scenariusza, tworzenie konfiguracji, budowanie deterministycznego evaluatora oraz bezpieczną obsługę CLI. `skill list` pokazuje katalog, a `skill show <name>` wypisuje kompletny plik `SKILL.md` na stdout. Można go wkleić do rozmowy z LLM-em albo przekazać przez pipe. `skill show all` zwraca cały zestaw.

Najlepszym punktem wejścia do nowego projektu jest:

```bash
./dist/ml-autoresearch skill show ml-autoresearch-design-scenario
```

Ten skill prowadzi agenta przez analizę projektu, wybór metryk i guardraili, przygotowanie evaluatora i configu oraz bezpieczny smoke test. Nie uruchamia długiego lub płatnego runu bez jawnej decyzji użytkownika.

## Pamięć badawcza i przeszukiwanie gałęzi

Każdy eksperyment używa świeżej sesji Pi, ale dostaje kontrolowany kontekst z poprzednich prób. Harness utrzymuje trzy oddzielne warstwy:

- fakty pomiarowe — niezmienne metryki, seedy, fingerprint workspace'u, rodzic, strategia i decyzja;
- notatnik agenta — swobodne obserwacje z fazy propozycji i wniosków, jawnie oznaczone jako interpretacje;
- lekcje — ustrukturyzowane twierdzenia `tentative`, `supported`, `contradicted`, `retired` albo `human-approved`;
- pytania badawcze — obiekty `open`, `resolved` albo `invalidated`, powiązane z eksperymentem i trwałym wnioskiem;
- audit dowodów — licznik lekcji aktualizują udane, prerejestrowane próby bezpośrednie oraz kontrolowane przez harness replikacje parowane na świeżych seedach; obserwacje kontekstowe i zwykłe dokładne replikacje pozostają w logu, ale nie udają niezależnego dowodu.

Scheduler miesza strategie `exploit`, `explore`, `backtrack`, `replicate` i `falsify`. `beamWidth` utrzymuje kilka różnorodnych checkpointów, a `maxTemporaryRegressionRatio` pozwala kontrolowanie przejść przez chwilowo gorszy wynik bez zmiany globalnego lidera.

```json
"learning": {
  "beamWidth": 3,
  "maxFrontierPerCategory": 1,
  "maxBranchDepth": 3,
  "maxTemporaryRegressionRatio": 0.05,
  "recentExperiments": 12,
  "maxContextLessons": 40,
  "supportThreshold": 2,
  "contradictionThreshold": 1,
  "strategy": {
    "explorationRate": 0.25,
    "backtrackRate": 0.1,
    "replicationRate": 0.1,
    "falsificationRate": 0.1
  },
  "humanLessons": [
    {
      "id": "human-fixed-budget",
      "claim": "Nie zwiększaj liczby kroków treningu.",
      "guidance": "avoid"
    }
  ]
}
```

Podane stawki nie mogą sumować się powyżej `1`; pozostała część budżetu przypada na `exploit`. Replication nie pozwala agentowi zmienić plików i nie promuje checkpointu na podstawie samego szumu pomiarowego.

Kategorie zmian są mapowane do kontrolowanej taksonomii, np. `regularization`, `model-architecture`, `optimization`, `data` i `features`. `maxFrontierPerCategory` zapobiega zajęciu całego frontiera przez różnie nazwane warianty tego samego kierunku.

Run zapisuje `research-memory.json`, czytelny `RESEARCH_MEMORY.md`, graf `frontier.json`, a także strukturalne `proposal.json` i `conclusion.json` każdego eksperymentu. `REPORT.md` zawiera generowany automatycznie diagram Mermaid. `accepted.json` wskazuje lidera polityki, a `best-observed.json` i kompatybilny alias `best.json` wskazują najlepszą zaobserwowaną wartość primary metric. Identyczny workspace lub identyczna hipoteza są pomijane przed kosztowną ewaluacją, poza jawnymi strategiami replikacji i falsyfikacji. Jeśli taki pominięty duplikat adresował otwarte pytanie, harness oznacza pytanie jako `invalidated` i odsyła do istniejącego dowodu, zamiast planować ten sam test w pętli.

### Kontrolowane porównania na świeżych seedach

Scenariusz może pozwolić agentowi prerejestrować dodatkowe parowane porównanie, bez przekazywania mu kontroli nad evaluatorem:

```json
"evaluator": {
  "command": ["python3", "evaluate.py"],
  "repetitions": 3,
  "seeds": [17, 29, 43],
  "agentRequests": {
    "allowPairedComparison": true,
    "maxSeeds": 5
  }
}
```

Agent może w `experiment_proposal` poprosić np. o seedy `59, 71, 89`. Harness odrzuca powtórzenia, seedy kanoniczne i żądania ponad limit. Następnie zawsze wykonuje ewaluację kanoniczną, a dodatkowo mierzy bieżącego lidera i kandydata na identycznych świeżych seedach. Promocja przechodzi tylko wtedy, gdy politykę spełnia zarówno porównanie kanoniczne, jak i parowane. Wyniki oraz stdout/stderr obu stron są w `experiments/<id>/paired-evaluation/`, a raport pokazuje status potwierdzenia.

Domyślny model wynika z konfiguracji Pi. Model i reasoning można przypiąć w configu albo nadpisać dla jednego uruchomienia:

```json
"agent": {
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "xhigh"
}
```

```bash
ml-autoresearch run autoresearch.config.json \
  --model openai-codex/gpt-5.6-sol \
  --reasoning xhigh
```

`--reasoning` jest aliasem `--thinking-level`. Jawny prefiks providera jest ważny, ponieważ ta sama nazwa modelu może istnieć u kilku providerów.

## Kontrakt evaluatora

Harness uruchamia `evaluator.command` bez shella. Proces otrzymuje:

- `AUTORESEARCH_METRICS_PATH` — docelowy plik JSON;
- `AUTORESEARCH_ARTIFACT_DIR` — katalog na checkpointy i dodatkowe artefakty;
- `AUTORESEARCH_SEED` — seed bieżącej repetycji;
- `AUTORESEARCH_EXPERIMENT_ID` — identyfikator eksperymentu.

Evaluator musi zakończyć się kodem `0` i zapisać:

```json
{
  "metrics": {
    "validation_loss": 0.123,
    "latency_ms": 18.4
  },
  "metadata": {
    "checkpoint": "model.bin"
  }
}
```

Każda skonfigurowana metryka musi być skończoną liczbą. Wynik podstawowy ma kierunek `minimize` albo `maximize` i wymagane `minimumDelta`. Guardraile mogą ustalać `min`, `max` oraz dopuszczalną regresję względem aktualnie zaakceptowanego wyniku. Repetycje mają jawne seedy i agregację `mean`, `median`, `min` lub `max`.

## Izolacja i bezpieczeństwo

Agent nie dostaje wbudowanych narzędzi `bash`, `edit` ani `write` Pi. Harness ładuje Pi bez extensionów, skilli i zewnętrznych plików kontekstu, a własne narzędzia blokują wyjście poza workspace, symlinki, zapis poza `project.mutablePaths` oraz każdą ścieżkę z `project.protectedPaths`. Pliki z `project.hiddenPaths` są kopiowane dla evaluatora, ale nie pojawiają się w listingu agenta i nie mogą być przez niego odczytane. Po pracy agenta i po evaluatorze sprawdzane są hashe wszystkich plików.

Tryb `local` jest wygodny, ale evaluator jest zaufanym procesem hosta — ograniczenia plików agenta nie są systemowym sandboxem dla uruchamianego kodu. Dla eksperymentów autonomicznych zalecany jest runner Docker:

```json
"runner": {
  "mode": "docker",
  "image": "python:3.13-slim",
  "cpus": 4,
  "memory": "8g",
  "network": "none",
  "readOnlyRoot": true,
  "pidsLimit": 256
}
```

W trybie Docker workspace jest montowany tylko do odczytu, katalog artefaktów do zapisu, root filesystem może być read-only, a sieć jest domyślnie wyłączona. Dla GPU można dodać `"gpus": "all"` i użyć obrazu zawierającego właściwy runtime CUDA. Dane i cache najlepiej udostępniać w kontrolowanym obrazie lub przez własny, audytowalny wrapper command.

## Adaptacja do własnego modelu

1. Umieść konfigurację obok projektu lub wskaż `project.sourceDir`.
2. Ustaw `mutablePaths` na najmniejszy sensowny obszar, ale nie sztucznie na jeden plik: może to być kilka jawnych plików albo dedykowany katalog modelu.
3. Nie umieszczaj evaluatora w `mutablePaths`; dodaj jego kod do `protectedPaths`, a ukryty holdout, targety i prywatną logikę scoringu również do `hiddenPaths`.
4. Zapewnij stały split danych, porównywalny budżet treningu i deterministyczne seedy.
5. Wybierz jedną metrykę podstawową oraz metryki bezpieczeństwa/kosztu jako guardraile.
6. Zacznij od 2–3 repetycji i `minimumDelta` większego niż typowy szum pomiarowy.
7. Najpierw uruchom `validate`, potem krótki run z jedną iteracją, a dopiero później dłuższy budżet.
8. Ustaw dopuszczalną tymczasową regresję i szerokość frontiera odpowiednio do skali oraz kosztu eksperymentu.

Najważniejsze pliki implementacji: `src/pi-researcher.ts` (Pi SDK i ograniczone narzędzia), `src/evaluator.ts` (procesy, Docker, timeouty i metryki), `src/metrics.ts` (agregacja i decyzje) oraz `src/harness.ts` (pętla i audit trail).
