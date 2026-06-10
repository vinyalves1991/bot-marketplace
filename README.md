# Monitor OLX & Enjoei — 8 Watchlists de Produtos

Sistema modular de monitoramento diário (2× por dia, 07:00 e 16:00 BRT) de 8 marketplaces e categorias. Busca em OLX (scraping + Playwright) e Enjoei (GraphQL API). Envia e-mail (Gmail) e WhatsApp (CallMeBot) quando há itens novos ou mudanças de preço. Dashboard HTML em GitHub Pages.

**Principais características:**
- Filtros semânticos profundos: CPU exatas, voltagem (110V vs 220V), capacidade (ml), termos de exclusão (defeito, mamadeira), part numbers
- Histórico persistido: distinção novo × mudança de preço, com delta (±R$), teto de R$ 10 mil
- Multi-fonte unificada (OLX + Enjoei no mesmo card)
- Zero custo, sem APIs pagas
- Arquitetura de watchlist extensível: add nova em minutos

---

## Monitores (8 watchlists)

| Nome | Fonte | Faixa | Detalhes |
|---|---|---|---|
| **OLX Notebooks** | OLX (22 CPUs) | R$ 2.000–8.000 | CPU flagship Intel/AMD (filtro mudança até R$ 10k) |
| **Enjoei Notebooks** | Enjoei (GraphQL) | R$ 1.500–8.000 | 22 CPUs (novo até R$ 8k) |
| **Enjoei Tênis 42** | Enjoei (GraphQL) | até R$ 500 | Minimalistas, tamanho 42, 5 marcas |
| **Dockstations** | OLX + Enjoei | até R$ 500 | 3 modelos (SD25TB4, WD22TB4, 40AY0090BR), 4TB+ |
| **Fitbit Air** | OLX + Enjoei | R$ 300–600 | Smartwatch Fitbit Air exato |
| **Lifefactory** | OLX + Enjoei | R$ 25–75 | Garrafa térmica 500ml–1L (exclui mamadeira, bivolt OK) |
| **Tela Galaxy Book3** | OLX + Enjoei | até R$ 1.000 | Part number BA96-08462A (Galaxy Book3 Ultra) |
| **Melanger** | OLX (2 categorias) + Enjoei | R$ 1.000–5.000 | Moinho de chocolate 110V (exclui 220V puro, bivolt OK) |

**OLX: 2 categorias customizadas para Melanger**
- `https://www.olx.com.br/eletro/eletroportateis-para-cozinha-e-limpeza?q=melanger`
- `https://www.olx.com.br/comercio-e-escritorio/gastronomia?q=melanger`

---

## Rodar manualmente

```powershell
# Watchlists individuais
npm run monitor:olx
npm run monitor:enjoei-notebooks
npm run monitor:enjoei-tenis
npm run monitor:dockstations
npm run monitor:fitbit
npm run monitor:lifefactory
npm run monitor:tela-galaxybook3
npm run monitor:melanger

# Todos em paralelo + notificação e-mail/WhatsApp
npm run monitor:todos

# Forçar envio mesmo sem novidades (teste)
npm run monitor:todos:forcar-email

# Regenerar dashboard HTML
npm run dashboard

# Local + commit + push automático (PowerShell Windows)
.\scripts\run-local-olx-and-publish.ps1
```

**Flags opcionais:**
- `--skip-olx`, `--skip-enjoei`, `--skip-dockstations`, etc: pula watchlist específica
- `--dry-run`: teste notificações sem agendar monitores
- `--skip-monitors --dry-run`: testa apenas notificações com relatórios salvos

---

## Variáveis de ambiente

**Credenciais (notificação):**
```powershell
setx GMAIL_USER       "seu@gmail.com"
setx GMAIL_APP_PASSWORD "xxxx xxxx xxxx xxxx"    # senha de app Google
setx NOTIFY_EMAIL_TO  "destino@email.com"
setx CALLMEBOT_PHONE  "5541999999999"            # número com DDI, sem +
setx CALLMEBOT_APIKEY "123456"                   # chave CallMeBot
```

**Diretórios de dados (opcional, default interno):**
```powershell
setx OLX_DATA_DIR                    "C:\caminho\data\olx"
setx ENJOEI_DATA_DIR                 "C:\caminho\data\enjoei"
setx ENJOEI_NOTEBOOKS_DATA_DIR       "C:\caminho\data\enjoei-notebooks"
setx DOCKSTATIONS_DATA_DIR           "C:\caminho\data\dockstations"
setx FITBIT_DATA_DIR                 "C:\caminho\data\fitbit"
setx LIFEFACTORY_DATA_DIR            "C:\caminho\data\lifefactory"
setx TELA_GALAXYBOOK3_DATA_DIR       "C:\caminho\data\tela-galaxybook3"
setx MELANGER_DATA_DIR               "C:\caminho\data\melanger"
```

