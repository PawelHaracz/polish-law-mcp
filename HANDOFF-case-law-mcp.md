# Handoff → case-law MCP (orzecznictwo, nad SAOS)

Dokument przekazania dla **osobnego MCP** obsługującego polskie orzecznictwo (SN/NSA/TK)
budowanego nad SAOS (saos.org.pl). Powstaje OBOK `polish-law-mcp` (ten projekt), nie wewnątrz.

---

## ⚠️ STATUS (2026-06-26): ZREALIZOWANO — jako LIVE PROXY, nie ingest

MCP **istnieje i działa**: `~/src/private/tools/polish-caselaw-mcp` (TypeScript, branch zmergowany
do `main`, w Docker MCP Gateway w profilu `default` jako `polish-caselaw-mcp:local`).

**Kluczowa zmiana względem oryginalnego planu poniżej:** zbudowano jako **live proxy do SAOS REST
API** (fetch per-request), a NIE jako ingest do lokalnej bazy SQLite. Sekcja 1 niżej (skopiuj
pipeline census→ingest→build-db, FTS5, polski folding, parser HTML) **NIE została użyta i nie jest
potrzebna** — SAOS robi wyszukiwanie po stronie serwera i zwraca strukturalny JSON.

Dlaczego live, nie ingest (decyzja właściciela w brainstormingu):
- świeże dane (orzecznictwo rośnie codziennie), zero utrzymania ogromnej bazy, lekki obraz (bez DB),
- **licencyjnie BEZPIECZNIEJSZE**: nie redystrybuujemy zbioru orzeczeń SAOS, tylko odpytujemy na
  żywo — mniej ekspozycji na ToS SAOS niż przy shipowaniu ich bazy.
- minus: wymaga sieci (brak offline), brak własnego FTS/foldingu — ale SAOS to pokrywa.

Co jest (6 narzędzi, wszystkie przetestowane end-to-end przez gateway):
- `search_case_law` (query + court_type + daty + sort), `get_judgment` (pełny wyrok + referencje),
- `find_judgments_for_provision` (text-search + weryfikacja `referencedRegulations`; zwraca tylko
  potwierdzone, w razie braku — nota), `list_courts`,
- `caselaw_about` / `caselaw_list_sources` (prefiks `caselaw_` by uniknąć kolizji nazw z
  polish-law-mcp w jednym gatewayu — to był realny bug znaleziony przy teście E2E).

Most cross-MCP (most w DANYCH, nie we wspólnej bazie): `get_judgment.referenced_regulations[].eli_id`
mapuje SAOS `journalYear/journalEntry` → `pl-du-YYYY-NNN`. Klient bierze to id i woła
`polish-law-mcp:get_provision`. Granica licencyjna i architektoniczna trzymana — dwa osobne procesy,
dwa źródła, dwie deklaracje `sources.yml`, łączenie po stronie klienta przez wspólny identyfikator ELI.

Spec/plan faktyczne: `polish-caselaw-mcp/docs/superpowers/{specs,plans}/2026-06-26-*`.

W TOKU (rozszerzenie po decyzji 2026-06-26): `check_constitutional_status` (czy TK ruszył przepis)
+ ujednolicenie kształtu wyjścia (`type: "case_law"`, spójne refy). Patrz spec w repo caselaw.

Reszta dokumentu poniżej = ORYGINALNA intencja (model ingestowy). Zachowana jako kontekst, ale
NIE jest to droga, którą poszliśmy.

Powód separacji: **granica licencyjna**. `polish-law-mcp` działa na Art. 4 ustawy o prawie
autorskim (akty normatywne = domena publiczna). Art. 4 **NIE obejmuje orzeczeń sądów** —
te wymagają osobnej podstawy (K.p.c. Art. 9 dla wyroków cywilnych, K.p.k. Art. 100 dla
karnych). Mieszanie w jednej bazie złamałoby deklarację licencyjną (commit `d453323`:
"court decisions NOT covered"). Stąd: dwa MCP, klient komponuje oba.

---

## 1. Co przejąć (wzorce/kod z polish-law-mcp do skopiowania)

Architektura tego MCP jest sprawdzona — powiel ją, nie wymyślaj od nowa:

- **Runtime:** `@ansvar/mcp-sqlite` (`node-sqlite3-wasm`) — SQLite WASM, baza shipowana w
  pakiecie npm (`files: ["data/database.db"]`), zero sieci w runtime, offline. `journal_mode=DELETE`
  dla kompatybilności WASM. Ładowanie: `new Database(readFileSync(dbPath), {readonly:true})`
  (patrz `src/index.ts`).
- **Pipeline danych:** `census.ts` (katalog do pobrania) → `ingest.ts` (fetch + resume po
  obecności seedów) → seedy JSON → `build-db.ts` (SQLite + FTS5 + triggery) → `database.db`.
  Dla SAOS: census = lista orzeczeń z API, ingest = fetch JSON/HTML orzeczenia.
