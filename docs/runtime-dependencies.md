# Kontrolowane zależności runtime

`runtimeDependencies` pozwala agentowi proponować paczki Python/Bun bez udostępniania surowego `pip install` lub `bun add`. Broker sprawdza politykę, instaluje w krótkotrwałym kontenerze, blokuje pełne środowisko i montuje je read-only do analiz oraz — dla zależności kandydata — evaluatora.

## Wymagania wstępne

- `agent.analysis.enabled: true` i `agent.analysis.runner.mode: "docker"`;
- `evaluator.runner.mode: "docker"`;
- identyczny bazowy `image` dla analysis i evaluatora;
- działający Docker oraz obraz zawierający `python3`/`pip` i/lub Bun;
- `manifestPath` wewnątrz `project.mutablePaths`, ale poza `hiddenPaths`;
- `strategy: "locked-overlay"` i `requireLockedVersions: true`.

## Kompletny fragment konfiguracji brokera

```json
{
  "project": {
    "sourceDir": ".",
    "mutablePaths": ["candidate"],
    "protectedPaths": ["evaluate.py"],
    "hiddenPaths": ["data/holdout.csv"],
    "copyIgnore": ["runs", ".autoresearch"]
  },
  "agent": {
    "analysis": {
      "enabled": true,
      "inheritEnv": [],
      "runner": {
        "mode": "docker",
        "image": "research-runtime:latest",
        "network": "none"
      }
    }
  },
  "runtimeDependencies": {
    "enabled": true,
    "strategy": "locked-overlay",
    "manifestPath": "candidate/autoresearch.dependencies.json",
    "allowedManagers": ["python", "bun"],
    "registries": {
      "python": "https://pypi.org/simple",
      "bun": "https://registry.npmjs.org"
    },
    "allow": [
      { "manager": "python", "package": "xgboost", "versions": "3.0.4" },
      { "manager": "python", "package": "statsmodels" },
      { "manager": "bun", "package": "ml-regression", "versions": "6.3.0" }
    ],
    "deny": [
      { "manager": "python", "package": "unsafe-package" }
    ],
    "maxDirectDependencies": 6,
    "maxInstallSeconds": 300,
    "maxEnvironmentBytes": 2147483648,
    "requireLockedVersions": true,
    "cachePath": ".autoresearch/dependencies",
    "python": { "installer": "pip", "onlyBinary": true },
    "bun": { "ignoreScripts": true },
    "environmentProfiles": {
      "cpu-large": { "image": "research-runtime:latest", "cpus": 8, "memory": "32g" },
      "gpu": { "image": "research-runtime:cuda", "cpus": 8, "memory": "32g", "gpus": "all" }
    }
  },
  "evaluator": {
    "command": ["python3", "evaluate.py"],
    "runner": {
      "mode": "docker",
      "image": "research-runtime:latest",
      "network": "none"
    }
  }
}
```

## Polityka i defaulty

| Pole | Domyślnie | Walidacja |
|---|---:|---|
| `enabled` | `true` | Broker działa tylko, gdy włączony. |
| `strategy` | `locked-overlay` | Inna wartość jest odrzucana. |
| `manifestPath` | — | Wymagane; musi być mutable i nie może należeć do `hiddenPaths`. |
| `allowedManagers` | `["python"]` | Tylko `python`, `bun`; wartości unikalne. |
| `registries` | `{}` | Opcjonalne adresy index/registry. |
| `allow`, `deny` | `[]` | Reguły `{manager, package, versions?}`; deny ma pierwszeństwo. |
| `maxDirectDependencies` | `10` | Limit łączny zależności candidate + analysis. |
| `maxInstallSeconds` | `300` | Timeout instalacji. |
| `maxEnvironmentBytes` | `2147483648` | Co najmniej 1 MiB. |
| `requireLockedVersions` | `true` | Aktualnie musi być true. |
| `cachePath` | `.autoresearch/dependencies` | Względem configu. |
| `python.installer` | `pip` | Aktualnie tylko pip. |
| `python.onlyBinary` | `true` | Dodaje `--only-binary=:all:`. |
| `bun.ignoreScripts` | `true` | Wyłącza lifecycle scripts. |

