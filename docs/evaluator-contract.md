# Kontrakt evaluatora

Evaluator jest zaufanym programem pomiarowym. Harness uruchamia `evaluator.command` jako tablicę argv (`shell: false`) w katalogu workspace'u. Sukces wymaga kodu wyjścia `0` i poprawnego JSON pod ścieżką `AUTORESEARCH_METRICS_PATH`.

## Minimalny evaluator

```python
import json
import os
from pathlib import Path

seed = int(os.environ["AUTORESEARCH_SEED"])
stage = os.environ["AUTORESEARCH_STAGE"]
budget_ratio = float(os.environ["AUTORESEARCH_BUDGET_RATIO"])

# train_and_score musi używać deterministycznego splitu dla seed.
loss, latency_ms = train_and_score(seed=seed, budget_ratio=budget_ratio)

Path(os.environ["AUTORESEARCH_METRICS_PATH"]).write_text(
    json.dumps({
        "metrics": {
            "validation_loss": loss,
            "latency_ms": latency_ms
        },
        "metadata": {
            "stage": stage,
            "budget_ratio": budget_ratio
        }
    }),
    encoding="utf-8"
)
```

## Zmienne środowiskowe

Zawsze ustawiane:

| Zmienna | Znaczenie |
|---|---|
| `AUTORESEARCH_METRICS_PATH` | Plik wynikowy JSON. |
| `AUTORESEARCH_ARTIFACT_DIR` | Prywatny dla próby katalog artefaktów. |
| `AUTORESEARCH_SEED` | Jawny seed repetycji. |
| `AUTORESEARCH_EXPERIMENT_ID` | ID baseline/eksperymentu/trialu. |
| `AUTORESEARCH_STAGE` | Nazwa bieżącego stage. |
| `AUTORESEARCH_BUDGET_RATIO` | Budżet stage w `(0,1]`. |

Ustawiane zależnie od funkcji:

| Zmienna | Kiedy |
|---|---|
| `AUTORESEARCH_REPETITION` | Dla normalnej próby; indeks liczony od 0. |
| `AUTORESEARCH_PHASE_EVENTS_PATH` | Gdy `telemetry.enabled`. |
| `AUTORESEARCH_CHECKPOINT_MANIFEST_PATH` | Gdy `checkpointing.enabled`; evaluator ma zapisać obiekt JSON. |
| `AUTORESEARCH_PREVIOUS_STAGE_ARTIFACT_DIR` | Następny stage przy checkpointingu; katalog poprzedniego stage read-only. |
| `AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH` | Gdy manifest poprzedniego stage istnieje dla tej repetycji. |
| `AUTORESEARCH_SHARED_CACHE_DIR` | Gdy `evaluator.cache.enabled`. |
| `AUTORESEARCH_CACHE_NAMESPACE` | Namespace współdzielonego cache. |
| `AUTORESEARCH_SWEEP_PARAMETER` | Nazwa parametru sweep. |
| `AUTORESEARCH_SWEEP_VALUE` | Wartość trialu zakodowana JSON-em. |
| `AUTORESEARCH_SWEEP_TRIAL_ID` | ID trialu sweep. |
| `AUTORESEARCH_RESOURCE_SLOT` | ID przydzielonego zasobu. |
| `AUTORESEARCH_RESOURCE_CPU` | Przydzielone CPU. |
| `AUTORESEARCH_RESOURCE_MEMORY_GB` | Przydzielona pamięć RAM. |
| `AUTORESEARCH_RESOURCE_GPU` | Liczba GPU. |
| `AUTORESEARCH_RESOURCE_VRAM_GB` | VRAM w GB. |

`evaluator.env` jest dokładany do env. Z hosta dziedziczone są tylko nazwy z `evaluator.inheritEnv`. W Dockerze host-specific `PATH`, `HOME`, `TMPDIR` i `VIRTUAL_ENV` są usuwane; `HOME`, `TMPDIR` i `XDG_CACHE_HOME` wskazują prywatne katalogi próby.

Evaluator powinien zawsze czytać ścieżki ze zmiennych, zamiast zakładać ich
wartość. Harness mapuje je następująco:

