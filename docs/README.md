# Dokumentacja ML Autoresearch Harness

Ta dokumentacja opisuje aktualny kontrakt przyszłych runów. Projekt jest
greenfield: katalogi utworzone przez starsze wersje nie są automatycznie
migrowane.

## Ścieżki czytania

### Pierwszy run

1. [Getting started](getting-started.md)
2. [Konfiguracja](configuration.md)
3. [Kontrakt evaluatora](evaluator-contract.md)
4. [CLI i operowanie runem](cli.md)

### Zrozumienie mechaniki

1. [Architektura](architecture.md)
2. [Pętla researchu i pamięć](research-loop.md)
3. [Dashboard](dashboard.md)

### Zaawansowany scenariusz

1. [Kontrolowane zależności](runtime-dependencies.md)
2. [Przykłady](examples.md)
3. [Ograniczenia i bezpieczeństwo](limitations.md)

## Indeks

| Dokument | Zakres |
| --- | --- |
| [Getting started](getting-started.md) | wymagania, instalacja, build, pierwszy validate i run |
| [Architektura](architecture.md) | komponenty, granice odpowiedzialności i artefakty |
| [Pętla researchu](research-loop.md) | baseline, strategie, branchowanie, pamięć, kampania i resume |
| [Konfiguracja](configuration.md) | pełny przewodnik po `autoresearch.config.json` |
| [Kontrakt evaluatora](evaluator-contract.md) | wejścia, zmienne środowiskowe, metryki, etapy i cache |
| [Kontrolowane zależności](runtime-dependencies.md) | allowlista paczek, lock overlay i profile runtime |
| [CLI](cli.md) | wszystkie subkomendy, flagi i lifecycle procesu |
| [Dashboard](dashboard.md) | SSE, widoki, transcript agenta i ekonomika |
| [Przykłady](examples.md) | toy regression, parameter sweep i open research |
| [Ograniczenia](limitations.md) | model zaufania, brak migracji i znane granice |

Formalnym źródłem prawdy dla konfiguracji jest
[`autoresearch.schema.json`](../autoresearch.schema.json). Dokumentacja wyjaśnia
semantykę pól, ale nie zastępuje walidacji wykonywanej przez CLI.
