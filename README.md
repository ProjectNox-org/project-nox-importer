<p align="center">
  <img src="https://raw.githubusercontent.com/ProjectNox-org/.github/main/assets/brand/nox-emblem.webp" alt="Emblema oficial do Project Nox" width="96" />
</p>

<h1 align="center">Project Nox · Importer</h1>

<p align="center">
  Serviço de importação e organização de conteúdo para a plataforma web de mangás do <strong>Project Nox</strong>.
</p>

> [!NOTE]
> **Procurando os serviços do Project Nox?**
>
> Este repositório é técnico e **não precisa ser instalado** para usar os projetos públicos da organização. Para descobrir os serviços disponíveis e acompanhar a iniciativa, acesse a [**Central Oficial do Project Nox**](https://projectnox-org.github.io/). Para conhecer a plataforma web de mangás, consulte o repositório [`ProjectNox-org/project-nox-manga`](https://github.com/ProjectNox-org/project-nox-manga).

## O que é o Project Nox Importer?

O **Project Nox Importer** é um serviço que trabalha nos bastidores da plataforma web de mangás do **Project Nox**.

Ele é responsável por consultar fontes compatíveis, identificar obras e capítulos, validar imagens e organizar os dados e arquivos necessários para o funcionamento do catálogo na web.

O Importer **não** é um aplicativo de leitura nem um catálogo instalável para **Mihon** ou **Aniyomi** — ele é o componente de bastidores que prepara o conteúdo da plataforma web, mantendo código e documentação técnica separados do site público.

## Para quem é este repositório?

Este repositório contém o código-fonte e a documentação operacional do serviço, sendo destinado principalmente a:

- Desenvolvedores e engenheiros de backend.
- Mantenedores da infraestrutura e automações do Project Nox.
- Colaboradores técnicos interessados em estudar ou aprimorar o motor de ingestão.

Usuários e leitores comuns não precisam baixar, compilar ou executar este projeto: todo o ecossistema voltado ao público é acessado diretamente pela [Central Oficial do Project Nox](https://projectnox-org.github.io/).

## Como funciona?

**Fontes configuradas → Importer → Validação e armazenamento → Catálogo → Plataforma Web**

Em linhas gerais, o fluxo implementado executa as seguintes etapas:

1. **Consulta às fontes:** verifica fontes autorizadas e configuradas para identificar obras e novos capítulos.
2. **Coleta e verificação:** baixa as páginas e valida formato e integridade binária das imagens antes de aceitá-las.
3. **Deduplicação e armazenamento:** evita arquivos duplicados e envia as imagens validadas para o armazenamento externo de mídia.
4. **Registro no catálogo:** grava os metadados estruturados (obra, capítulos e ordem de páginas) no banco de dados.
5. **Disponibilização segura:** libera a publicação para a plataforma web somente após validar integridade e ordem dos capítulos.

## Tecnologias principais

| Componente | Papel no projeto |
|---|---|
| **TypeScript / Node.js** | Linguagem principal, adaptadores de fonte (`src/sources/`) e motor de ingestão |
| **YugabyteDB (YSQL)** | Banco relacional para catálogo, filas, controle de tarefas (*leases*) e metadados (sem imagens binárias) |
| **Telegram Bot API** | Armazenamento externo para arquivos de mídia |
| **DIScloud** | Hospedagem do serviço contínuo de segundo plano configurada em [`discloud.config`](discloud.config) |
| **GitHub Actions** | Verificações de build/testes em Pull Requests e pipeline de implantação na `main` |

O código atual mantém suporte padrão ao motor Lite (`src/lite/`) com fallback configurável para o motor legado (`src/core/`), além de referências históricas de transição envolvendo Supabase e Gateway.

## Para desenvolvedores

### Versões de Node.js

- **Mínimo declarado no pacote ([`package.json`](package.json)):** `node >=20.0.0`.
- **Verificação automatizada de build ([`build-check.yml`](.github/workflows/build-check.yml)):** Node.js `20`.
- **Ambiente configurado para implantação ([`discloud.config`](discloud.config)):** Node.js `22`.

### Comandos básicos (ambiente local)

```bash
npm ci
npm run build
npm test
```

A execução local exige configuração própria em arquivo `.env` (use [`.env.example`](.env.example) como referência com provedores de teste isolados, como `mock`). **Não** execute testes locais ou comandos de desenvolvimento apontando para serviços, bancos ou canais de produção sem autorização explícita. Consulte os detalhes completos em [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

## Documentação técnica

- [**Guia Técnico Consolidado (`docs/TECHNICAL.md`)**](docs/TECHNICAL.md) — Arquitetura atual (Lite vs. legado), armazenamento, segurança, variáveis de ambiente e workflows.
- [**Arquitetura Importer Lite 2.0**](docs/importer-lite-v2.md) — Invariantes do fluxo durável de filas, mídia e publicação.
- [**Runbook de Ativação e Rollback**](docs/importer-lite-cutover-runbook.md) — Procedimentos manuais e gates de validação.
- [**Auditoria Definitiva e Baselines**](docs/importer-definitive-audit.md) — Decisões históricas e medições reais de referência.
- [**Validação de Infraestrutura**](docs/importer-lite-infrastructure-validation.md) — Pré-checagem isolada de schema (`npm run validate:lite:staging`).
- [**Lições Históricas**](docs/importer-lite-historical-lessons.md) — Registro de incidentes anteriores e salvaguardas aplicadas.

## Projetos relacionados

- [**Central Oficial do Project Nox**](https://projectnox-org.github.io/) — Portal institucional com links atualizados, status e catálogo de projetos.
- [**Plataforma Web de Mangás (`project-nox-manga`)**](https://github.com/ProjectNox-org/project-nox-manga) — Repositório da aplicação web de leitura que consome o catálogo preparado pelo Importer.
- [**Tracker de Solicitações**](https://projectnox-org.github.io/project-nox-tracker/) — Painel público para acompanhar pedidos da comunidade.
- [**Organização Project Nox no GitHub**](https://github.com/ProjectNox-org) — Diretório oficial dos repositórios abertos da iniciativa.

## Créditos e licenciamento

Desenvolvido e mantido por **Project Nox Contributors & Awerkori** (veja [`NOTICE`](NOTICE)).

Este software é licenciado sob a **GNU Affero General Public License v3.0 (`AGPL-3.0-only`)** — consulte [`LICENSE`](LICENSE) para o texto integral e [`NOTICE`](NOTICE) para atribuições de terceiros, obrigações de Código-Fonte Correspondente em interação remota por rede (Seção 13) e proteção das marcas **Project Nox** e **Awerkori** (Seção 7(e)).

```text
Copyright (C) 2026 Project Nox Contributors & Awerkori
Licensed under the GNU Affero General Public License, Version 3.0 (AGPL-3.0-only).
```