| Zasób | Local | Docker |
|---|---|---|
| working directory / workspace | ścieżka kopii na hoście | `/workspace` (read-only) |
| `AUTORESEARCH_METRICS_PATH` | plik w katalogu artefaktów próby | `/artifacts/<nazwa-pliku>` |
| `AUTORESEARCH_ARTIFACT_DIR` | katalog artefaktów próby na hoście | `/artifacts` |
| `AUTORESEARCH_PREVIOUS_STAGE_ARTIFACT_DIR` | katalog poprzedniego stage na hoście | `/previous-stage` (read-only) |
| `AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH` | plik w katalogu poprzedniego stage | `/previous-stage/<nazwa-pliku>` |
| `AUTORESEARCH_SHARED_CACHE_DIR` | skonfigurowany katalog cache na hoście | `/autoresearch-cache` |

W local mode evaluator ma uprawnienia procesu użytkownika. Read-only mounty są
granicą wymuszaną przez system wyłącznie w Dockerze; po lokalnym eval harness
dodatkowo sprawdza fingerprint workspace'u i zgłasza jego mutację.

## Format wyniku

```json
{
  "metrics": {
    "validation_loss": 0.123,
    "hit_rate": 0.347,
    "latency_ms": 18.4
  },
  "metadata": {
    "checkpoint": "model.bin",
    "timings": { "load_data": 1200, "train": 18200 },
    "sliceMetrics": [
      { "name": "rare-class", "count": 84, "metrics": { "validation_loss": 0.31 } }
    ]
  }
}
```

`metrics` musi być obiektem, a każda wartość skończoną liczbą JSON (bez `NaN`/`Infinity`). `metadata` jest opcjonalnym obiektem. Harness wymaga obecności skonfigurowanych metryk w udanych próbach i agreguje repetycje według konfiguracji. Dodatkowe metryki są zachowywane, a niezdefiniowane metryki domyślnie agregowane przez mean.

`format: "percentage"` nie zmienia protokołu: zapisuj ułamek (`0.347`), nie `34.7`. `minimumDelta`, `equivalenceMargin`, guardraile i statystyka operują na tej samej surowej skali.

## Stages i porównywalność

Evaluator powinien używać `AUTORESEARCH_BUDGET_RATIO` do ograniczenia kosztu, np. liczby kroków, przykładów treningowych lub drzew. Tani stage musi nadal mierzyć ten sam cel:

- nie zmieniaj holdoutu, definicji metryki ani reguł leakage;
- dla tego samego seed preferuj zagnieżdżone prefiksy/subsety danych;
- stage canonical (`budgetRatio=1`) ma dawać pełny, docelowy pomiar;
- zapisuj stage i ratio w metadatach dla audytu.

Harness może zatrzymać clearly-worse kandydata po wcześniejszym stage. Przy włączonej statystyce może adaptacyjnie dołożyć seedy aż do `maximumSeeds`. Porównanie jest parowane po seedach; deterministyczne splity są więc istotną częścią kontraktu.

## Preflight

`preflight.command` działa przed stage'ami z tym samym runnerem i podstawowymi zmiennymi evaluatora. Powinien szybko sprawdzić:

- dostępność datasetu i wymaganych zależności;
- poprawność wejściowej konfiguracji kandydata;
- możliwość zaimportowania finalnego entrypointu;
- brak oczywistych naruszeń formatu.

Preflight nie musi zapisywać metrics JSON. Kod inny niż 0, timeout lub brak możliwości uruchomienia kończy evaluation przed kosztownymi stage'ami.

## Checkpointing pomiędzy stage'ami

Po włączeniu checkpointingu każda próba dostaje własny `AUTORESEARCH_CHECKPOINT_MANIFEST_PATH`. Evaluator musi zapisać tam obiekt JSON. Następny stage dostaje poprzednie artefakty read-only.

Przykładowy manifest zarządzany przez evaluator:

```json
{
  "schema_version": 1,
  "seed": 17,
  "candidate_fingerprint": "sha256:...",
  "completed_steps": 1000,
  "checkpoint": "model-1000.bin"
}
```

Harness weryfikuje jedynie, że manifest jest obiektem JSON; semantyka, zgodność seed/kandydata i integralność checkpointu należą do evaluatora. Evaluator powinien odrzucić checkpoint niezgodny z seedem, konfiguracją, preprocessingiem lub datasetem. Artefakty umieszczaj w `AUTORESEARCH_ARTIFACT_DIR`, nie w workspace.

## Telemetry faz

Przy `telemetry.enabled` evaluator może dopisywać JSONL do `AUTORESEARCH_PHASE_EVENTS_PATH`:

```jsonl
{"timestamp":"2026-08-17T10:00:00Z","phase":"load_data","status":"started"}
{"timestamp":"2026-08-17T10:00:01Z","phase":"load_data","status":"completed","durationMs":981.2}
{"timestamp":"2026-08-17T10:00:04Z","phase":"train","status":"progress","progress":0.5,"metadata":{"step":500}}
```

