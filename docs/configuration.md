# Konfiguracja harnessu

Konfiguracja jest plikiem JSON zgodnym z `autoresearch.schema.json`. Aktualna wersja kontraktu to `2`. Ścieżki `sourceDir`, `outputDir`, `knowledge.path`, `evaluator.cache.path` i `runtimeDependencies.cachePath` są rozwiązywane względem katalogu pliku konfiguracyjnego. Opcjonalne `agent.backend`, `agent.lab`, `agent.orchestration` i `learning.refinement` opisuje [agent-backends.md](./agent-backends.md). Telemetria procesu Prime Agent jest domyślnie wyłączona przez `agent.backend.telemetry.enabled=false`.

Minimalny szkielet:

```json
{
  "$schema": "./autoresearch.schema.json",
  "version": 2,
  "name": "my-research",
  "project": {
    "sourceDir": ".",
    "mutablePaths": ["candidate"],
    "protectedPaths": ["evaluate.py"],
    "hiddenPaths": ["data/holdout.csv"],
    "copyIgnore": ["runs", ".autoresearch"]
  },
  "evaluator": {
    "command": ["python3", "evaluate.py"]
  },
  "metrics": {
    "primary": {
      "name": "validation_loss",
      "direction": "minimize",
      "minimumDelta": 0.001
    }
  },
  "budget": {},
  "outputDir": "runs",
  "researchInstructions": "Improve validation_loss without changing the evaluator."
}
```

Powyższe `"$schema": "./autoresearch.schema.json"` zakłada config i schema w
tym samym katalogu. W podkatalogu ustaw ścieżkę względną do faktycznego
położenia schema (przykłady repozytorium używają `../../autoresearch.schema.json`).

Wymagane sekcje/pola to `version`, `name`, `project`, `evaluator`, `metrics`, `budget` i `researchInstructions`. Niepuste `project.mutablePaths` oraz niepusta tablica `evaluator.command` są obowiązkowe.

## `project`: granice workspace'u

| Pole | Wymagane | Domyślnie | Znaczenie |
|---|---:|---:|---|
| `sourceDir` | tak | — | Źródło kopiowane do izolowanych workspace'ów. |
| `mutablePaths` | tak | — | Pliki/katalogi, które agent może zmieniać. Nie może być puste. |
| `protectedPaths` | nie | `[]` | Ścieżki, których agent nie może modyfikować. |
| `hiddenPaths` | nie | `[]` | Kopiowane do ewaluacji, ale niewidoczne dla narzędzi agenta i open-research analysis. |
| `copyIgnore` | nie | `[]` | Ścieżki pomijane przy kopiowaniu, np. `runs` i `.autoresearch`. |

Ścieżka nie może jednocześnie należeć do `hiddenPaths` i `mutablePaths`. `hiddenPaths` ogranicza widoczność agenta, lecz nie jest sandboxem dla niezaufanego kodu uruchomionego przez evaluator.

## `agent`: model, role i analizy

```json
{
"agent": {
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "xhigh",
  "systemPrompt": "Prefer controlled, falsifiable changes.",
  "pool": [
    { "id": "fast", "model": "openai-codex/gpt-5.6-luna", "thinkingLevel": "high" }
  ],
  "roles": {
    "implementer": { "id": "builder", "thinkingLevel": "xhigh" },
    "reviewer": { "id": "critic", "thinkingLevel": "high" }
  }
}
}
```

`thinkingLevel` przyjmuje `off`, `minimal`, `low`, `medium`, `high`, `xhigh` albo `max`; domyślnie `high`. Identyfikatory w `pool` muszą być unikalne. Profile ról mogą nadpisać model, reasoning i prompt; brakujące wartości dziedziczą z głównego profilu.

Opcjonalne `agent.analysis` udostępnia agentowi audytowane wykonywanie dowolnych argv (`research_exec`):