Nazwy paczek muszą być bezpiecznymi nazwami registry; obsługiwane są scoped npm packages. `package: "*"` jest możliwe w regule, ale szeroka allowlista osłabia kontrolę i nie jest rekomendowana. Jeśli request podaje wersję, a reguła ma `versions`, wartości muszą być identyczne. Bez wersji request używa constraintu reguły albo `*`; broker i tak zapisuje konkretne wersje resolved/transitive w manifeście.

## Zakres `analysis` i `candidate`

Przed instalacją agent powinien wywołać `research_dependency_info`. Narzędzie
sprawdza kolejno aktywny locked overlay, paczki dostępne w skonfigurowanym
bazowym runtime, politykę allow/deny oraz registry. Dzięki temu paczka obecna w
obrazie nie jest błędnie przedstawiana jako „not allowlisted” i nie uruchamia
niepotrzebnej instalacji. Odpowiedź rozróżnia `installed`, `addable`, `denied`
i `unavailable` oraz podaje źródło (`locked-overlay`, `base-image`, `policy` lub
`registry`).

Agent korzysta z narzędzi:

- `research_dependency_info` — sprawdza dostępne wersje allowlistowanej paczki;
- `research_add_dependency` — dodaje paczkę ze scope i uzasadnieniem;
- `research_remove_dependency` — usuwa bezpośrednią paczkę;
- `research_select_runtime_profile` — wybiera zatwierdzony profil lub `base`.

`scope: "analysis"`:

- paczka jest dostępna w kolejnych `research_exec` danego eksperymentu;
- nie zmienia kandydata i nie jest dostępna evaluatorowi;
- nadaje się do EDA, wykresów i jednorazowej diagnostyki.

`scope: "candidate"`:

- broker materializuje środowisko i zapisuje manifest w workspace;
- manifest jest częścią kontrolowanego diffu;
- evaluator montuje dokładnie zablokowane środowisko;
- używaj dla paczki importowanej przez finalny kod modelu.

Jeśli agent odkryje lepszy model z nowej paczki, musi dodać ją jako `candidate`. Zależność wyłącznie analysis nie przechodzi do eval.

## Instalacja, lock i fingerprint

Broker:

1. sprawdza manager, nazwę oraz allow/deny;
2. ustala zatwierdzony obraz/profil i pobiera jego dokładny Docker image ID;
3. uruchamia installer w read-only kontenerze z `cap-drop ALL`, `no-new-privileges`, limitami i tymczasowym dostępem `bridge` do registry;
4. Python instaluje przez `pip --target /dependencies/python`; Bun do prywatnego `node_modules`;
5. drugi krok bez sieci odczytuje wszystkie resolved versions;
6. sprawdza limit rozmiaru i buduje fingerprint z image ID, profilem/zasobami, direct i resolved dependencies;
7. atomowo publikuje content-addressed środowisko.

Manifest ma postać zbliżoną do:

```json
{
  "version": 1,
  "selectedProfile": "gpu",
  "baseImage": "research-runtime:cuda",
  "baseImageId": "sha256:...",
  "direct": {
    "python": [{ "name": "xgboost", "version": "3.0.4" }]
  },
  "resolved": {
    "python": [
      { "name": "numpy", "version": "2.3.2" },
      { "name": "xgboost", "version": "3.0.4" }
    ]
  },
  "environmentFingerprint": "...",
  "createdAt": "2026-08-17T10:00:00.000Z"
}
```

Manifest jest zarządzany przez harness. Przy eval harness ponownie liczy fingerprint, sprawdza zgodność obrazu/profilu, obecność cache i porównuje manifest z broker-owned `environment.json`. Ręczna zmiana, brak cache albo wycofany profil kończy się błędem zamiast cichego użycia innego środowiska.

## Montowanie do analysis i evaluatora

