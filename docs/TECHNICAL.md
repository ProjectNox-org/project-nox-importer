# Documentação Técnica — Project Nox Importer

Este documento consolida as referências de arquitetura, execução local, compilação, testes e pipelines do **Project Nox Importer** voltadas a desenvolvedores e mantenedores.

> **Nota sobre estado em produção vs. código versionado:** este guia descreve a implementação presente no repositório (`src/`), as configurações versionadas (`package.json`, `discloud.config`, `.github/workflows/`) e referências de documentos técnicos em `docs/`. Ele não substitui os runbooks operacionais nem confirma automaticamente quais variáveis de ambiente estão ativas em uma instância específica de produção.

---

## 1. Requisitos e versões de ambiente

As versões de Node.js aparecem em três camadas no repositório:

| Origem | Versão | Finalidade |
|---|---|---|
| [`package.json`](../package.json) (`engines.node`) | `>=20.0.0` | Requisito mínimo declarado pelo pacote |
| [`.github/workflows/build-check.yml`](../.github/workflows/build-check.yml) | Node.js `20` | Validação automatizada de build, testes de liveness e consistência de `build/` |
| [`discloud.config`](../discloud.config) e [`.github/workflows/deploy-discloud.yml`](../.github/workflows/deploy-discloud.yml) | Node.js `22` | Alvo de container e pipeline de publicação configurados para DIScloud |

Dependências principais observadas em `package.json`:

- **TypeScript (`tsc`)** para compilação de `src/` para `build/` + `scripts/build-id.mjs`.
- **Vitest** para execução das suítes unitárias e de integração isolada em `tests/` e `src/**/__tests__/`.
- **PostgreSQL driver (`pg`), Zod, Dotenv, Drizzle ORM, Puppeteer Core, `ws`**.

---

## 2. Modos de runtime e adaptadores (código atual)

Em [`src/index.ts`](../src/index.ts) e [`src/config.ts`](../src/config.ts):

### Modo de motor (`IMPORTER_RUNTIME_MODE`)

- **`lite` (padrão em `src/config.ts`):** instancia `ImporterLiteRuntime` ([`src/lite/runtime.ts`](../src/lite/runtime.ts)), utilizando fila durável, projeção de tarefas elegíveis, controle de lease e pool dedicado para metadados históricos (`createYugabyteMetadataPool()`). Exige `IMPORTER_DB_MODE=direct`.
  - *Nota documental:* documentos anteriores à virada (como [`importer-lite-v2.md`](importer-lite-v2.md)) registravam o modo Lite ainda como *opt-in*; no código atual, `'lite'` já é o valor padrão, enquanto `'legacy'` permanece como opção explícita para rollback controlado.
- **`legacy`:** instancia `ImporterEngine` ([`src/core/engine.ts`](../src/core/engine.ts)), baseado em `acquireJobsDirect` sobre `importer_queue` com renovação de lease (`heartbeatDirect`), recuperação de leases órfãos (`recoverStalledLeasesDirect`) e `AutoHealWatchdog`.

### Modo de banco de dados (`IMPORTER_DB_MODE`)

- **`direct` (padrão em `src/config.ts`):** conexão TLS direta ao **YugabyteDB (YSQL)** via `pg.Pool` (`DirectSupabaseClient`), com limites rígidos configuráveis por processo (`DIRECT_DB_POOL_MAX` e `METADATA_DB_POOL_MAX`, padrões `1` em `src/config.ts`) para preservar slots no banco para o leitor web.
- **`gateway`:** acesso HTTP via `ImporterGatewayClient` / `GatewaySupabaseClient` (camada intermediária alternativa/legada).
- Estruturas relacionadas a **Supabase** permanecem referenciadas apenas por compatibilidade histórica e transição de schemas.

### Armazenamento de mídia (`STORAGE_PROVIDER`)

- **Separação SQL vs. binários:** o banco YSQL guarda apenas metadados estruturados de páginas e mídia (como tipo MIME, dimensões, tamanho, hash SHA-256 e identificadores externos), sem gravar binários de imagem no SQL.
- **Provedores implementados:**
  - `direct_telegram` (padrão em `src/config.ts`) / `telegram`: `DirectTelegramStorageProvider` com controle de concorrência (`TELEGRAM_MEDIA_CONCURRENCY`) e limite global de banda (`UPLOAD_RATE_LIMIT_BYTES_PER_SEC`), respeitando limites de taxa (HTTP 429) sem trocar de bot para burlar espera.
  - `worker`: `NoxWorkerStorageProvider` (ponte HTTP legada).
  - `mock`: `MockStorageProvider` para testes e desenvolvimento local sem envios externos.

