# Contrato de Coordenação P2 (Importer V3 / Antigravity) x Recuperação Histórica (Terceira IA)

- **Branch / Escopo:** `feat/importer-supremo-v3` (Gate G2 + Reforço Obrigatório P2)
- **Objetivo:** Evitar condições de corrida, duplicação de obras e sobrescrita destrutiva entre a rotina permanente de **cadastro de obras novas (P2 / Importer Supremo)** e a rotina separada de **recuperação histórica de obras já existentes no catálogo (Terceira IA)**.

## 1. Divisão Clara de Ownership

| Domínio / Fluxo | Responsável Exclusivo | Regra de Fronteira |
|---|---|---|
| Descoberta, validação multi-fonte e criação de **obras novas** (`NEW_WORK`) | **Importer P2 (Antigravity)** | Somente via `p2-onboarding-pipeline.ts` quando P1 não tem trabalho executável (`p2GateState !== 'PAUSED_P1_BUSY'`), ou por solicitação autenticada/auditável `STAFF`. |
| Enriquecimento/recuperação retroativa de obras **já existentes** no catálogo | **Terceira IA (Histórico)** | Opera exclusivamente sobre `work_id` pré-existentes sem criar obras novas. |
| Monitoramento contínuo P0 `43 × N` e completude P1 em coorte de 10 | **Importer P0 / P1 (Antigravity)** | Toda obra criada pela P2 entra imediatamente no catálogo público elegível para P0 e na fila P1. |

## 2. Protocolo Inegociável de Escrita Segura no Banco

Qualquer escrita em `public.works` ou tabelas relacionadas feita pela P2 ou pela Terceira IA deve respeitar estas 4 invariantes:

1. **Advisory Lock Transacional por Obra (`work_id`):**
   - Antes de atualizar `title`, `cover_id`, `synopsis`, `description`, `aliases`, `author`, `artist` ou `status` de uma obra existente, adquirir lock não-bloqueante dentro da transação:
     ```sql
     SELECT public.importer_v3_acquire_work_metadata_lock($1::uuid);
     -- equivalente a: pg_try_advisory_xact_lock(hashtext('nox:work_meta:' || $1::text))
     ```
   - Se `false`, ceder a vez sem bloquear o pool e reagendar para a próxima janela (`PENDING_METADATA_RETRY`).

2. **Respeito Absoluto à Proveniência Manual (`works.metadata_provenance`):**
   - O trigger `works_track_manual_edits_trig` (`migrations/004_importer_telemetry_and_provenance.sql`) registra `metadata_provenance.<campo>.source = 'manual'` em edições humanas.
   - Nenhuma rotina automatizada (P2 ou Terceira IA) pode sobrescrever um campo marcado como `'manual'` ou `'staff_locked'` ou alterar `slug` existente sem justificativa explícita autenticada.

3. **Monotonicidade por Qualidade e Idioma (`quality_score`):**
   - Cada campo consolidado grava em `metadata_provenance.<campo>`:
     ```json
     {
       "source": "mangaflix",
       "language": "pt-BR",
       "quality_score": 88,
       "updated_at": "2026-11-28T05:25:00Z",
       "owner": "importer-p2-v3"
     }
     ```
   - Regras de precedência sem downgrade:
     - **Título:** não substituir título `pt-BR` comprovado (`isPtBrTitle`) por variante estrangeira/romaji/slug, nem título com maior `quality_score` sem ganho claro comprovado.
     - **Capa:** comparar integridade (`inspectImage`), resolução/nitidez/proporção e título PT-BR na arte; jamais trocar uma capa legítima de alta qualidade por uma inferior só por ter texto PT-BR.
     - **Sinopse:** `PT-BR completa e válida` > `outro PT válido` > `idioma estrangeiro válido` > `NULL` (jamais aceitar texto de erro/placeholder/truncado).

4. **União Aditiva e Idempotente de `works.aliases`:**
   - Re-ler `aliases` dentro da transação protegida pelo advisory lock.
   - Fazer merge normalizado (`computeMergedWorkAliases`), removendo apenas duplicatas exatas/equivalentes, sem apagar aliases internacionais legítimos (`en`, `ja`, `ko`, `zh`, `romaji`, `pt-BR`) nem aliases de fontes `ALIAS_ONLY` (`mangaball`, `mangadex`, `mangafire`), preservando `aliasProvenance` por fonte.

5. **Isolamento Absoluto das 3 Fontes `ALIAS_ONLY`:**
   - `mangaball`, `mangadex` e `mangafire` NUNCA podem figurar como `source` de `cover_id`, `synopsis` ou capítulos tanto na P2 quanto na Terceira IA. Contratos em `src/alias-sources/types.ts` e `src/lite/p2-metadata-consolidator.ts` descartam e auditam qualquer violação.