Python overlay jest montowany read-only pod `/autoresearch-deps/python`, a harness dodaje go do `PYTHONPATH`. Bun `node_modules` jest montowany read-only pod `/workspace/node_modules` oraz wskazywany przez `NODE_PATH`. Sam evaluator nie instaluje paczek i może zachować `network: "none"`.

Bazowy image analysis i evaluatora musi być identyczny w konfiguracji, aby ABI/interpreter były zgodne. Po wyborze profilu evaluator uruchamia się na dokładnym `baseImageId` zapisanym w locku oraz z zasobami profilu.

## Profile środowiska

Profile pozwalają agentowi wybrać tylko wcześniej zatwierdzone warianty:

```json
{
"runtimeDependencies": {
"environmentProfiles": {
  "cpu-large": {
    "image": "research-runtime:latest",
    "cpus": 8,
    "memory": "32g"
  },
  "gpu-a100": {
    "image": "research-runtime:cuda",
    "cpus": 16,
    "memory": "64g",
    "gpus": "device=0"
  }
}
}
}
```

ID profilu musi być bezpiecznym segmentem (`A-Z`, `a-z`, cyfry, `.`, `_`, `-`). Agent nie może podać dowolnego obrazu ani zasobów. `base` wraca do bazowego image. Zmiana profilu przebudowuje lock kandydata, więc evaluator widzi ten sam wariant.

Obraz profilu powinien zawierać interpreter, biblioteki systemowe/CUDA i narzędzia wymagane do instalacji. `onlyBinary: true` odrzuci pakiet bez wheel; ustawienie false dopuszcza build ze źródła, ale obraz musi wtedy zawierać toolchain. `ignoreScripts: true` może uniemożliwić działanie paczek Bun wymagających `postinstall`; wyłączenie jest świadomym zwiększeniem powierzchni wykonania kodu dostawcy.

## Cache, resume i CI

Układ cache:

```text
<cachePath>/
  requests/<request-hash>.json
  environments/<environment-fingerprint>/
    environment.json
    python/
    bun/node_modules/
```

Przy `resume` zachowaj katalog runu, dependency cache i obrazy Docker. Sam manifest nie zawiera paczek. W CI zamontuj trwały volume dla `cachePath`; nie kopiuj go do candidate workspace (`copyIgnore: [".autoresearch"]`). Broker nie pobiera automatycznie brakującego locked environment podczas eval — brak kończy się kontrolowanym błędem.

## Audyt i diagnostyka

Operacje są zapisywane w:

```text
experiments/<experiment-id>/analysis/dependencies/
  events.jsonl
  calls/<call-id>/stdout.log
  calls/<call-id>/stderr.log
```

Log obejmuje argv, exit code, timeout, czas, wersje, fingerprint, image ID i rozmiar. Dashboard pokazuje środowisko runtime przy eksperymencie.

Typowe błędy:

- **not allowlisted / denied** — popraw `allow`/`deny`, nie obchodź brokera;
- **only-binary failure** — dodaj wheel-compatible wersję lub świadomie dopuść build;
- **manifest does not match** — odtwórz kandydata przez narzędzia brokera, nie edytuj locku;
- **environment missing from cache** — przywróć właściwy trwały cache/run;
- **image no longer allowed** — przywróć konfigurację profilu lub wykonaj nowy kontrolowany wybór;
- **package works in analysis but not eval** — zależność dodano w złym scope; użyj `candidate`.

## Ograniczenia bezpieczeństwa

Broker ogranicza źródło, manager, czas, rozmiar i liczbę paczek, ale instalacja nadal uruchamia kod pochodzący z registry. Stosuj prywatny mirror, przypięte constrainty i zweryfikowane obrazy. Nie używaj `package: "*"` w środowisku wysokiego ryzyka. Docker ogranicza hosta, lecz zależność finalnego modelu działa wewnątrz procesu evaluatora i może zobaczyć jego mounty; krytyczny holdout powinien być scoringowany poza procesem niezaufanej inferencji.
