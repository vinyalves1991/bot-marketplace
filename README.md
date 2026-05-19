# Automacao de transcricao no Gemini Web

Esta automacao abre o Chrome em `https://gemini.google.com/app`, anexa os quatro arquivos de audio da pasta `C:\Users\docra\Downloads\Hotmart\job` e envia os prompts em sequencia.

## Verificar login e interface sem enviar arquivos

Validar a ordem dos arquivos sem abrir o Chrome:

```powershell
npm run transcrever:gemini -- --list-files
```

Verificar login e interface sem enviar arquivos:

```powershell
npm run transcrever:gemini -- --verify-ui
```

Por padrao, o script abre um perfil dedicado em `.chrome-gemini-profile`. Para usar o Chrome real ja logado, o Chrome precisa ter sido aberto com depuracao remota local.

1. Feche todas as janelas do Chrome manualmente.
2. Abra o Chrome com depuracao remota:

```powershell
.\scripts\start-chrome-debug.ps1
```

Para listar os perfis detectados:

```powershell
.\scripts\start-chrome-debug.ps1 -ListProfiles
```

Para abrir direto em um perfil especifico:

```powershell
.\scripts\start-chrome-debug.ps1 -ProfileDirectory "Default"
```

Para tentar restaurar as abas da ultima sessao daquele perfil:

```powershell
.\scripts\start-chrome-debug.ps1 -ProfileDirectory "Default" -RestoreLastSession
```

Para criar/usar um perfil dedicado da automacao, bom quando Google bloqueia login em WebDriver ou quando o Chrome bloqueia depuracao no perfil padrao:

```powershell
.\scripts\start-chrome-debug.ps1 -AutomationProfile
```

Na primeira vez, faca login manualmente no Google/Gemini nessa janela. Depois, a sessao fica salva em `.chrome-gemini-cdp-profile`.

3. Verifique a interface usando o Chrome atual:

```powershell
npm run transcrever:gemini -- --current-chrome --verify-ui
```

Em versoes novas do Chrome, a porta de depuracao pode ser bloqueada no perfil padrao. Nesse caso, use o modo que abre o perfil real diretamente pelo Playwright:

```powershell
npm run transcrever:gemini -- --real-profile --profile-directory "Default" --verify-ui
```

Se quiser tentar restaurar as abas do perfil real ao abrir pelo Playwright, adicione `--restore-session`.

## Rodar a transcricao

Usando o Chrome atual ja logado:

```powershell
npm run transcrever:gemini -- --current-chrome
```

Usando o perfil real do Chrome diretamente:

```powershell
npm run transcrever:gemini -- --real-profile --profile-directory "Default"
```

Usando o perfil dedicado da automacao:

```powershell
npm run transcrever:gemini
```

Tambem e possivel informar outra pasta:

```powershell
npm run transcrever:gemini -- "C:\caminho\para\aula"
```

Durante a execucao, deixe a janela do Chrome aberta. Se o Gemini mudar a interface, pedir confirmacao ou falhar em um upload, pare o script com `Ctrl+C` e ajuste/reexecute.

## Monitor OLX notebooks por CPU

Esta automacao usa o Chrome real via depuracao remota para evitar o bloqueio HTTP/Cloudflare da OLX.

Abra ou reutilize um Chrome com depuracao remota:

```powershell
.\scripts\start-chrome-debug.ps1 -OlxProfile -Url "https://www.olx.com.br"
```

Rode a coleta leve, baseada apenas nos cards da primeira pagina de resultados de cada CPU:

```powershell
npm run monitor:olx-notebooks-por-cpu -- --current-chrome
```

Para a automacao diaria, use o wrapper que abre/reutiliza o Chrome OLX e depois roda o monitor:

```powershell
.\scripts\run-olx-monitor.ps1
```

Por padrao, o wrapper abre o Chrome OLX minimizado/offscreen se ele ainda nao estiver rodando. Para ver a janela durante depuracao:

```powershell
.\scripts\run-olx-monitor.ps1 -Foreground
```

O monitor bloqueia imagens, fontes e midia por padrao para acelerar a coleta. Para depurar carregando todos os assets:

```powershell
npm run monitor:olx-notebooks-por-cpu -- --current-chrome --load-assets
```

Por padrao, o monitor nao abre paginas individuais de anuncios. Isso mantem a execucao curta e usa apenas titulo, preco, localizacao e RAM/SSD quando aparecem no card.

Para forcar explicitamente o modo "somente listagem":

```powershell
npm run monitor:olx-notebooks-por-cpu -- --current-chrome --listing-only
```

Se (e somente se) voce quiser abrir anuncios individuais para validar descricao e tentar extrair RAM/SSD de dentro do anuncio, use:

```powershell
npm run monitor:olx-notebooks-por-cpu -- --current-chrome --open-details
```

Para depurar uma CPU especifica:

```powershell
npm run monitor:olx-notebooks-por-cpu -- --current-chrome --cpu 7840hs --max-per-cpu 12 --debug
```

## Monitor Enjoei tenis 42

Esta automacao consulta diretamente o endpoint JSON de busca do Enjoei, sem abrir navegador. Por padrao, monitora tenis tamanho 42, departamento masculino, todo o Brasil, com preco ate R$ 500.

Termos padrao:

```text
barefoot, feet of tomorrow, fot, vita, vivobarefoot, xero, vibram, merrell, lems
```

Rodar manualmente:

```powershell
npm run monitor:enjoei-tenis
```

Alterar termos, tamanho ou preco maximo:

```powershell
npm run monitor:enjoei-tenis -- --terms "barefoot,xero,lems" --shoe-size 42 --max-price 500 --department masculino
```

Os relatorios e snapshots ficam em:

```text
C:\Users\docra\.codex\automations\monitor-enjoei-tenis-42
```