- **FTS5 z polskim foldingiem:** standalone FTS5 + triggery `AFTER INSERT/UPDATE/DELETE`
  ł-foldujące content (`ł→l`, bo unicode61 tego nie robi). Cała logika w
  `src/utils/fts-query.ts` (`normalizePolishForFts`, `sanitizeFtsInput`, `buildFtsQueryVariants`
  z prefix-AND dla fleksji, `buildLikePattern`). **SKOPIUJ TEN PLIK 1:1** — polskie
  wyszukiwanie jest tu rozwiązane (ł-folding, fleksja, warianty zapytań).
- **Parser (lekcje z P1/P2/P3):** `scripts/lib/parser.ts` — wzorce do przeniesienia:
  - strip `<script>`/`<style>`/`xHidden` PRZED `stripHtml` (inaczej `var tree`/cytaty wyciekają),
  - NIE twardy cap treści — `LARGE_..._WARN` (warn) + `HARD_LIMIT` (bezpiecznik). Orzeczenia
    bywają BARDZO długie (uzasadnienia) — nie ucinaj.
  - rekurencyjne parsowanie jednostek (orzeczenie: teza / uzasadnienie / sentencja).
- **Wzorzec narzędzi:** `src/tools/registry.ts` (deklaracja name/description/inputSchema +
  dispatch). Narzędzia jednoplikowo w `src/tools/*.ts`, zwracają `ToolResponse<T>` z
  `_metadata` (patrz `src/utils/metadata.ts`).
- **Cytowanie/dedup:** `src/utils/citation.ts`, `src/utils/provision-ref.ts`
  (`collapseAncestorRefs` — zwijanie agregat/liść w wynikach FTS).

## 2. Co ten MCP udostępnia drugiemu (punkty integracji / cross-MCP graf)

Klient (agent) używa OBU MCP naraz; spięcie po stronie klienta, ale ułatwiamy je danymi:

- **Identyfikatory aktów:** `polish-law-mcp` używa id `pl-du-{YEAR}-{POZ}` (np. `pl-du-1997-553`
  = Kodeks karny). URL kanoniczny: `https://api.sejm.gov.pl/eli/acts/DU/{YEAR}/{POZ}`. Orzeczenie
  z SAOS powinno trzymać krawędź do TEGO id (orzeczenie → interpretowany przepis), żeby klient
  mógł połączyć "przepis ↔ jego wykładnia".
- **Schemat refów przepisów (do linkowania z orzeczenia):** hierarchiczny, human-citable:
  `art1`, `art1par2` (§), `art1u2` (ust.), `art1u2p3` (pkt), `art1u2p3la` (lit.).
  `art267par1` = art. 267 § 1 KK. Bez nawiasów/dwukropków. Orzeczenie cytujące "art. 267 § 1 KK"
  mapuje się na `(pl-du-1997-553, art267par1)`.
- **Tabela `eu_references`** (działa, 5875 wierszy) — przepis → dyrektywa/rozporządzenie UE.
  Orzeczenia TSUE/krajowe stosujące prawo UE mogą się tu zaczepić.
- **Planowane `cross_references`** (P4, akt↔akt) i `legal_rank` (P5, hierarchia źródeł) — gdy
  powstaną, naturalnie rozszerzają się o krawędź `case_law → statute`.

**Cross-MCP graf docelowo:** krawędź `orzeczenie → przepis` (cytuje/interpretuje/deroguje).
Kluczowy przypadek: **wyrok TK derogujący przepis** = "podważenie konstytucyjne" — dana, której
`polish-law-mcp` NIE ma (to orzeczenie), a która domyka pytanie "czy ten przepis nadal obowiązuje".

## 3. SAOS — punkt startowy

- Źródło: SAOS (System Analizy Orzeczeń Sądowych), `saos.org.pl`, **publiczne API REST**
  (`/api/search/judgments`, `/api/judgments/{id}`). Pokrywa SN, NSA, sądy powszechne, TK (częściowo).
- Podstawa prawna do udokumentowania w `sources.yml` nowego MCP: K.p.c. Art. 9 / K.p.k. Art. 100
  + warunki licencyjne SAOS (sprawdzić ToS SAOS — to NIE jest automatycznie Art. 4 PD).
- `type='case_law'` jest już w CHECK schematu polish-law-mcp — ten sam model dokumentu da się
  zaadaptować (id orzeczenia, sąd, sygnatura, data, teza, uzasadnienie, cytowane przepisy).

## 4. Stan polish-law-mcp w momencie handoffu

- Branch `feat/improve-polish-search`: zrobione P1 (wyciek var tree/script/xHidden), P2 (koniec
  cichego capa), P3 (chunking ust./pkt/lit./§ + agregat artykułu, refy hierarchiczne, collapse w
  search). Testy 40/40, lint czysty.
- Re-ingest pełny (--force, ~80 min) w toku → potem `build:db` + eval search + finalna weryfikacja.
- Roadmapa dalej (plan: `~/.claude/plans/eager-gathering-squirrel.md`): P4 graf cytowań
  (cross_references z pro-lexlink + amended_by), P5 hierarchia (legal_rank), dodanie rozporządzeń,
  wersje historyczne (amendment tracking, pilotaż KSC/NIS2).
