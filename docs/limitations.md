# Obecne ograniczenia i model bezpieczeństwa

## Brak migracji starych runów

Projekt jest greenfield. Nowy kod zachowuje artefakty istniejących runów, ale
nie migruje ich do aktualnego `schemaVersion`. Funkcje wymagające nowych pól,
np. sterowanie `pause/stop`, mogą nie działać dla starszego katalogu.

## Autonomia nie gwarantuje poprawy

Harness kontroluje proces i dowody, ale agent nadal może formułować słabe
hipotezy, błędnie interpretować wynik lub zużyć budżet bez poprawy. Decyzje
promocji są deterministyczne względem dostarczonych metryk, lecz jakość zależy
od poprawności evaluatora, splitów, leakage controls i ustawionego
`minimumDelta`.

## `hiddenPaths` nie jest pełnym sandboxem

Ukrycie pliku ogranicza narzędzia agenta i terminal analityczny. Jeśli evaluator
importuje kod kandydata w tym samym procesie, złośliwy lub błędny kod może
próbować odczytać zasoby dostępne evaluatorowi. Dla adversarial setup finalną
inferencję należy uruchamiać w osobnym sandboxie, który otrzymuje features i
zwraca predykcje, a scoring z holdout labels wykonywać w zaufanym procesie.

## Runner local jest zaufanym wykonaniem

`runner.mode: "local"` nie jest granicą bezpieczeństwa. Agentowy open research
w local mode wymaga jawnego `allowHostExecution: true`, ponieważ dowolny skrypt
działa z uprawnieniami konta użytkownika. Do autonomicznych scenariuszy
rekomendowany jest Docker z wyłączoną siecią, ograniczeniami CPU/RAM/PID,
read-only rootem i bez capabilities.

## Docker nie rozwiązuje całego threat modelu

- daemon Docker pozostaje elementem zaufanym;
- własny obraz może zawierać podatne lub złośliwe zależności;
- `gpus: all` rozszerza powierzchnię runtime;
- writable shared cache jest widoczny dla kodu kandydata;
- limity zasobów nie są precyzyjnym rozliczeniem kosztu chmurowego.

## Controlled dependencies są lokalnym overlayem

Manifest zależności nie zawiera paczek. Do `resume` potrzebny jest odpowiadający
cache oraz przypięty image ID na tym samym hoście lub trwałym volume. Broker
obsługuje obecnie tylko `pip --target` i Bun `node_modules`; nie zarządza
systemowymi pakietami apt/apk, conda ani kompilacją osobnego obrazu.

Domyślne `python.onlyBinary: true` odrzuca paczki bez wheel. Domyślne
`bun.ignoreScripts: true` może wyłączyć paczkę wymagającą `postinstall`.

## Dashboard jest lokalny

Serwer nasłuchuje na loopbacku i nie ma uwierzytelnienia, TLS ani modelu wielu
użytkowników. Nie jest przeznaczony do bezpośredniej publikacji w sieci. Stan
jest oparty o pliki runu i polling; bardzo duże transcript/logi zwiększają koszt
odświeżania i rozmiar artefaktów.

## SSE nie jest trwałym transportem

Po reconnect dashboard odtwarza stan z dysku oraz ograniczoną historię, ale SSE
nie jest brokerem wiadomości z gwarancją exactly-once. Źródłem audytu są pliki
JSON/JSONL w katalogu runu, nie otwarte połączenie przeglądarki.

## Koszt agenta jest estymacją SDK

Koszt i tokeny zależą od danych raportowanych przez provider/SDK. Brak ceny lub
niepełne usage może dać `0` albo brak wskaźnika. `cost / improvement` i
`time / improvement` są pokazywane tylko dla dodatniej poprawy; czas obejmuje
rzeczywisty lifecycle eksperymentu, a nie wyłącznie evaluator.

## Współbieżność zależy od poprawności scenariusza

Równoległe eksperymenty mają osobne workspaces, lecz zewnętrzne zasoby używane
przez evaluator muszą być bezpieczne współbieżnie. Shared cache wymaga
content-addressed keys, blokad i atomowego publish. Nie należy używać globalnych
plików tymczasowych ani współdzielonego mutable model checkpoint bez namespace.

## Parameter sweep ma celowo wąski kontrakt

Sweep modyfikuje zadeklarowany JSON path i nie jest ogólnym systemem grid
search. Warianty jednej próby powinny testować jedną hipotezę. Łączenie wielu
niezależnych zmian oszczędza czas, ale utrudnia atrybucję i pamięć dowodową.

## Result cache wymaga poprawnego namespace

`evaluator.cache.results: true` może pominąć pełny final-stage eval. Namespace
musi się zmienić przy zmianie datasetu, splitów, semantyki evaluatora lub
środowiska, których nie obejmuje fingerprint workspace'u. Nie należy używać
result cache dla pomiarów zależnych od czasu, sieci lub niezarejestrowanego
stanu.

## Pamięć nie jest automatyczną prawdą

Harness rozdziela deterministyczne fakty od interpretacji agenta i utrzymuje
status dowodu, ale wpis LLM pozostaje hipotezą lub obserwacją. Wiedza przenoszona
między runami ma fingerprint kontekstu i powinna przejść transfer validation.

## Brak integracji z zewnętrznym trackingiem

Harness celowo nie integruje się obecnie z MLflow ani zewnętrznym SaaS.
Artefakty, dashboard i raport są lokalne. Eksport lub archiwizacja katalogów
runu pozostają odpowiedzialnością operatora.

## Integracje zewnętrzne wymagają testu dostawcy

Adapter Prime Agent RPC i neutralny remote executor mają testy kontraktowe z brokerami-fixture. Rzeczywisty obraz Prime, credentials, sieć dostawcy, upload workspace'u i egzekwowanie zasobów zależą od konkretnego wdrożenia brokera i muszą przejść osobny smoke test. Harness odrzuca Prime w local mode; zdalny evaluator nie obsługuje obecnie `preflight` ani `runtimeDependencies`.
