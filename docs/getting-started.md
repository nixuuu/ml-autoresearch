# Getting started

## Wymagania

- macOS lub Linux;
- [Bun](https://bun.sh/) 1.3 lub nowszy;
- uwierzytelnienie providera obsługiwanego przez Pi SDK;
- Python lub inny runtime wymagany przez własny evaluator;
- Docker jako rekomendowany sandbox open research i wymagany runtime dla
  kontrolowanych zależności; zaufany open research może działać lokalnie po
  jawnym włączeniu host execution.

## Instalacja zależności i weryfikacja repozytorium

```bash
bun install
bun run typecheck
bun test
```

## Uwierzytelnienie modelu

Harness używa tego samego mechanizmu credentials co Pi Coding Agent. Dla
subskrypcji obsługiwanej przez providera uruchom interaktywnie Pi i wybierz
`/login`:

```bash
bunx --bun pi
# w TUI: /login
```

Credential jest przechowywany poza repozytorium, domyślnie w
`$HOME/.pi/agent/auth.json`. Nie dodawaj tego pliku ani kluczy API do configu
scenariusza. Provider oparty o klucz można zamiast tego skonfigurować przez
odpowiednią zmienną środowiskową, np. `OPENAI_API_KEY` dla `openai/*` lub
`ANTHROPIC_API_KEY` dla `anthropic/*`.

Sprawdź gotowość providera bez ujawniania credentiala:

```bash
bunx --bun pi auth check --provider openai-codex --json
```

Oczekiwany status to `"ready"`. `ml-autoresearch validate` sprawdza config,
runner i rozpoznanie modelu, ale nie wykonuje płatnego requestu do modelu.
Najmniejszym end-to-end smoke testem harnessu jest opisany niżej run z
`--max-experiments 1`. Więcej wariantów auth opisuje
[dokumentacja Pi SDK](https://pi.dev/docs/latest/sdk).

Tryb developerski uruchamia CLI bezpośrednio ze źródeł i przed startem
odświeża frontend:

```bash
bun run dev validate examples/toy-regression/autoresearch.config.json
```

## Budowanie executable

```bash
bun run build
./dist/ml-autoresearch --help
```

Build najpierw tworzy statyczny frontend SvelteKit, osadza jego assety w CLI, a
następnie kompiluje samodzielny plik `dist/ml-autoresearch` przez `bun build`.
Executable jest przeznaczone dla platformy, na której zostało zbudowane.

### Instalacja w `PATH`

Poniższy wariant kopiuje binarkę do jawnej lokalizacji:

```bash
mkdir -p "$HOME/.local/bin"
install -m 755 ./dist/ml-autoresearch "$HOME/.local/bin/ml-autoresearch"
```

Upewnij się, że `$HOME/.local/bin` znajduje się w `PATH`. Fizyczna lokalizacja
instalacji to `$HOME/.local/bin/ml-autoresearch`. Odinstalowanie ogranicza się
do usunięcia tego jednego pliku:

```bash
rm "$HOME/.local/bin/ml-autoresearch"
```

## Pierwszy scenariusz

Najpierw sprawdź konfigurację bez uruchamiania agenta i treningu:

```bash
./dist/ml-autoresearch validate \
  examples/toy-regression/autoresearch.config.json
```

Następnie wykonaj jeden eksperyment:

```bash
./dist/ml-autoresearch run \
  examples/toy-regression/autoresearch.config.json \
  --max-experiments 1 \
  --open-ui
```

CLI utworzy baseline, uruchomi evaluator i dopiero potem zleci agentowi pierwszy
eksperyment. Dashboard działa na `127.0.0.1` i losowym wolnym porcie. Po
zakończeniu researchu pojedyncze `Ctrl+C` zamyka dashboard. Podczas aktywnego
researchu pierwsze `Ctrl+C` prosi o bezpieczne przerwanie, a drugie wymusza
zabicie zarejestrowanych grup subprocessów.

## Dłuższy run

```bash
./dist/ml-autoresearch run autoresearch.config.json \
  --max-experiments 50 \
  --max-wall-time-minutes 0 \
  --model openai-codex/gpt-5.6-sol \
  --thinking-level xhigh
```

`--max-wall-time-minutes 0` oznacza brak limitu czasu. Nadal obowiązuje limit
eksperymentów, limity błędów oraz ręczne przerwanie.

## Zalecana kolejność wdrożenia własnego projektu

1. Przygotuj deterministyczny evaluator i jedną primary metric.
2. Oddziel `mutablePaths` od evaluatora, danych holdout i scoringu.
3. Uruchom `validate`.
4. Ręcznie uruchom evaluator dla kilku seedów i oszacuj szum metryki.
5. Ustaw `minimumDelta` większe od nieistotnych fluktuacji.
6. Wykonaj run z jednym eksperymentem.
7. Sprawdź `REPORT.md`, dashboard, diff workspace'u i logi evaluatora.
8. Dopiero potem zwiększ budżet, współbieżność i zakres autonomii.

Do wygenerowania scenariusza przez LLM można użyć wbudowanych instrukcji:

```bash
./dist/ml-autoresearch skill list
./dist/ml-autoresearch skill show ml-autoresearch-design-scenario
```

Następne kroki: [konfiguracja](configuration.md),
[kontrakt evaluatora](evaluator-contract.md) i [przykłady](examples.md).
