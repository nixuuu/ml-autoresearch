# Backendy agentowe, Research Lab i role adaptacyjne

Harness zachowuje jeden interfejs `Researcher`, niezależnie od środowiska agenta. Evaluator, metryki, promocja, ukryte pliki i kontrola ścieżek pozostają własnością harnessu.

## Pi SDK (domyślny)

```json
{
  "agent": {
    "backend": { "type": "pi-sdk" }
  }
}
```

To ścieżka kompatybilna z dotychczasową konfiguracją. Gdy `backend` jest pominięty, loader wybiera `pi-sdk`.

## Prime Agent RPC

```json
{
  "agent": {
    "backend": {
      "type": "prime-agent-rpc",
      "command": ["prime-agent"],
      "timeoutSeconds": 3600,
      "inheritEnv": ["PRIME_API_KEY"],
      "telemetry": { "enabled": false },
      "runner": {
        "mode": "docker",
        "image": "your-prime-agent-image@sha256:...",
        "network": "none",
        "readOnlyRoot": true,
        "pidsLimit": 256
      }
    }
  }
}
```

Adapter używa skorelowanego JSONL RPC zgodnego z [oficjalnym kontraktem Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md), w tym ścisłego framingu LF, utrzymuje sesję między propozycją i refleksją oraz zapisuje surowe zdarzenia. Review działa w osobnej sesji i może użyć innego profilu modelu. Agent pracuje na osobnym mirrorze bez `hiddenPaths`. Po sesji harness synchronizuje wyłącznie zmiany w `mutablePaths`; symlinki, `protectedPaths` i pozostałe zmiany są odrzucane. Backend Prime jest celowo Docker-only.

Harness domyślnie ustawia `agent.backend.telemetry.enabled=false`, co przekłada na `PRIME_AGENT_TELEMETRY=0` zarówno dla procesu lokalnego używanego w testach, jak i kontenera produkcyjnego. Telemetrię można włączyć wyłącznie jawnie przez `enabled=true`. `DO_NOT_TRACK=1` odziedziczone przez `inheritEnv` oraz tryb offline Prime Agent nadal mają pierwszeństwo i wyłączają raportowanie.

Komenda obrazu musi implementować metody RPC `prompt`, `get_last_assistant_text` i `get_session_stats`, wysyłać zdarzenie końca tury oraz zwracać odpowiedzi z tym samym `id`. Model może być przekazany jako `provider/model:<thinkingLevel>`.

## Trwały Research Lab

```json
{
  "agent": {
    "lab": {
      "enabled": true,
      "engine": "python",
      "path": ".autoresearch/lab",
      "maxCalls": 200,
      "maxOutputBytes": 262144,
      "runner": {
        "mode": "docker",
        "image": "python:3.13-slim@sha256:...",
        "network": "none"
      }
    }
  }
}
```

Jeden kernel Python jest współdzielony przez eksperymenty tego samego runu. Agent ma narzędzia do wykonywania komórek i odczytu/zapisu plików labu. Udane komórki z `persist: true` trafiają do dziennika i są odtwarzane po restarcie kernela. Lab ma osobny katalog od kandydata i nigdy nie otrzymuje ukrytych plików evaluatora. Local mode wymaga jawnego `allowHostExecution: true`.

## Adaptacyjne role

```json
{
  "agent": {
    "orchestration": {
      "mode": "adaptive",
      "maxAdvisors": 2,
      "maxParallel": 1,
      "failureAnalystAfter": 2
    },
    "roles": {
      "hypothesis-generator": { "thinkingLevel": "medium" },
      "statistician": { "thinkingLevel": "high" },
      "failure-analyst": { "thinkingLevel": "high" },
      "implementation-critic": { "thinkingLevel": "high" },
      "reviewer": { "thinkingLevel": "high" }
    }
  }
}
```

Pi uruchamia tylko role pasujące do bieżącego stanu: generator hipotez przy braku zaplanowanej hipotezy, statystyka po wyniku `inconclusive` oraz dla replikacji/falsyfikacji, analityka błędów po skonfigurowanej serii porażek, a krytyka implementacji przy głębszej gałęzi lub świeżej porażce. Doradcy są read-only, mają osobny transcript i wliczają się do kosztu. Prime Agent otrzymuje te same limity i może użyć swoich natywnych subagentów.

## Refinement metod badawczych

```json
{
  "learning": {
    "refinement": {
      "enabled": true,
      "minimumEvidence": 2,
      "contradictionThreshold": 1,
      "maxEntries": 40,
      "allowedKinds": ["prompt-note", "analysis-recipe", "context-selector", "role-spec", "screening-policy"]
    }
  }
}
```

Agent może zaproponować wyłącznie advisory method. Nowa metoda ma status `trial`. Aktualizacja istniejącej wymaga jej ID w `plan.methodTests`, poprawnego wyniku evaluatora i niezależnego eksperymentu. Stan jest zapisywany w `research-methods.json` i `RESEARCH_METHODS.md` oraz widoczny w dashboardzie.

Refinement nie ma API do zmiany komendy evaluatora, definicji metryk, progów promocji, ścieżek chronionych/ukrytych, credentials, sieci ani sandboxa. Wpis opisujący taką zmianę pozostaje co najwyżej tekstową sugestią i nie wpływa na wykonanie.