Wymagane są string `phase` oraz status `started`, `progress`, `completed` albo `failed`. Opcjonalne: ISO timestamp (brak jest zastępowany czasem odczytu), skończone `durationMs`, skończone `progress` i obiekt `metadata`. Harness odczytuje plik live co około 500 ms. Alternatywnie/uzupełniająco może zsumować `metadata.timings`, jeśli dana faza nie ma własnych events z duration.

## Cache, współdzielone foldy i splity

Po włączeniu cache evaluator otrzymuje trwały katalog. Local dostaje ścieżkę hosta, Docker `/autoresearch-cache`. Ten katalog jest opcjonalny — eval może go zignorować.

Rekomendowany klucz splitu:

```text
sha256(dataset_fingerprint + split_protocol_version + seed + folds + stratification + groups + time_window)
```

Nie dodawaj `experimentId` ani stage do klucza splitu, jeśli split ma być współdzielony. Dodaj fingerprint preprocessingu/features do klucza artefaktów zależnych od kandydata. Publikuj przez plik tymczasowy i atomowe `rename`, a przy współbieżności stosuj lock. Zawsze waliduj manifest cache przed użyciem.

Bezpieczny układ:

```text
<AUTORESEARCH_SHARED_CACHE_DIR>/
  splits/<split-fingerprint>/manifest.json
  splits/<split-fingerprint>/folds.npz
  datasets/<dataset-fingerprint>/decoded.arrow
  features/<dataset+feature-fingerprint>/matrix.parquet
```

Nie zapisuj sekretów ani holdout labels do cache dostępnego kodowi kandydata. `readOnly: true` nadaje się do przygotowanego wcześniej cache. `results: true` pozwala harnessowi całkiem ominąć identyczny eval; nie używaj go przy niekontrolowanej losowości, czasie, zewnętrznych usługach albo stanie niewchodzącym do namespace/fingerprintu.

## Parameter sweep

Sweep nie wymaga zmian w podstawowym output. Harness tworzy osobny workspace każdego trialu i bezpiecznie zmienia tylko zadeklarowany JSON path. Opcjonalne zmienne sweep pozwalają dodać kontekst do metadata:

```python
metadata = {
    "sweep_parameter": os.environ.get("AUTORESEARCH_SWEEP_PARAMETER"),
    "sweep_value": json.loads(os.environ["AUTORESEARCH_SWEEP_VALUE"]),
    "sweep_trial": os.environ.get("AUTORESEARCH_SWEEP_TRIAL_ID"),
}
```

Nie odczytuj wartości sweep jako substytutu pliku kandydata — źródłem prawdy jest zmieniony config w workspace. Wszystkie triale muszą korzystać z identycznych stage'y, seedów, splitów i definicji metryk.

## Local i Docker

### Local

Proces działa z uprawnieniami użytkownika. Jest wygodny dla zaufanego evaluatora, ale kod kandydata importowany przez evaluator może czytać hosta, uruchamiać procesy i próbować omijać granice projektu. Ograniczenia narzędzi agenta nie stanowią sandboxa dla tego procesu.

### Docker

Harness uruchamia `docker run --rm --init`, montuje workspace read-only do `/workspace`, artefakty do `/artifacts`, domyślnie wyłącza sieć i może ustawić read-only root, CPU/RAM/GPU oraz pids limit. Współdzielony cache i poprzedni stage są osobnymi mountami; previous stage jest read-only.

Docker redukuje ryzyko, ale jeśli evaluator importuje niezaufany kod kandydata w tym samym procesie, kod ten może zobaczyć wszystko, co evaluatorowi zamontowano — także holdout. Dla adversarialnego scenariusza rozdziel inferencję do osobnego sandboxa, któremu zaufany scorer przekazuje wyłącznie features i odbiera predykcje.

## Checklist implementacji

- proces zwraca `0` wyłącznie po zapisaniu metrics JSON;
- każdy seed deterministycznie tworzy ten sam split i losowość treningu;
- primary, guardrails i objectives są skończonymi liczbami;
- budget ratio obniża koszt, nie zmienia znaczenia metryki;
- checkpoint jest walidowany przed wznowieniem;
- cache ma wersjonowany namespace i content-addressed klucze;
- telemetry i metadata nie zawierają sekretów;
- evaluator, split i holdout są protected/hidden oraz poza mutable paths.