**GitHub Actions:** mesmas variáveis em `Settings → Secrets and variables → Actions`

---

## GitHub Actions (CI)

**Workflow:** `.github/workflows/monitor.yml` (disparado via `workflow_dispatch` por cron-job.org)

**Fluxo:**
1. Checkout do main
2. Setup Node 22 + dependências
3. Instala Playwright + Chromium
4. Roda 5 monitores em paralelo (OLX skipped no CI, Enjoei roda):
   - Enjoei Notebooks
   - Enjoei Tênis
   - Dockstations
   - Fitbit
   - Lifefactory
   - Tela Book3
   - Melanger
5. **Notifica**: e-mail + WhatsApp se totais > 0 ou errors presentes
6. **Loop de publicação** (até 4 tentativas):
   - `git fetch origin`
   - `git rebase -X theirs origin/main` (resolve conflito de `index.html` automaticamente)
   - Regenera dashboard `generate-dashboard.mjs` (com dados frescos de origin)
   - Amend ao commit anterior se houver mudança no dashboard
   - `git push origin main` (com retry exponencial)

**Por que `rebase -X theirs`:**  
Local e CI disparam juntos (16h). Ambos geram um `index.html` diferente. A estratégia `theirs` pega a versão do origin (CI traz os dados frescos), e logo após regeneramos o dashboard com tudo integrado.

---

## Dashboard

**URL:** `https://almeida3339.github.io/olx-daily/` (GitHub Pages)

**Geração:** `generate-dashboard.mjs` lê os **5 reports mais recentes** de cada watchlist (com novidades) e monta cards com:
- **Novos itens** (até 5 por watchlist)
- **Mudanças de preço** (até 5, com delta: verde desceu, vermelho subiu)
- **Timestamp** da última coleta (convertido UTC→BRT)
- **Specs** para OLX/Enjoei Notebooks; suprimido para Tênis/Dockstations/Fitbit/Lifefactory/Tela/Melanger

**Filtro retroativo:** itens acima de R$ 10 mil são suprimidos da exibição (mesmo de relatórios antigos pré-filtro).

---

## Relatórios

**Estrutura `data/`:**
```
data/
  olx/
    report-2026-06-10T10-27-53-123Z.md
    snapshot-2026-06-10T10-27-53-123Z.json
  enjoei-notebooks/
    report-2026-06-03T08-00-42-419Z.md
    snapshot-2026-06-03T08-00-42-419Z.json
  enjoei/
    report-2026-06-03T08-00-53-125Z.md
    snapshot-2026-06-03T08-00-53-125Z.json
  dockstations/
    report-2026-06-05T10-27-31-515Z.md
    snapshot-2026-06-05T10-27-31-515Z.json
  fitbit/
    report-2026-06-05T10-27-16-012Z.md
    snapshot-2026-06-05T10-27-16-012Z.json
  lifefactory/
    report-2026-06-04T13-54-31-515Z.md
    snapshot-2026-06-04T13-54-31-515Z.json
  tela-galaxybook3/
    report-2026-06-04T13-58-28-093Z.md
    snapshot-2026-06-04T13-58-28-093Z.json
  melanger/
    report-2026-06-10T20-43-31-091Z.md
    snapshot-2026-06-10T20-43-31-091Z.json
```

**Relatório (`report-*.md`):**
```markdown
# Monitor OLX Notebooks — 2026-06-10

## Resumo executivo
- Novos anúncios válidos (R$ 2.000–R$ 8.000): **3**
- Alterações de preço detectadas: **2**
- (... mais stats)

## Novos anúncios (R$ 2.000–R$ 8.000)
- R$ 7.500 — Notebook Asus i9 — 32GB RAM / 1TB — https://...

## Mudanças de preço
- R$ 8.000 → R$ 7.200 — Asus ROG Strix — https://...
```

**Snapshot (`snapshot-*.json`):**
```json
{
  "timestamp": "2026-06-10T10:27:53.123Z",
  "items": [
    {
      "id": "1234567",
      "url": "https://...",
      "title": "Notebook Asus i9 14900HX",
      "price_brl": 7200,
      "ram_gb": 32,
      "storage_gb": 1024,
      "status": "active",
      "first_seen": "2026-06-08T10:15:00Z",
      "last_seen": "2026-06-10T10:27:00Z",
      "desc_checked": true
    }
  ]
}
```

---

## Arquitetura de Watchlist

**Padrão modular** (`lib/watchlist-monitor.mjs`):

