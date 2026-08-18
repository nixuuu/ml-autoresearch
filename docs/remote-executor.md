# Neutralny remote executor

`evaluator.runner.mode: "remote"` deleguje pojedyncze próby evaluatora do zaufanego brokera. Broker może mapować współdzielony filesystem albo sam przesłać snapshot do dowolnego dostawcy compute.

```json
{
  "evaluator": {
    "command": ["python", "evaluate.py"],
    "runner": {
      "mode": "remote",
      "network": "none",
      "readOnlyRoot": true,
      "pidsLimit": 256,
      "remote": {
        "command": ["remote-evaluator-broker"],
        "timeoutSeconds": 900,
        "inheritEnv": ["REMOTE_API_TOKEN"],
        "maxResponseBytes": 8388608
      }
    }
  }
}
```

Harness uruchamia brokera bez shella, wysyła dokładnie jedną linię JSON i oczekuje dokładnie jednej linii odpowiedzi. Request `schemaVersion: 1` zawiera `jobId`, absolutną ścieżkę i fingerprint workspace'u, komendę/env evaluatora, seed, repetition, stage, timeout, żądane artefakty oraz limity zasobów. `workspace.readOnly` zawsze wynosi `true`.

Odpowiedź z tym samym `jobId` zawiera status procesu, stdout/stderr, czas, payload metryk oraz opcjonalne phase events i checkpoint manifest. Jest limitowana przez `maxResponseBytes`; niepoprawny JSON, niezgodne ID, timeout albo brak wymaganych artefaktów daje nieudaną próbę evaluacji.

Broker jest elementem zaufanej infrastruktury. To on odpowiada za upload, izolację procesu u dostawcy, egzekwowanie zasobów, autentyczność obrazu i zwrot artefaktów. Obecna wersja nie łączy remote mode z `preflight` ani dynamicznym `runtimeDependencies`; loader odrzuca takie konfiguracje jawnie.

## Benchmark model × harness

Po zakończeniu runów przygotuj macierz:

```json
{
  "version": 1,
  "name": "Model x harness",
  "entries": [
    { "id": "pi-a", "model": "provider/model-a", "harness": "pi-sdk", "runDir": "runs/pi-a" },
    { "id": "prime-a", "model": "provider/model-a", "harness": "prime-agent-rpc", "runDir": "runs/prime-a" }
  ]
}
```

Uruchom:

```bash
bun run src/cli.ts benchmark benchmark-matrix.json --output benchmark-results
```

Powstają `benchmark.json` i `BENCHMARK.md`. Macierz porównuje finalną poprawę względem baseline, koszt agenta, tokeny, czas aktywny, liczbę eksperymentów, poprawne ewaluacje i promocje. Powtórzenia tej samej pary model–harness są agregowane do jednej komórki.