```json
{
"agent": {
"analysis": {
  "enabled": true,
  "timeoutSeconds": 300,
  "maxCalls": 30,
  "maxOutputBytes": 262144,
  "minimumCallsBeforeProposal": 0,
  "inheritEnv": [],
  "env": {},
  "runtime": {
    "pythonCommand": ["python3"],
    "testCommand": ["python3", "-m", "pytest", "candidate/tests"],
    "projectPathEntries": [".", "candidate"]
  },
  "jobs": {
    "enabled": true,
    "maxConcurrent": 2
  },
  "evidence": {
    "requireFreshAfterMutation": true,
    "autoPublishToLab": true
  },
  "runner": {
    "mode": "docker",
    "image": "research-runtime:latest",
    "cpus": 2,
    "memory": "4g",
    "network": "none",
    "readOnlyRoot": true,
    "pidsLimit": 128
  }
}
}
}
```

Domyślne limity to 300 s, 30 wywołań i 262144 B wyniku. `runtime.pythonCommand` wskazuje kanoniczny interpreter używany przez `research_python`, a opcjonalny `testCommand` przez `research_test`. `projectPathEntries` są dodawane do `PYTHONPATH` zarówno lokalnie, jak i w kontenerze; dzięki temu analiza używa tych samych importów projektu zamiast przypadkowego interpretera lub katalogu roboczego. `research_runtime_info` pokazuje finalne komendy, overlay zależności i fingerprint środowiska.

`jobs` udostępnia `research_exec_start`, `research_exec_status` i `research_exec_cancel`; maksymalna współbieżność wynosi domyślnie `2`. Agent nie może zakończyć proposal, gdy job nadal działa. Każde polecenie zapisuje dowód z fingerprintem runtime'u i aktualnego kandydata. Po `research_write` lub `research_replace` wcześniejsze dowody są oznaczane jako nieaktualne. Przy domyślnym `evidence.requireFreshAfterMutation=true` proposal po zmianie kodu musi wskazać co najmniej jeden świeży, udany `evidenceId` w `analysisEvidence`. `autoPublishToLab=true` kopiuje metadane dowodów do trwałego Research Lab, aby kolejne eksperymenty nie powtarzały diagnostyki bez potrzeby.

Runner analysis domyślnie jest dockerowy, z `network: "none"`, read-only root i limitem 256 procesów. Docker wymaga `image`. Tryb `local` wymaga jawnego `allowHostExecution: true`; uruchamiany proces ma wtedy uprawnienia konta użytkownika i nie jest izolowany systemowo.

## `evaluator`

Najważniejsze ustawienia:

| Pole | Domyślnie | Uwagi |
|---|---:|---|
| `command` | — | Wymagana, niepusta tablica argv; bez shella. |
| `timeoutSeconds` | `600` | Limit pojedynczej próby, o ile stage go nie nadpisze. |
| `repetitions` | `1` | Liczba prób bez nadpisania w stage. |
| `seeds` | `[17,29,43]` | Unikalne, nieujemne liczby całkowite. |
| `repetitionConcurrency` | `1` | Równoległość prób tego samego stage. |
| `inheritEnv` | `PATH, HOME, TMPDIR, VIRTUAL_ENV, CUDA_VISIBLE_DEVICES` | Jawna allowlista dziedziczonego env. |
| `env` | `{}` | Stałe zmienne evaluatora. |

### Etapy, statystyka i oszczędzanie compute

```json
{
"evaluator": {
  "command": ["python3", "evaluate.py"],
  "timeoutSeconds": 600,
  "repetitions": 3,
  "seeds": [17, 29, 43, 59, 71],
  "repetitionConcurrency": 2,
  "stages": [
    { "name": "smoke", "budgetRatio": 0.15, "repetitions": 1, "timeoutSeconds": 60, "pruneIfClearlyWorse": true },
    { "name": "screen", "budgetRatio": 0.4, "repetitions": 2, "pruneIfClearlyWorse": true },
    { "name": "canonical", "budgetRatio": 1, "repetitions": 3, "pruneIfClearlyWorse": false }
  ],
  "statistics": {
    "enabled": true,
    "confidenceLevel": 0.95,
    "equivalenceMargin": 0.001,
    "minimumSeeds": 2,
    "maximumSeeds": 5,
    "seedStep": 1
  }
}
}
```

Bez `stages` powstaje jeden stage `canonical` z `budgetRatio: 1`. Nazwy muszą być unikalnymi bezpiecznymi segmentami (`A-Z`, `a-z`, cyfry, `.`, `_`, `-`). `budgetRatio` należy do `(0,1]`, nie może maleć, a ostatni stage musi mieć dokładnie `1`. Domyślne `pruneIfClearlyWorse` jest prawdziwe dla wszystkich etapów poza ostatnim.

