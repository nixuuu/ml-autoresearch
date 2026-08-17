# Dashboard live

Dashboard jest statyczną aplikacją SvelteKit osadzoną w executable. Dane runu
udostępnia lokalny serwer Bun, a aktualizacje są przesyłane przez Server-Sent
Events. Nie jest potrzebny osobny serwer frontendowy ani baza danych.

## Uruchomienie

`run` i `resume` domyślnie uruchamiają dashboard na `127.0.0.1` i losowym
porcie:

```bash
ml-autoresearch run autoresearch.config.json --open-ui
ml-autoresearch run autoresearch.config.json --ui-port 4317
```

Istniejący run można otworzyć niezależnie:

```bash
ml-autoresearch serve runs/<run-id> --port 0 --open
```

## Overview

Strona główna pokazuje:

- stan runu, aktywny czas i bieżącą aktywność;
- policy leader i najlepszy zaobserwowany checkpoint jako osobne pojęcia;
- poprawę primary metric względem baseline;
- liczbę eksperymentów i stan frontierów;
- dowody statystyczne oraz przedział ufności ostatniego pomiaru;
- compute odzyskany przez screening i pruning;
- Pareto frontier dla wielu celów;
- koszt i tokeny agenta, `cost / +1%` i `time / +1%`;
- trajectory primary metric z linią baseline i tooltipami;
- live progress harnessu;
- graf rodziców i branchowania oparty o Svelte Flow;
- skrót kolejki kampanii i metryki profili/strategii;
- tabelę historii eksperymentów.

Punkty trajectory i węzły grafu prowadzą do szczegółów eksperymentu. Kolor
porównuje wynik z właściwym rodzicem, a dodatkowe obwódki oznaczają lidera,
best observed i Pareto.

## Szczegóły eksperymentu

Widok eksperymentu rozdziela dane deklarowane przez agenta od decyzji harnessu:

- prerejestrowana hipoteza i plan;
- rodzic, strategia, kategoria zmiany i powiązany ticket;
- search suggestion, ablation, merge, ensemble i resource request;
- próby evaluatora z seedami, metrykami i czasem;
- etapy, pruning, preflight, checkpointy, result cache i telemetry faz;
- porównanie statystyczne oraz fresh-seed confirmation;
- pełna tabela parameter sweep;
- koszt i rzeczywisty czas eksperymentu;
- wniosek agenta oraz deterministyczna pamięć harnessu;
- zablokowane środowisko runtime i zależności.

## Transcript agenta

Podczas pracy można oglądać timestampowane:

- thinking/reflection udostępnione przez SDK;
- wiadomości implementera i reviewera;
- prompty harnessu;
- wywołania narzędzi i ich argumenty;
- odczyty, zapisy, replace oraz diffy;
- output długo działających komend `research_exec`;
- wynik i błędy narzędzi.

Tekst jest renderowany jako GFM, a znane narzędzia mają dedykowane widoki.
Transcript jest zapisywany jako `agent-transcript.jsonl`, więc pozostaje
dostępny po zakończeniu procesu.

## Tickety kampanii

Podstrona `/tickets` udostępnia filtrowanie po statusie. Szczegóły ticketu
pokazują hipotezę, typ operacji, priorytet, oczekiwany gain, szansę powodzenia,
wartość informacyjną, koszt, zależności, lifecycle, wynikowy eksperyment oraz
powód anulowania lub blokady.

## Zachowanie live

Serwer odświeża stan z dysku i publikuje snapshoty przez SSE. Graf aktualizuje
istniejące nody bez resetowania viewportu użytkownika; nowe pozycje są
animowane. Aktywny eksperyment może pojawić się przed utworzeniem pełnego
rekordu w `state.json`, na podstawie zdarzeń i transcriptu.

Dashboard nie jest panelem administracyjnym. Sterowanie runem odbywa się przez
komendy `pause`, `resume`, `stop` i `enqueue` opisane w [CLI](cli.md).