```javascript
runWatchlistMonitor({
  label: "Lifefactory",
  dataDir: "...",
  profileDir: ".chrome-lifefactory-profile",
  terms: ["lifefactory"],                              // busca
  minPrice: 25,
  maxPrice: 75,
  minSizeMl: 500,                                      // filtro capacidade
  maxSizeMl: 1000,
  excludeTerms: ["mamadeira"],                         // exclusão
  keepTerms: ["garrafa"],                              // override exclusão
  olxCategoryUrls: [                                   // OLX categorias custom
    "https://www.olx.com.br/eletro/...",
    "https://www.olx.com.br/comercio-e-escritorio/...",
  ],
})
```

**Suportado por watchlist:**
- `minPrice`, `maxPrice`: faixa de preço
- `terms`: palavras-chave para buscar (array)
- `minSizeMl`, `maxSizeMl`: filtro de capacidade em ml (opcional, e.g. garrafas)
- `excludeTerms`: palavras que descartam itens (e.g. "220v", "mamadeira")
- `keepTerms`: override — mantém item mesmo que case excludeTerm (e.g. "bivolt" vence "220v")
- `olxCategoryUrls`: URLs de categoria OLX (default: busca geral `/brasil`)

**Cada watchlist é um arquivo mínimo** (~20 linhas):
- `scripts/monitor-dockstations.mjs`
- `scripts/monitor-fitbit.mjs`
- `scripts/monitor-lifefactory.mjs`
- `scripts/monitor-tela-galaxybook3.mjs`
- `scripts/monitor-melanger.mjs`

Adicionar uma nova: copiar um, mudar config, pronto.

---

## Coleta OLX (Notebooks)

**Arquivo:** `scripts/monitor-olx-notebooks-por-cpu.mjs`

**Características especiais:**
- **22 CPUs flagship** (Intel i9-13900KS, i9-14900K, Ryzen 9 7950X3D, etc)
- **Enriquecimento de specs**: RAM, SSD, GPU extraídos da página de detalhe
- **Filtro de defeitos** (descrição): "defeito", "avaria", "não liga", "não ligou", "queimou", "surto elétrico", "retirada de peças"
- **Abertura de detalhe:** sempre abre itens na faixa do relatório (R$ 2k–8k), mesmo com specs completas em listagem, para validar descrição contra defeitos
- **Persistência de validação:** marca `desc_checked: true` nos itens verificados, força reabertura se histórico antigo não tem essa marca
- **Infinite scroll + Cloudflare bypass:** aguarda estabilização de cards na listagem
- **Deduplicação:** ignora itens já no snapshot em dias anteriores

---

## Coleta Enjoei

**Arquivo:** `scripts/lib/watchlist-monitor.mjs` (função `collectEnjoei`)

**Características:**
- **GraphQL API** em `enjusearch.enjoei.com.br` (sem Cloudflare)
- **Secondary fetch** para specs: `pages.enjoei.com.br/products/{id}/v2.json`
- **Backfill de specs** do título quando fetch falha
- **Validação de termos**: confirma que CPU/termo está no título/descrição (evita false positives do fuzzy search)

---

## Automação local (Windows)

**Script:** `scripts/run-local-olx-and-publish.ps1`

**Fluxo:**
1. **Espera por internet** (até 20 min): testa TCP 443 em github.com/olx.com.br
2. **Git clean** (untracked Enjoei test files)
3. **Fetch + rebase** inicial
4. **Roda OLX** (via Chrome debug)
5. **Roda Enjoei** monitores (Notebooks, Tênis, Dockstations, Fitbit, Lifefactory, Tela, Melanger)
6. **Loop de publicação** (até 4 tentativas):
   - Commit dados (data/olx, data/dockstations, data/fitbit, data/lifefactory, data/tela-galaxybook3, data/melanger)
   - Fetch + rebase -X theirs origin/main
   - **Regenera dashboard** com dados sincronizados
   - Amend ao commit se houver mudança
   - Push com retry exponencial (3s, 6s, 9s entre tentativas)

**Task Scheduler:**
- `Monitor-OLX-0700`: 07:00 BRT
- `Monitor-OLX-1600`: 16:00 BRT

---

## Chrome Debug (OLX local)

**Script:** `scripts/run-olx-monitor.ps1` + `scripts/start-chrome-debug.ps1`

**Particularidades:**
- **Perfil persistente** `.chrome-olx-profile`: mantém cookies/Cloudflare session entre rodadas
- **Reciclagem obrigatória** a cada rodada: fecha Chrome anterior, abre novo (evita sessão zumbi)
- **Port 9222** (Chrome DevTools Protocol): Playwright comunica via CDP

---

## Testes

**Rodar:** `npm test`