Statystyka jest domyślnie włączona. Domyślne: confidence 0.95, equivalence margin równe `metrics.primary.minimumDelta`, `minimumSeeds=min(repetitions,3)`, `maximumSeeds=repetitions`, `seedStep=2`. `minimumSeeds <= maximumSeeds`; gdy statystyka jest włączona, ostatni stage nie może wymagać więcej repetycji niż `maximumSeeds`. `seeds` musi pokrywać maksimum wymagane przez stage/statystykę.

### Preflight, checkpointing, telemetry i cache

```json
{
"evaluator": {
  "command": ["python3", "evaluate.py"],
  "preflight": {
    "enabled": true,
    "command": ["python3", "preflight.py"],
    "timeoutSeconds": 60
  },
  "checkpointing": { "enabled": true, "manifestName": "checkpoint.json" },
  "telemetry": { "enabled": true },
  "cache": {
    "enabled": true,
    "path": ".autoresearch/cache",
    "namespace": "dataset-v3-evaluator-v2",
    "readOnly": false,
    "results": true
  },
  "agentRequests": { "allowPairedComparison": true, "maxSeeds": 5 }
}
}
```

Sekcje te są opt-in; jeśli sekcja istnieje, jej `enabled` domyślnie wynosi `true`. Preflight wymaga niepustej komendy. Checkpointing wymaga co najmniej dwóch stage'y, a `manifestName` musi być bezpieczną nazwą pliku. Cache tworzy `<path>/<namespace>`; namespace jest pojedynczym bezpiecznym segmentem. `results: true` nie może być łączone z `readOnly: true`.

Cache może przechowywać foldy, splity, zdekodowane dane i embeddingi. Harness nie narzuca formatu: evaluator odpowiada za fingerprinty, blokady i atomowe zapisy. `results: true` dodatkowo włącza exact-result cache oparty m.in. o fingerprint workspace'u, komendę/env evaluatora, runner, namespace, seed i stage. Zmień namespace przy zmianie datasetu, splitu, środowiska lub semantyki evaluatora.

