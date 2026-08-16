# ML Autoresearch Harness

Kontrolowana pętla autonomicznych eksperymentów ML zbudowana na [Pi SDK](https://pi.dev/docs/latest/sdk), inspirowana minimalistycznym wzorcem [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

Projekt jest greenfield: nowe pola konfiguracji i nowe artefakty kampanii dotyczą
przyszłych runów. Istniejące katalogi `runs/` pozostają niezmienione i nie są
automatycznie migrowane.

Agent Pi proponuje jedną zmianę i może edytować tylko jawnie dozwolone pliki. Osobny evaluator uruchamia powtarzalne próby, zapisuje metryki w ustalonym kontrakcie, a harness — nie agent — podejmuje decyzję `promote`, `retain`, `discard`, `inconclusive`, `pruned` albo `failure`. Źródłowe pliki modelu nie są modyfikowane: każdy kandydat działa w osobnej kopii. Jedynym opcjonalnym zapisem na poziomie projektu jest jawnie skonfigurowany plik `knowledge.path` z wiedzą przenoszoną między runami.

`mutablePaths` może wskazywać jeden plik, wiele plików albo dedykowany katalog kandydata. Agent może więc w ramach jednej spójnej hipotezy zmieniać np. architekturę, konfigurację modelu i preprocessing, podczas gdy evaluator, split oraz holdout pozostają chronione.

## Co jest rejestrowane

- baseline oraz zagregowane metryki każdego eksperymentu;
- hipoteza, uzasadnienie, zmienione pliki i decyzja;
- seed, czas wykonania, exit code, timeout, stdout i stderr każdej próby;
- kompletny strumień zdarzeń Pi SDK w JSONL;
- append-only dziennik przebiegu, stan maszynowy, aktualizowany raport Markdown i lokalny dashboard live;
- osobne artefakty dla lidera zaakceptowanego przez politykę oraz najlepszego surowego wyniku — bez automatycznego nadpisywania źródeł;
- graf rodziców i alternatywny frontier checkpointów pozwalający na backtracking;
- automatycznie generowany diagram Mermaid z rodzicami, strategiami, wynikami i stanem węzłów;
- deterministyczne fakty harnessu, swobodny notatnik agenta, pytania z cyklem życia oraz prerejestrowane lekcje ze statusem dowodowym.

Log na żywo jest podzielony na jawne fazy `START`, `GOAL`, `AGENT`, `PROPOSAL`, `CHANGE`, `EVALUATION`, `RESULT`, `REFLECTION`, `CONCLUSION`, `DECISION`, `STATE` i `MEMORY`. Dashboard odbiera je przez SSE, dlatego podczas długiej sesji widać, nad czym agent aktualnie pracuje, jakie wyniki uzyskała każda repetycja, kiedy zmienił się lider albo najlepszy surowy wynik oraz które wnioski, lekcje i pytania zostały utrwalone. Każda z tych linii trafia również do append-only `events.jsonl`.

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
bun run dev serve examples/toy-regression/runs/<run-id> --open

# Lista instrukcji, które można przekazać agentowi/LLM-owi
bun run dev skill list
bun run dev skill show ml-autoresearch-design-scenario

# Samodzielny plik wykonywalny dla bieżącej platformy
bun run build
./dist/ml-autoresearch --help
```

## Dashboard live

Komenda `run` domyślnie uruchamia frontend na `127.0.0.1` i losowym wolnym porcie. CLI wypisuje tylko adres dashboardu oraz końcową ścieżkę raportu; szczegółowy progress jest streamowany przez SSE do przeglądarki. Dashboard pokazuje:

- bieżącą fazę pracy agenta i live log;
- lidera polityki, najlepszy zaobserwowany checkpoint i poprawę względem baseline;
- wykres primary metric, gdzie poprawa jest zielona, a regresja czerwona;
- interaktywny graf branchowania zbudowany przy użyciu Svelte Flow;
- historię eksperymentów i podstronę każdego eksperymentu z hipotezą, próbami evaluatora, decyzją, fresh-seed confirmation, wnioskiem i pamięcią.

```bash
# Losowy port; adres zostanie wypisany na stdout
ml-autoresearch run autoresearch.config.json

# Otwórz dashboard automatycznie; po zakończeniu runu pozostaje dostępny do Ctrl+C
ml-autoresearch run autoresearch.config.json --open-ui

# Wymuś port albo wróć do pełnego logu terminalowego bez UI
ml-autoresearch run autoresearch.config.json --ui-port 4317
ml-autoresearch run autoresearch.config.json --no-ui

# Ponowne otwarcie dashboardu dla zakończonego lub zewnętrznie trwającego runu
ml-autoresearch serve path/to/runs/<run-id> --port 0 --open
```

Po zakończeniu `run` lub `resume` dashboard pozostaje dostępny, a proces czeka na `Ctrl+C`. Dzięki temu można bez pośpiechu przeglądać raport, graf i szczegóły eksperymentów. `--no-ui` wyłącza serwer i pozwala procesowi zakończyć się od razu po researchu. Nowa instancja `serve` odtwarza ograniczoną historię komunikatów z `events.jsonl`, więc zakończony run nie traci widoku progressu. Port `0` oznacza losowy wolny port. Serwer nasłuchuje wyłącznie na loopbacku i udostępnia tekst propozycji oraz wniosków tylko wtedy, gdy ich ścieżki pozostają wewnątrz wskazanego katalogu runu.

Frontend jest aplikacją SvelteKit z `adapter-static`. `bun run build` najpierw buduje statyczne assety, następnie osadza je razem ze Svelte Flow w pojedynczym `dist/ml-autoresearch` i kompiluje executable przez Bun. `bun run dev` również odświeża frontend przed uruchomieniem CLI.

### Sterowanie kampanią

Run może być pauzowany i wznowiony bez usuwania jego artefaktów. `stop` jest decyzją terminalną dla kampanii — zatrzymanego w ten sposób runu nie można później wznowić. Polecenia zapisują wersjonowany stan kontrolny i append-only komendy w katalogu runu; harness stosuje je na bezpiecznej granicy eksperymentu, a blokada plikowa chroni polecenie operatora przed nadpisaniem przez równoczesny heartbeat.

```bash
ml-autoresearch pause path/to/runs/<run-id>    # dokończ bieżący eksperyment, potem wstrzymaj kolejkę
ml-autoresearch resume path/to/runs/<run-id>   # kontynuuj z zapisanej kolejki i pamięci
ml-autoresearch stop path/to/runs/<run-id>     # zakończ kampanię bez kasowania wyników
ml-autoresearch enqueue path/to/runs/<run-id> "Sprawdź mniejszy learning rate" \
  --expected-gain 0.01 --probability 0.4 --information-gain 0.8 --estimated-cost 1
```

`enqueue` dodaje ludzki ticket `hypothesis` wraz z opcjonalnym oczekiwanym zyskiem, prawdopodobieństwem, wartością informacyjną i kosztem. Tickety `search`, `ablation` i `merge` tworzy scheduler na podstawie skonfigurowanej przestrzeni oraz wyników kampanii. Deduplikacja następuje przy przejęciu pracy przez harness. `pause`, `resume` i `stop` nie modyfikują źródłowego projektu; aktualizują wyłącznie kontrolne artefakty runu.

Jeśli proces harnessu już nie działa, `pause` i `stop` aktualizują również `state.json`, dzięki czemu status CLI i dashboardu nie pozostaje fałszywie `running`. `pause` zachowuje możliwość późniejszego `resume`; `stop` finalizuje kampanię.

Jeśli proces harnessu nadal żyje i czeka w stanie `paused`, `resume` tylko wysyła mu sygnał przez `control.json`; nie uruchamia drugiego procesu. Gdy proces już nie istnieje, `resume` odtwarza konfigurację z `config.resolved.json`, zachowuje baseline, pamięć, kampanię i graf, a niedokończony katalog kolejnego eksperymentu przenosi do `orphaned/` przed ponowieniem.

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

Run zapisuje `research-memory.json`, czytelny `RESEARCH_MEMORY.md`, graf `frontier.json`, a także strukturalne `proposal.json` i `conclusion.json` każdego eksperymentu. `REPORT.md` zawiera generowany automatycznie diagram Mermaid. `accepted.json` wskazuje lidera polityki, a `best-observed.json` wskazuje najlepszą zaobserwowaną wartość primary metric. Identyczny workspace lub identyczna hipoteza są pomijane przed kosztowną ewaluacją, poza jawnymi strategiami replikacji i falsyfikacji. Jeśli taki pominięty duplikat adresował otwarte pytanie, harness oznacza pytanie jako `invalidated` i odsyła do istniejącego dowodu, zamiast planować ten sam test w pętli.

### Kampania, search space i eksperymenty złożone

Poza liniowym wybieraniem kolejnego eksperymentu harness może prowadzić kolejkę ticketów kampanii. Ticket ma typ `hypothesis`, `search`, `ablation` albo `merge`, priorytet wynikający z oczekiwanego zysku, prawdopodobieństwa powodzenia, wartości informacyjnej i kosztu, a także zależności oraz status `queued`, `running`, `completed`, `cancelled` lub `blocked`. Deduplikacja jest wykonywana przed kosztowną ewaluacją, a anulowany/stale ticket blokuje zależne zadania zamiast uruchamiać je bez prerekwizytów.

Własny zakres parametrów można opisać w sekcji `search`. Obsługiwane są parametry `float`, `integer`, `categorical` i `boolean`, zakres liniowy lub logarytmiczny, stały seed oraz deterministyczne sugestie. Scheduler może próbkować globalnie albo lokalnie wokół aktualnego lidera; harness nakłada wartości na JSON po bezpiecznych dotted paths, zapisuje je jako strukturalną propozycję i przepuszcza przez te same kontrole mutable/protected/hidden paths.

Po promocji złożonej zmiany kampania może utworzyć ablations usuwające pojedyncze elementy diffu oraz merge ticket łączący niezależne gałęzie. Merge odtwarza kompletny diff drugiej gałęzi od najniższego wspólnego przodka i uwzględnia głębokość obu źródeł. Dzięki temu wynik nie kończy się na „checkpoint działa”, ale może ustalić, która część zmiany była konieczna i czy dwa niezależne ulepszenia są kompatybilne.

```json
"search": {
  "enabled": true,
  "seed": 2027,
  "exploitationRatio": 0.55,
  "parameters": [
    { "name": "learning_rate", "file": "experiment.json", "path": "optimizer.learning_rate", "type": "float", "min": 0.0001, "max": 0.1, "scale": "log" },
    { "name": "depth", "file": "experiment.json", "path": "model.depth", "type": "integer", "min": 2, "max": 12 },
    { "name": "activation", "file": "experiment.json", "path": "model.activation", "type": "categorical", "values": ["relu", "gelu"] },
    { "name": "use_bias", "file": "experiment.json", "path": "model.use_bias", "type": "boolean" }
  ]
},
"execution": {
  "experimentConcurrency": 2,
  "resourceSlots": ["gpu-0", "gpu-1"]
}
```

`experimentConcurrency` równolegli wyłącznie niezależne kandydatury generowane przez deterministyczny search. Każda dostaje osobny workspace i etykietę `AUTORESEARCH_RESOURCE_SLOT` z odpowiadającej pozycji `resourceSlots`. Eksperymenty agentowe, ablations, merges i gałęzie zależne pozostają sekwencyjne, aby każda decyzja korzystała z najnowszej pamięci i lidera. Po zakończeniu batcha tylko najsilniejszy kandydat spełniający próg może promować lidera; pozostałe mogą wejść na frontier/Pareto. Błąd przygotowania lub ewaluacji jednego kandydata tworzy jego własny rekord `failure` i nie przerywa pozostałych prac w batchu.

### Ewaluacja etapowa i statystyka adaptacyjna

`evaluator.stages` umożliwia tani screening przed pełnym canonical runem. Każdy etap ma własny `budgetRatio`, liczbę repetycji, timeout i `pruneIfClearlyWorse`. Evaluator dostaje nazwę etapu oraz ratio przez `AUTORESEARCH_STAGE` i `AUTORESEARCH_BUDGET_RATIO`, więc może proporcjonalnie zmniejszyć liczbę kroków treningu, bez zmiany seedów ani kontraktu metryk. Regresja na wcześniejszym etapie może zakończyć kandydata i oszczędzić compute.

`evaluator.statistics` włącza przedziały ufności, equivalence margin i adaptacyjne dokładanie seedów, gdy porównanie jest `inconclusive`. Wyniki zachowują surowe próby, agregaty, odchylenie, przedziały oraz status `improvement`, `regression`, `equivalent` lub `inconclusive`. Dotyczy to również prerejestrowanych porównań fresh-seed; brak potwierdzenia blokuje promocję. `computeSavedRatio` uwzględnia koszt obu stron porównania. To pozwala nie promować zwycięstwa mieszczącego się w szumie pomiarowym.

```json
"evaluator": {
  "stages": [
    { "name": "smoke", "budgetRatio": 0.1, "repetitions": 1, "pruneIfClearlyWorse": true },
    { "name": "screening", "budgetRatio": 0.35, "repetitions": 2, "pruneIfClearlyWorse": true },
    { "name": "canonical", "budgetRatio": 1, "repetitions": 5, "pruneIfClearlyWorse": false }
  ],
  "statistics": {
    "enabled": true,
    "confidenceLevel": 0.95,
    "equivalenceMargin": 0.001,
    "minimumSeeds": 3,
    "maximumSeeds": 15,
    "seedStep": 2
  },
  "repetitionConcurrency": 2
}
```

### Multi-objective i Pareto frontier

`metrics.primary` pozostaje głównym kryterium promocji, a `metrics.objectives` opisuje dodatkowe cele, np. latency, VRAM, rozmiar modelu albo jakość na trudnym slice danych. Gdy `metrics.pareto.enabled` jest włączone, harness oznacza kandydatów niedominowanych i nie redukuje całego wyboru do jednej arbitralnej sumy. Niedominowany checkpoint nie jest usuwany tylko dlatego, że nie zmieścił się w beamie sortowanym po primary metric — pozostaje osiągalną alternatywą. Guardraile nadal są twardymi ograniczeniami, natomiast Pareto frontier pokazuje kompromisy, które człowiek może wybrać przed deploymentem.

Przykład evaluatora toy raportuje oprócz `validation_rmse` również `slice_center_rmse`, `slice_edge_rmse`, `slice_negative_rmse` i `slice_positive_rmse`. Dzięki temu globalna poprawa nie ukrywa regresji na konkretnym obszarze danych.

### Wiedza projektu i role agentów

`knowledge` utrwala wiedzę między przyszłymi runami z fingerprintem zakresu, evaluatora i datasetu. Wpis z innego kontekstu nie jest automatycznie prawdą: trafia do nowego runu jako kandydacka obserwacja wymagająca transfer validation. To oddziela pamięć konkretnej kampanii od sprawdzonych faktów projektu.

Mechanizm jest domyślnie wyłączony. Po włączeniu dodaj katalog zawierający `knowledge.path` (np. `.autoresearch`) do `project.copyIgnore`; zależnie od tego, czy wiedza ma być współdzielona przez repozytorium, dodaj go również do `.gitignore` albo świadomie wersjonuj.

Przy większych kampaniach można skonfigurować pulę modeli implementujących zmiany oraz niezależne role `implementer` i `reviewer`. Reviewer ma osobny profil modelu/reasoningu i wyłącznie narzędzia read-only; może odrzucić zmianę przed kosztowną ewaluacją. Meta-research mierzy skuteczność profili implementerów i strategii po rozgrzewce, utrzymując minimalny poziom eksploracji zamiast na stałe faworyzować jedną ścieżkę.

```json
"agent": {
  "pool": [
    { "id": "sol", "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "xhigh" },
    { "id": "luna", "model": "openai-codex/gpt-5.6-luna", "thinkingLevel": "max" }
  ],
  "roles": {
    "reviewer": { "id": "reviewer", "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" }
  }
},
"knowledge": {
  "enabled": true,
  "path": ".autoresearch/project-knowledge.json",
  "scope": { "dataset": "v3", "evaluator": "v2" },
  "minimumConfidence": 0.7
}
```

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
- `AUTORESEARCH_EXPERIMENT_ID` — identyfikator eksperymentu;
- `AUTORESEARCH_STAGE` — nazwa etapu, np. `smoke`, `screening` albo `canonical`;
- `AUTORESEARCH_BUDGET_RATIO` — ułamek budżetu przypisany do bieżącego etapu, w zakresie `(0, 1]`.

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

Evaluator powinien używać `AUTORESEARCH_BUDGET_RATIO` do kontrolowanego skrócenia treningu lub próbkowania na etapach screeningowych, a `AUTORESEARCH_STAGE` zapisywać w metadatach. Nie zmieniaj na tej podstawie definicji metryk ani splitu; etap ma być tańszą obserwacją tego samego kandydata. Dodatkowe metryki slice'ów mogą być rejestrowane jako osobne cele Pareto, np. `slice_edge_rmse` albo `rare_class_recall`.

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