**Cobertura:**
- Parsing de preços BRL (com pontos/vírgulas)
- Extração de RAM/SSD/GPU de títulos e descrições
- Reuso de specs do snapshot anterior
- Filtro de defeitos (excludePatterns)
- Filtro de capacidade (ml)
- Parsing de relatórios (novo count, price count, timestamp)
- Teto de R$ 10 mil retroativo
- Bivolt vs 220V puro

**Objetivo:** 108/108 testes passando (incluindo novos testes sobre filtros semânticos).

---

## Troubleshooting

### OLX falha com "exit 1"
**Causa:** Chrome zumbi (PID antigo) segurando port 9222  
**Solução:**
```powershell
# Listar processes Chrome do perfil OLX
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | 
  Where-Object { $_.CommandLine -like "*chrome-olx-profile*" } | 
  Select-Object ProcessId, CommandLine

# Matar PID específico
Stop-Process -Id 12345 -Force
```

### Dashboard não reflete mudança de preço do Enjoei
**Causa:** CI rodou, mas push falhou (rebase conflict) — dados não chegaram ao repo  
**Solução:** rebase -X theirs resolve, mas certifique regeneração do dashboard pós-sincronização (fluxo fix já aplicado)

### Tarefa local não iniciou por falta de Wi-Fi
**Esperado:** script aguarda até 20 min por conectividade (novo comportamento, desde 2026-06-03)  
**Próxima tentativa:** schedule roda de novo em 2h

### Bivolt errado sendo excluído
**Revisar:** `monitor-melanger.mjs` → `keepTerms` deve incluir "bivolt", "110v", etc.

---

## Estrutura de código

```
scripts/
  lib/
    watchlist-monitor.mjs          ← lib compartilhada (coleta OLX/Enjoei, merge, relatório)
  monitor-olx-notebooks-por-cpu.mjs ← monitores especializados (CPU, defei
tos)
  monitor-enjoei-notebooks.mjs
  monitor-enjoei-tenis.mjs
  monitor-dockstations.mjs         ← watchlists genéricas
  monitor-fitbit.mjs
  monitor-lifefactory.mjs
  monitor-tela-galaxybook3.mjs
  monitor-melanger.mjs
  run-monitors-and-notify.mjs      ← orquestrador (roda 8 em paralelo, notifica)
  run-local-olx-and-publish.ps1    ← automação Windows (espera rede, push)
  run-olx-monitor.ps1              ← wrapper Chrome debug
  start-chrome-debug.ps1           ← inicia Chrome com port 9222
  generate-dashboard.mjs           ← gera index.html

tests/
  olx-cache.test.mjs
  olx-detail.test.mjs
  parsers.test.mjs
  (108 testes, cobertura alta)

data/
  olx/, enjoei/, enjoei-notebooks/, dockstations/, fitbit/, 
  lifefactory/, tela-galaxybook3/, melanger/
  (snapshots + relatórios)

.github/
  workflows/
    monitor.yml                    ← CI (cron via workflow_dispatch)

index.html                         ← dashboard gerado
package.json
README.md
.gitignore
```

---

## Histórico de correções recentes

| Data | Problema | Solução |
|---|---|---|
| 03/06 12:03 | OLX exit 1 (Chrome zumbi) | Reciclagem obrigatória de Chrome a cada rodada |
| 03/06 16:00 | CI push falha (rebase conflict) | `rebase -X theirs` + regeneração dashboard pós-sync |
| 03/06 16:01 | Queda de preço tênis não aparece no dashboard | Espera internet antes de iniciar; sempre regenera dashboard após origin |
| 02/06 | Tier consolidation incomplete | Removido sistema de "premium", único tier R$ 2k–8k com teto de 10k em mudanças |
| 02/06 | UTD21B persiste no histórico após swap | Validação de histórico contra termos atuais (`itemMatchesAnyTerm`) |

---

## Notas de design

- **Watchlists + lib compartilhada:** add nova source em minutos sem duplicação
- **Persistência de validação (`desc_checked`):** força reabertura de itens antigos sem verificação quando entram novamente na faixa
- **Teto de 10k retroativo:** não filtra itens >10k da coleta (podem ser histórico), mas do dashboard (sempre mostra estado atual)
- **Bivolt override (`keepTerms`):** modelo genérico para exceções em filtros, extensível
- **Rebase -X theirs:** estratégia para CI×Local conflict no index.html, mantendo origem como verdade
- **Chrome perfil persistente:** cookies/session não recriam a cada rodada, só o processo
- **Snapshot JSON minimalista:** só campos usados (sem GPU para Dockstations, sem specs para Tênis)

---

**Última atualização:** 2026-06-10  
**Commit:** `5bd16a3`