---

## 3. Proteções de integridade e fluxo de ingestão

- **Validação binária (`inspectImage`):** inspeciona bytes em memória (assinaturas e estrutura PNG, JPEG e WebP, além de limites de dimensões) e rejeita respostas HTML disfarçadas de imagem antes de qualquer persistência.
- **Deduplicação de mídia e obras:** calcula SHA-256 sobre os bytes da imagem para evitar armazenamento duplicado; utiliza identificação conservadora por origem (`source` + identificador na fonte) em vez de fusões por similaridade de título.
- **Barreira de publicação (`PublicationSafetyBarrier`):** impede marcar capítulos como publicados se faltarem páginas válidas ou se houver quebra de ordem sequencial exigida pela política de catálogo.
- **Recuperação de falhas e auto-cura:** renovação periódica de lease em tarefas longas, isolamento explícito de estados incertos de upload (`UNKNOWN` no Lite) para evitar reenvios cegos, e reconciliação em segundo plano respeitando limites de tentativas (`max_attempts`).

Consulte os invariantes completos em [`importer-lite-v2.md`](importer-lite-v2.md), a matriz de lições históricas em [`importer-lite-historical-lessons.md`](importer-lite-historical-lessons.md) e a auditoria de desempenho em [`importer-definitive-audit.md`](importer-definitive-audit.md) (que distingue metas futuras, como 8–10 capítulos/minuto, dos baselines efetivamente medidos em produção).

---

## 4. Desenvolvimento local e testes seguros

1. Copie [`.env.example`](../.env.example) para `.env` em ambiente **local/isolado** e utilize `STORAGE_PROVIDER=mock` e credenciais de teste — **nunca** aponte o desenvolvimento local para bancos, tokens ou canais de produção.
2. Instale dependências e compile:

```bash
npm ci
npm run build
```

> Nota: neste repositório, o diretório `build/` é versionado e verificado pelo CI; ao modificar código em `src/`, mantenha `build/` sincronizado com `npm run build`.

3. Execute os testes automatizados (sem necessidade de acesso ao banco ou Telegram de produção):

```bash
# Verificação rápida usada no CI (liveness e auto-cura):
YUGABYTE_PASSWORD=test-ci-placeholder-password npx vitest run tests/auto-heal-watchdog.test.ts

# Suíte completa:
npm test
```

4. Desenvolvimento local com recarregamento (`npm run dev`) requer variáveis válidas configuradas apenas para ambiente não produtivo.

---

## 5. Workflows de CI e implantação

- **[`.github/workflows/build-check.yml`](../.github/workflows/build-check.yml):** executado em `push` para `main` e em `pull_request` (Node.js 20). Instala dependências com `npm ci`, roda `npm run build`, executa `npx vitest run tests/auto-heal-watchdog.test.ts` com senha placeholder de teste e verifica se há divergência entre `src/` e `build/`.
- **[`.github/workflows/deploy-discloud.yml`](../.github/workflows/deploy-discloud.yml):** executado em `push` para `main` e `workflow_dispatch` (Node.js 22). Valida build/testes e publica `build/`, `discloud.config`, `package.json`, `package-lock.json` e `README.md` na DIScloud via `DISCLOUD_TOKEN`. **Qualquer merge na `main` pode acionar nova implantação.**
- **[`.github/workflows/discloud-status.yml`](../.github/workflows/discloud-status.yml):** verificação periódica agendada de status/reinício na DIScloud via `scripts/discloud-status.mjs`.
- **Container DIScloud ([`discloud.config`](../discloud.config)):** configurado com 624 MiB de RAM (`RAM=624`), teto V8 heap `--max-old-space-size=352`, alocador com `MALLOC_ARENA_MAX=1` e pacotes `tesseract-ocr` para suporte a OCR quando aplicável.

---

## 6. Documentos relacionados em `docs/`

- [`importer-lite-v2.md`](importer-lite-v2.md) — Arquitetura e invariantes do fluxo Lite 2.0.
- [`importer-lite-cutover-runbook.md`](importer-lite-cutover-runbook.md) — Runbook manual de migração, gates de segurança e rollback.
- [`importer-definitive-audit.md`](importer-definitive-audit.md) — Auditoria de cobertura P0, decisões de engenharia e baselines medidos.
- [`importer-lite-infrastructure-validation.md`](importer-lite-infrastructure-validation.md) — Validação isolada de pré-requisitos YSQL (`npm run validate:lite:staging`).
- [`importer-lite-historical-lessons.md`](importer-lite-historical-lessons.md) — Mapa de falhas históricas e proteções resultantes.