Evaluator może dodatkowo zwracać `metadata.prediction_sha256`, `candidate_capabilities` i `consumed_search_parameters`. Jest to opcjonalny kontrakt semantyczny opisany w [kontrakcie evaluatora](evaluator-contract.md#semantyczny-fingerprint-i-aktywność-parametrów). Pozwala przerwać kosztowny semantic no-op po pierwszym stage'u.

Parametr search może wymagać capability i zostać automatycznie wycofany po powtarzalnych no-opach:

```json
{
  "search": {
    "retireAfterSemanticNoOps": 2,
    "parameters": [{
      "name": "weight",
      "file": "candidate/config.json",
      "path": "model.weight",
      "type": "float",
      "min": 0,
      "max": 1,
      "requiresCapability": "weighted-model-v2"
    }]
  }
}
```

`requiresCapability` jest twardym warunkiem tylko wtedy, gdy zostało skonfigurowane. Optimizer wybiera najlepszy checkpoint deklarujący wymagane capability. `retireAfterSemanticNoOps` domyślnie wynosi `2`; `0` wyłącza automatyczne wycofywanie.

W `agent.analysis` opcjonalne `minimumCallsBeforeProposal` (domyślnie `0`) wymusza minimalną liczbę wywołań `research_exec`. Lista faktycznie dostępnych narzędzi jest zapisywana w transcripcie podczas konfiguracji sesji.

Runner:

```json
{
"evaluator": {
"runner": {
  "mode": "docker",
  "image": "research-runtime@sha256:...",
  "cpus": 4,
  "memory": "8g",
  "network": "none",
  "gpus": "all",
  "readOnlyRoot": true,
  "pidsLimit": 512
}
}
}
```

Domyślny runner evaluatora to `local`. Docker wymaga `image`; domyślnie wyłącza sieć, ma read-only root i limit 512 procesów. Workspace jest montowany read-only, artefakty osobno read-write. Tryb `remote` wymaga zaufanego brokera JSONL w `runner.remote.command`; jego kontrakt opisuje [remote-executor.md](./remote-executor.md). Szczegółowy protokół procesu lokalnego/Docker opisuje [evaluator-contract.md](./evaluator-contract.md).

Jeśli agent ma móc kontrolowanie doinstalowywać allowlistowane paczki, skonfiguruj także `runtimeDependencies`. Wymaga to dockerowego analysis i evaluatora; pełna polityka, scope `analysis`/`candidate`, lock i profile są opisane w [runtime-dependencies.md](./runtime-dependencies.md).

## `metrics`

```json
{
"metrics": {
  "primary": {
    "name": "hit_rate",
    "direction": "maximize",
    "format": "percentage",
    "minimumDelta": 0.002,
    "aggregation": "median"
  },
  "guardrails": [
    { "name": "latency_ms", "direction": "minimize", "aggregation": "max", "max": 200, "maxRegression": 25 }
  ],
  "objectives": [
    { "name": "rare_class_recall", "direction": "maximize", "format": "percentage", "aggregation": "median", "weight": 1 }
  ],
  "pareto": { "enabled": true }
}
}
```

`direction`: `minimize`/`maximize`; `aggregation`: `mean`, `median`, `min`, `max` (domyślnie `median`); `format`: `number` lub `percentage` (domyślnie `number`). Percentage jest wyłącznie formatem prezentacji: evaluator zapisuje ułamek (`0.42` = 42%), a wszystkie progi pozostają w surowej skali.

Nazwy primary, guardrails i objectives muszą być globalnie unikalne. `minimumDelta` domyślnie 0. Guardrail może zawierać `min`, `max`, `maxRegression`. Objective ma dodatnią wagę (domyślnie 1). Pareto domyślnie włącza się, gdy istnieją objectives.

## `budget`

```json
{
"budget": {
  "maxExperiments": 50,
  "maxWallTimeMinutes": 0,
  "maxConsecutiveFailures": 3
}
}
```

Domyślne wartości to odpowiednio 20, 480 minut i 3. `maxWallTimeMinutes: 0` oznacza brak limitu czasu. CLI może nadpisać liczbę eksperymentów i wall time dla danego uruchomienia.

## `learning`: pamięć i polityka kampanii

Główne defaulty: `beamWidth=3`, `maxBranchDepth=3`, `maxTemporaryRegressionRatio=0.05`, `recentExperiments=12`, `maxContextLessons=40`, `supportThreshold=2`, `contradictionThreshold=1`, `maxFrontierPerCategory=1`.

```json
{
"learning": {
  "beamWidth": 4,
  "maxBranchDepth": 5,
  "strategy": {
    "explorationRate": 0.25,
    "backtrackRate": 0.1,
    "replicationRate": 0.1,
    "falsificationRate": 0.1,
    "optimizeRate": 0.1,
    "mergeRate": 0.05,
    "ablationRate": 0.05
  },
  "humanLessons": [
    { "id": "no-leakage", "claim": "Never derive features from holdout labels.", "guidance": "avoid" }
  ],
  "campaign": {
    "enabled": true,
    "queueRate": 0.35,
    "maxQueued": 40,
    "hypothesesPerProposal": 4,
    "autoAblations": true,
    "maxAblationsPerPromotion": 3,
    "autoMerge": true,
    "semanticClaimThreshold": 0.65
  },
  "meta": { "enabled": true, "updateInterval": 5, "warmupExperiments": 5, "explorationFloor": 0.05 },
  "acquisition": { "enabled": true, "minimumObservations": 5, "explorationFloor": 0.1 },
  "ensemble": { "enabled": true, "minimumMembers": 2, "maximumMembers": 4, "interval": 5 },
  "sliceDiscovery": { "enabled": true, "minimumSamples": 30, "maximumTickets": 3, "regressionThreshold": 0.001 }
}
}
```

Stawki strategii muszą sumować się do najwyżej 1; reszta przypada na `exploit`. Guidance lekcji: `consider`, `avoid`, `verify`; ID muszą być unikalne. `maximumMembers >= minimumMembers`.

`semanticClaimThreshold` steruje automatycznym powiązaniem proposal agenta z istniejącym, gotowym ticketem kampanii. Harness porównuje znormalizowane tokeny hipotezy i opisu ticketu, wybiera najlepszą zgodność i przypisuje ticket dopiero po przekroczeniu progu. Wyższa wartość ogranicza fałszywe przypisania; `1` wymaga praktycznie identycznego tekstu.

## `search`, sweep, execution i ASHA

```json
{
"search": {
  "enabled": true,
  "seed": 2027,
  "exploitationRatio": 0.55,
  "parameters": [
    { "name": "lr", "file": "candidate/config.json", "path": "optimizer.learning_rate", "type": "float", "min": 0.0001, "max": 0.1, "scale": "log" },
    { "name": "depth", "file": "candidate/config.json", "path": "model.depth", "type": "integer", "min": 2, "max": 12 },
    { "name": "kind", "file": "candidate/config.json", "path": "model.kind", "type": "categorical", "values": ["linear", "tree"] },
    { "name": "normalize", "file": "candidate/config.json", "path": "features.normalize", "type": "boolean" }
  ],
  "surrogate": { "enabled": true, "minimumObservations": 5, "candidatePoolSize": 64, "explorationWeight": 0.25 },
  "sweeps": { "enabled": true, "maxValues": 5, "maxConcurrentTrials": 2, "reductionFactor": 2 }
},
"execution": {
  "experimentConcurrency": 2,
  "resources": [
    { "id": "gpu-a", "cpu": 8, "memoryGb": 32, "gpu": 1, "vramGb": 24, "maxConcurrent": 1 },
    { "id": "gpu-b", "cpu": 8, "memoryGb": 32, "gpu": 1, "vramGb": 24, "maxConcurrent": 1 }
  ],
  "asha": { "enabled": true, "familySize": 2, "reductionFactor": 2, "agentCandidates": true }
}
}
```

Plik parametru musi leżeć w `mutablePaths`; nazwy oraz pary `file/path` muszą być unikalne. Float/integer wymagają `min < max`; log scale wymaga `min > 0`; categorical wymaga niepustego `values`. Sweep wymaga włączonego search i co najmniej jednego parametru, a jego concurrency nie może przekraczać pojemności zasobów. Agent może zażądać 2–`maxValues` wartości jednej zadeklarowanej osi; evaluator dostaje standardowy kontrakt oraz opcjonalne zmienne sweep opisane w [evaluator-contract.md](./evaluator-contract.md).

`execution.resources` zastępuje proste `resourceSlots` opisem CPU/RAM/GPU/VRAM. ID/sloty muszą być unikalne, a suma `maxConcurrent` pokrywać `experimentConcurrency`. ASHA wymaga co najmniej dwóch stage'y. Równoległość większa niż 1 bez deterministic search wymaga ASHA z `agentCandidates: true`.

## `knowledge`

```json
{
"knowledge": {
  "enabled": true,
  "path": ".autoresearch/project-knowledge.json",
  "scope": { "dataset": "v3", "evaluator": "v2" },
  "minimumConfidence": 0.7
}
}
```

Domyślnie wyłączone. Scope fingerprintuje kontekst transferu wiedzy pomiędzy runami; wpisy z innego scope wymagają ponownej walidacji.

## `outputDir` i `researchInstructions`

`outputDir` domyślnie wynosi `runs` i określa katalog artefaktów kampanii. `researchInstructions` jest wymaganym, niepustym opisem celu, dozwolonej swobody, zakazów (szczególnie leakage) oraz preferowanej metodologii. Nie umieszczaj w nim sekretów ani treści holdoutu — trafia do kontekstu agenta i artefaktów audytowych.

## Walidacja konfiguracji

Praktyczne reguły końcowe:

- używaj `$schema`, aby edytor wykrywał błędy przed startem;
- traktuj `autoresearch.schema.json` i `src/config.ts` jako źródło prawdy — loader dodatkowo sprawdza relacje między sekcjami;
- przechowuj evaluator, holdout i definicję splitu poza `mutablePaths` oraz zwykle w `protectedPaths`/`hiddenPaths`;
- wpisuj cache i output do `copyIgnore`, aby nie kopiować runu do jego własnego workspace'u;
- przed długim runem uruchom krótki baseline/smoke test.
