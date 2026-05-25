# Monitor OLX & Enjoei

Monitora notebooks e tênis minimalistas em OLX e Enjoei, rodando 2x ao dia via GitHub Actions. Envia e-mail e WhatsApp quando há itens novos.

## Monitores

| Script | O que faz | Faixa |
|---|---|---|
| `monitor-olx-notebooks-por-cpu.mjs` | Busca notebooks na OLX por modelo de CPU | R$ 2.000–R$ 4.000 (+ relatório premium R$ 4.001–R$ 8.000) |
| `monitor-enjoei-notebooks.mjs` | Busca notebooks na Enjoei por modelo de CPU | R$ 1.500–R$ 4.000 |
| `monitor-enjoei-tenis.mjs` | Busca tênis minimalistas na Enjoei | até R$ 500 |

## Rodar manualmente

```powershell
# Cada monitor individualmente
npm run monitor:olx
npm run monitor:enjoei-notebooks
npm run monitor:enjoei-tenis

# Todos em paralelo (com notificação por e-mail/WhatsApp se houver novos)
npm run monitor:todos

# Forçar envio de e-mail/WhatsApp mesmo sem itens novos (teste)
npm run monitor:todos:forcar-email

# Regenerar o dashboard HTML
npm run dashboard
```

## Variáveis de ambiente (credenciais)

Necessárias para notificações. Configurar no Windows com `setx` (persiste entre sessões):

```powershell
setx GMAIL_USER       "seu@gmail.com"
setx GMAIL_APP_PASSWORD "xxxx xxxx xxxx xxxx"   # senha de app do Google
setx NOTIFY_EMAIL_TO  "destino@email.com"
setx CALLMEBOT_PHONE  "5541..."                  # número com DDI, sem +
setx CALLMEBOT_APIKEY "123456"                   # chave gerada pelo CallMeBot
```

No GitHub Actions, as mesmas variáveis são configuradas como **Secrets** em:  
`Settings → Secrets and variables → Actions`

## GitHub Actions

O workflow `.github/workflows/monitor.yml` é disparado pelo **cron-job.org** via `workflow_dispatch` nos horários configurados (07:00 e 16:00 BRT). Ele:

1. Roda os três monitores em paralelo
2. Envia e-mail e WhatsApp se houver itens novos
3. Gera o dashboard `index.html`
4. Commita snapshots e relatórios em `data/`

## Dashboard

Gerado automaticamente a cada run em `index.html`. Disponível via GitHub Pages em:  
`https://almeida3339.github.io/olx-daily/`

Mostra os últimos 5 runs com novidades por categoria, com badges de novos itens e mudanças de preço.

## Relatórios

Salvos em `data/` após cada execução:

```
data/
  olx/
    report-*.md           ← relatório principal (R$ 2k–4k)
    report-premium-*.md   ← relatório premium (R$ 4k–8k), sem notificação
    snapshot-*.json
  enjoei-notebooks/
    report-*.md
    snapshot-*.json
  enjoei/
    report-*.md
    snapshot-*.json
```
