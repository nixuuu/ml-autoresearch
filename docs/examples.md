# Przykłady

Repozytorium zawiera trzy scenariusze pokazujące różne poziomy autonomii.

## Toy polynomial regression

Ścieżka: [`examples/toy-regression`](../examples/toy-regression)

Pokazuje kontrolowany klasyczny research:

- agent zmienia `model.py` i `experiment.json`;
- evaluator, preflight i ukryty holdout są chronione;
- primary metric to `validation_rmse`;
- `parameter_count` jest guardrailem;
- evaluator ma etapy smoke, screening i canonical;
- włączone są statystyki adaptacyjne, checkpointing, telemetry i result cache;
- search space obejmuje stopień wielomianu, L2, bazę cech i skalowanie;
- kampania demonstruje branchowanie, Pareto, ablations i merge.

```bash
./dist/ml-autoresearch validate \
  examples/toy-regression/autoresearch.config.json

./dist/ml-autoresearch run \
  examples/toy-regression/autoresearch.config.json \
  --max-experiments 4 \
  --open-ui
```

To najlepszy przykład do sprawdzenia mechaniki harnessu, ale nie benchmark
jakości modeli językowych. Problem jest mały i po znalezieniu właściwego stopnia
wielomianu szybko osiąga nasycenie.

## Parameter sweep

Ścieżka: [`examples/parameter-sweep`](../examples/parameter-sweep)

Jeden logiczny eksperyment testuje kilka wartości parametru. Agent tworzy jedną
hipotezę, a harness:

1. kopiuje wspólny workspace do izolowanych triali;
2. nakłada wartości na zadeklarowany JSON path;
3. uruchamia identyczne etapy i seedy;
4. odrzuca słabsze wartości pomiędzy rungami;
5. zapisuje zwycięską wartość w głównym workspace;
6. wykonuje jedną refleksję nad pełną tabelą wyników.

```bash
./dist/ml-autoresearch run \
  examples/parameter-sweep/autoresearch.config.json \
  --max-experiments 1 \
  --max-wall-time-minutes 0
```

Pełny wynik znajduje się w:

```text
runs/<run-id>/experiments/<id>/parameter-sweep/result.json
```

Sweep działa wyłącznie dla parametrów zadeklarowanych w `search.parameters` i
plików JSON. Jest dobrym wyborem, gdy koszt przygotowania/evaluatora dominuje
nad kosztem kilku wariantów, a testowane wartości należą do jednej hipotezy.

## Open research

Ścieżka: [`examples/open-research`](../examples/open-research)

Agent otrzymuje dedykowany katalog `candidate/`, widoczny treningowy dataset i
audytowany zestaw narzędzi analitycznych. Może wykonywać EDA, tworzyć skrypty,
porównywać outlier detection, okna czasowe, cechy, transformacje i rodziny
modeli. Scoring i holdout pozostają poza jego kontrolą.

Zalecany przepływ open research jest celowo „najpierw tanie dowody”:

1. `research_data_info` i `research_search` do szybkiej inspekcji bez uruchamiania ciężkiego Pythona;
2. `research_runtime_info`, aby potwierdzić interpreter, import paths i zależności;
3. `research_python` lub `research_test` dla kanonicznego środowiska;
4. `research_exec_start` + `research_exec_status` dla długiej analizy działającej w tle;
5. `research_compare` do porównania dwóch zapisanych artefaktów JSON;
6. `research_write`/`research_replace`, a następnie świeży test po mutacji;
7. proposal cytujący udane `analysisEvidence`.

Wyniki komend pozostają dowodem eksploracyjnym. Promocję rozstrzyga chroniony
evaluator, który ponownie oblicza metryki. Błędy runtime'u, brak modułu i timeout
są utrwalane jako run-level tool facts, aby następne sesje agenta nie powtarzały
tej samej nieskutecznej ścieżki.

Najpierw zbuduj wspólny obraz analizy/evaluatora:

```bash
docker build \
  -t ml-autoresearch-open-research:latest \
  examples/open-research
```

Następnie:

```bash
./dist/ml-autoresearch validate \
  examples/open-research/autoresearch.config.json

./dist/ml-autoresearch run \
  examples/open-research/autoresearch.config.json \
  --max-experiments 10 \
  --max-wall-time-minutes 0
```

Przykład demonstruje również controlled dependency broker: paczki diagnostyczne
mogą mieć scope `analysis`, a zależności finalnego modelu scope `candidate`.
W dostarczonej konfiguracji broker dopuszcza wyłącznie paczki Python. Obsługa
Bun wymaga obrazu zawierającego Bun, dodania `"bun"` do `allowedManagers` i
jawnych reguł pakietów. Szczegóły znajdują się w
[kontrolowanych zależnościach](runtime-dependencies.md).

## Tworzenie własnego scenariusza

Minimalny układ:

```text
my-research/
├── autoresearch.config.json
├── evaluate.py
├── candidate/
│   └── model.py
└── data/
    ├── train.parquet
    └── holdout.parquet
```

Rekomendacje:

- wystaw agentowi spójny katalog `candidate/`, nie cały projekt;
- evaluator i definicję metryki umieść w `protectedPaths`;
- holdout, targety i prywatny scoring umieść w `hiddenPaths`;
- cache oraz `runs/` dodaj do `copyIgnore`;
- zacznij od jednej primary metric i małej liczby guardraili;
- najpierw sprawdź scenariusz przez `validate` i jeden eksperyment.

Wbudowany skill może poprowadzić LLM przez przygotowanie plików:

```bash
ml-autoresearch skill show ml-autoresearch-design-scenario
```
