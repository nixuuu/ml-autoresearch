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

## Dyrektor badań i osobny implementer

`orchestration.mode: "directed"` uruchamia obowiązkową sekwencję:
dyrektor planuje → implementer pisze kod → dyrektor sprawdza → evaluator
mierzy → dyrektor wyciąga wnioski. Przykład:

```json
{
  "agent": {
    "model": "research-provider/director-model",
    "modelsPath": "./models.json",
    "thinkingLevel": "high",
    "backend": { "type": "pi-sdk" },
    "orchestration": {
      "mode": "directed",
      "maxRevisions": 2,
      "directorMaxAnalysisCalls": 20
    },
    "roles": {
      "director": { "model": "research-provider/director-model", "thinkingLevel": "high" },
      "implementer": { "model": "research-provider/implementer-model", "thinkingLevel": "high" }
    }
  },
  "execution": { "experimentConcurrency": 1 }
}
```

Nazwy modeli są placeholderami z [katalogu scenariusza](model-catalogs.md).
Framework nie narzuca modeli ani providera dla tych ról.

Dyrektor ma osobną sesję utrzymywaną przez planowanie, review i refleksję
danego eksperymentu. Może czytać widoczny kod i przeszukiwać pliki. Jeśli
`agent.analysis.enabled`, może też wykonywać analizy Python/argv w izolowanym
mirrorze bez hiddenPaths. Nie ma narzędzi edycji kandydata, a harness kontroluje
fingerprint workspace'u przed i po każdej fazie dyrektora.

Każda faza dyrektora otrzymuje świeży mirror bieżącego kandydata. Łączny limit
`directorMaxAnalysisCalls` obejmuje planowanie, wszystkie review i refleksję.
Wyniki scratch analysis są dowodem diagnostycznym; promotion metrics pochodzą
wyłącznie z evaluatora. Bez `agent.analysis` dyrektor ma tylko odczyt plików.

Plan jest prerejestrowany jako `research-brief.json` przed implementacją:
zawiera ExperimentPlan, implementationInstructions i acceptanceChecks.
Implementer otrzymuje ten sam plan przy każdej poprawce. Naukowe pola finalnego
proposal pochodzą od dyrektora; implementer dostarcza kod, raport i świeże
analysisEvidence po ostatniej mutacji. Dyrektor widzi oba dokumenty i kod.

`maxRevisions: 2` oznacza najwyżej trzy próby implementacji. Każda ma świeżą
sesję implementera, oddzielny katalog `implementation-attempts/attempt-N`,
handoff, proposal, usage i director-review. Sesja oraz joby poprzedniego
implementera są zamykane przed kolejną próbą. Budżet analysis implementera
obowiązuje osobno dla każdej próby, wraz z finalValidationReserve.
Jeśli skonfigurowano kanoniczny test i wymaganie świeżego dowodu, jest on
wykonywany także przy poprawce bez kolejnej edycji pliku; nowa sesja nie może
ominąć wcześniejszego nieudanego testu przez pozostawienie kodu bez zmian.

Po wyczerpaniu poprawek nie ma kosztownego evala: harness zapisuje odrzucenie,
a dyrektor nadal opisuje wnioski i kolejne hipotezy. Po poprawnym pomiarze
refleksję wykonuje wyłącznie dyrektor, bez fallbacku do implementera. Awaria
obowiązkowej refleksji daje failure i blokuje promocję; zmierzone metryki
pozostają w audycie. Żaden tekst dyrektora nie nadpisuje guardraili ani
deterministycznej decyzji o poprawie.

Wszystkie wywołania modeli wliczają się do accounting. Wspólny transcript ma
role director/implementer i fazę planning; próby implementacji mają osobne
namespace'y, więc ich wpisy nie zastępują się w dashboardzie. Dodatkowy
`directed-events.jsonl` zapisuje przebieg sterowania.

Obecnie tryb wymaga Pi SDK, jednego eksperymentu jednocześnie i roli director.
Nie należy dodawać roles.reviewer: obowiązkowy review realizuje director.
Opcjonalny pool nadal wybiera wyłącznie implementera. Mechanika przydziału
strategii/rodzica, budżety i granice zmian należą do harnessu; dyrektor
projektuje eksperyment w ramach tego przydziału oraz proponuje kolejne
hipotezy przez trwałą pamięć i kampanię. Deterministyczne przygotowanie
kandydata nie omija dyrektora w tym trybie.

## Refinement metod badawczych

```json
{
  "learning": {
    "refinement": {
      "enabled": true,
      "minimumEvidence": 2,
      "contradictionThreshold": 1,
      "allowedKinds": ["prompt-note", "analysis-recipe", "context-selector", "role-spec", "screening-policy"]
    }
  }
}
```

Agent może zaproponować wyłącznie advisory method. Nowa metoda ma status `trial`. Aktualizacja istniejącej wymaga jej ID w `plan.methodTests`, poprawnego wyniku evaluatora i niezależnego eksperymentu. Stan jest zapisywany w `research-methods.json` i `RESEARCH_METHODS.md` oraz widoczny w dashboardzie.

Refinement nie ma API do zmiany komendy evaluatora, definicji metryk, progów promocji, ścieżek chronionych/ukrytych, credentials, sieci ani sandboxa. Wpis opisujący taką zmianę pozostaje co najwyżej tekstową sugestią i nie wpływa na wykonanie.
