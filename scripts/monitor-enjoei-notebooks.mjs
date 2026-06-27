import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractCpuLabel, extractGpuLabel, extractRamGb, extractStorageGb, textContainsCpuTerm } from "./lib/parsers.mjs";
import { mergeMonitorSnapshot } from "./lib/monitor-core.mjs";
import { DEFAULT_CPU_TERMS, cpuSearchQuery } from "./lib/cpu-terms.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const automationRoot =
  process.env.ENJOEI_NOTEBOOKS_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-enjoei-notebooks");

const SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const SITE_ORIGIN = "https://www.enjoei.com.br";


const EXCLUDE_PATTERNS = [
  "tênis", "tenis", "sandália", "sandalia", "sapato", "chinelo",
  "camiseta", "camisa", "calça", "bermuda", "vestido", "blusa",
  "jaqueta", "casaco", "mochila", "mala",
  "processador avulso", "placa-mãe", "placa mae", "motherboard",
  "sucata", "defeito", "quebrado", "não liga", "nao liga",
];

const PRICE_MIN_BRL = 1500;
const PRICE_MAX_BRL = 8000;

const args = process.argv.slice(2);
const shippingRange = getOptionValue(args, "--shipping-range") ?? "same_country";
const state = getOptionValue(args, "--state") ?? "pr";
const city = getOptionValue(args, "--city") ?? "curitiba";
const first = Number(getOptionValue(args, "--first") ?? 30);
const detailMax = Number(getOptionValue(args, "--detail-max") ?? process.env.ENJOEI_DETAIL_MAX ?? 50);
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? PRICE_MAX_BRL);
const minPriceBrl = Number(getOptionValue(args, "--min-price") ?? PRICE_MIN_BRL);
const cpuArg = getOptionValue(args, "--cpu");
const terms = cpuArg
  ? cpuArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : DEFAULT_CPU_TERMS;

// Só executa quando rodado diretamente (node monitor-enjoei-notebooks.mjs).
// Importado por testes, NÃO dispara a coleta de rede.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`\nFalha: ${formatError(error)}`);
    process.exitCode = 1;
  });
}

function formatError(error) {
  if (!error) return "Erro desconhecido.";
  const message = error.stack || error.message || String(error);
  const cause = error.cause;
  if (!cause) return message;
  return `${message}\nCausa: ${cause.stack || cause.message || String(cause)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runTimestamp = now.toISOString();
  const runId = runTimestamp.replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(automationRoot);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  console.log(`Execução Enjoei Notebooks: ${runTimestamp}`);
  console.log(`Termos: ${terms.join(", ")}`);
  console.log(`Faixa: R$ ${minPriceBrl}–R$ ${maxPriceBrl}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}\n`);

  const { items: collected, failedTerms, successfulTerms, incompleteTerms } = await collectProducts(previousSnapshot);
  const snapshot = mergeEnjoeiNotebookSnapshot({
    runDate, collected, previousSnapshot,
    scheduledTerms: terms, successfulTerms, failedTerms, incompleteTerms,
    priceMin: minPriceBrl, priceMax: maxPriceBrl,
  });
  backfillSpecsFromTitle(snapshot);
  verifyCarriedItems(snapshot);

  await fs.mkdir(automationRoot, { recursive: true });

  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ runDate, snapshot, previousSnapshot, failedTerms, incompleteTerms });
  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`Coletados: ${collected.length} | Snapshot: ${snapshotPath}`);
  console.log(`Relatório: ${reportPath}`);

  // Falha total: TODOS os termos lançaram erro (nada coletado). Preservamos o
  // snapshot anterior (o merge já mantém os itens), mas saímos com código != 0
  // para o orquestrador e o GitHub Actions detectarem a falha.
  if (successfulTerms.length === 0) {
    console.error("Falha total: nenhum termo do Enjoei Notebooks foi coletado nesta rodada; snapshot anterior preservado.");
    process.exitCode = 1;
  }
}

// ── coleta ───────────────────────────────────────────────────────────────────

async function collectProducts(previousSnapshot) {
  const byId = new Map();
  const failedTerms = [];
  const successfulTerms = [];
  const incompleteTerms = [];

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (i > 0) await sleep(400);
    console.log(`Termo: ${term}`);

    try {
      const response = await fetchWithRetry(buildApiUrl(term), {
        headers: {
          accept: "application/json",
          origin: SITE_ORIGIN,
          referer: buildSearchPageUrl(term),
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const products = payload?.data?.search?.products;
      if (!products) throw new Error("Resposta sem data.search.products");

      for (const edge of products.edges ?? []) {
        const item = normalizeProduct(edge.node, term);
        if (!item) continue;
        if (item.price_brl == null || item.price_brl < minPriceBrl || item.price_brl > maxPriceBrl) continue;
        if (!itemMatchesCpuTerm(item, term)) continue;
        if (hasExcludedKeyword(item.title)) continue;

        const existing = byId.get(item.id);
        if (existing) {
          existing.cpu_terms = Array.from(new Set([...(existing.cpu_terms ?? []), term]));
        } else {
          byId.set(item.id, item);
        }
      }
      successfulTerms.push(term);
      // Cobertura truncada: a busca persistida do Enjoei devolve no máximo `first`
      // itens e não expõe cursor utilizável. Página cheia (ou hasNextPage) significa
      // que pode haver itens relevantes além do corte — marcamos o termo como
      // INCOMPLETO para não marcar como not_seen o que ficou só de fora da página.
      if (isTruncatedPage(products, first)) incompleteTerms.push(term);
    } catch (err) {
      console.warn(`  Aviso: falha em "${term}" — ${err.message}`);
      failedTerms.push(term);
    }
  }

  if (failedTerms.length) console.warn(`Termos com falha: ${failedTerms.join(", ")}`);
  if (incompleteTerms.length) console.warn(`Termos truncados (cobertura incompleta): ${incompleteTerms.join(", ")}`);
  const items = await enrichMissingDetails(Array.from(byId.values()), previousSnapshot);
  return { items, failedTerms, successfulTerms, incompleteTerms };
}

// Página truncada: bateu no limite `first` (ou a API sinaliza próxima página).
// Pura, para teste. Ver collectProducts.
export function isTruncatedPage(products, first) {
  const edges = products?.edges ?? [];
  return Boolean(products?.pageInfo?.hasNextPage) || edges.length >= first;
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  let lastError;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      if (i > 1) console.log(`  Retry ${i}/${maxAttempts}...`);
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (i < maxAttempts) await sleep(750 * i);
    }
  }
  const e = new TypeError(`fetch falhou após ${maxAttempts} tentativas`);
  e.cause = lastError;
  throw e;
}

// ── API ──────────────────────────────────────────────────────────────────────

function buildApiUrl(term) {
  const url = new URL(SEARCH_ENDPOINT);
  const ts = Date.now();
  url.searchParams.set("browser_id", `codex-notebooks-${ts}`);
  url.searchParams.set("city", city);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", String(first));
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", `codex-search-${ts}`);
  url.searchParams.set("shipping_range", shippingRange);
  url.searchParams.set("state", state);
  url.searchParams.set("term", cpuSearchQuery(term));
  // sem size_types.shoes nem department — busca geral
  return url;
}

function buildSearchPageUrl(term) {
  const query = cpuSearchQuery(term);
  const url = new URL(`${SITE_ORIGIN}/${encodeURIComponent(query)}/s`);
  url.searchParams.set("ref", "products_search");
  url.searchParams.set("q", query);
  return url.toString();
}

// ── normalização ─────────────────────────────────────────────────────────────

function normalizeProduct(node, cpuTerm) {
  if (!node?.id || !node?.path) return null;
  const price = Number(node.price?.current);
  const title = node.title?.name ?? "";
  return {
    id: String(node.id),
    url: `${SITE_ORIGIN}/p/${node.path}`,
    title,
    brand: node.brand?.displayable_name ?? null,
    price_brl: Number.isFinite(price) ? price : null,
    original_price_brl: Number.isFinite(Number(node.price?.original)) ? Number(node.price.original) : null,
    cpu: extractCpuLabel(title),
    ram_gb: extractRamGb(title),
    storage_gb: extractStorageGb(title),
    used: Boolean(node.used),
    shipping_free: Boolean(node.shipping?.free),
    store_name: node.store?.displayable?.name ?? null,
    cpu_terms: [cpuTerm],
    status: "active",
    first_seen: null,
    last_seen: null,
  };
}

function itemMatchesCpuTerm(item, term) {
  if (textContainsCpuTerm(`${item.title} ${item.brand ?? ""}`, term)) return true;
  // Enjoei's search index may match the CPU in hidden/details text while the
  // API returns only a short title. Trust that signal only for clear notebook
  // listings to avoid unrelated hits such as lamps or clothes.
  return isLikelyNotebookSearchHit(item);
}

function hasExcludedKeyword(text) {
  const n = (text ?? "").toLowerCase();
  return EXCLUDE_PATTERNS.some((p) => n.includes(p));
}

function isLikelyNotebookSearchHit(item) {
  const text = `${item.title ?? ""} ${item.brand ?? ""}`.toLowerCase();
  if (/\b(macbook|apple|ipad|iphone|imac)\b/i.test(text)) return false;
  return /\b(notebook|laptop|elitebook|thinkpad|ideapad|vivobook|zenbook|galaxy book|book4|rog|alienware|predator|legion|loq|tuf|aspire|inspiron|latitude|dell g15)\b/i.test(text);
}

// ── snapshot ─────────────────────────────────────────────────────────────────

function someTermIn(text, cpuTerms) {
  return cpuTerms.some((t) => textContainsCpuTerm(text, t));
}

// Enriquece com detalhes do anúncio e confirma o CPU. Distingue:
//  - termo confirmado na evidência → mantém com o(s) termo(s) corretos;
//  - mismatch CONCLUSIVO (buscamos a descrição e mesmo assim nada confere) → descarta;
//  - inconclusivo TEMPORÁRIO (fetch falhou OU orçamento de detalhes esgotado) →
//    preserva o item se ele já tinha CPU validado em rodada anterior; senão descarta.
// fetchDetails/detailMax/cpuTerms são injetáveis para teste.
export async function enrichMissingDetails(items, previousSnapshot, {
  fetchDetails = fetchProductDetails,
  detailMax: maxDetails = detailMax,
  cpuTerms = DEFAULT_CPU_TERMS,
} = {}) {
  const previousById = new Map((previousSnapshot?.items ?? []).map((item) => [item.id ?? item.url, item]));
  let opened = 0;
  let dropped = 0;
  let preserved = 0;
  const verified = [];

  for (const item of items) {
    const previous = previousById.get(item.id ?? item.url);
    let merged = mergeCachedDetails(item, previous);
    // CPU já validado em rodadas anteriores entra na evidência: um item confirmado
    // no passado não é descartado só porque o título atual é curto.
    const prevTerms = (previous?.cpu_terms ?? []).filter((t) => cpuTerms.includes(t));
    let evidence = `${merged.title ?? ""} ${merged.brand ?? ""} ${previous?.cpu ?? ""}`;

    let fetchAttempted = false;
    let fetchSucceeded = false;
    // Busca a descrição quando faltam specs OU quando a evidência atual não
    // confirma nenhum termo — sem ela não dá pra aceitar cegamente o que a busca
    // difusa do Enjoei devolveu (ex.: i5-12450HX retornado para o termo 13450hx).
    if ((needsProductDetails(merged) || !someTermIn(evidence, cpuTerms)) && opened < maxDetails) {
      fetchAttempted = true;
      opened += 1;
      const details = await fetchDetails(merged).catch((error) => {
        console.warn(`  Aviso: não consegui enriquecer "${merged.title}" — ${error.message}`);
        return null;
      });
      if (details) {
        fetchSucceeded = true;
        merged = mergeCachedDetails(merged, details);
        if (details.text) evidence += ` ${details.text}`;
      }
    }

    // Re-deriva os termos a partir da evidência (não só o termo da busca): um
    // anúncio que na verdade é outra CPU da lista recebe a etiqueta correta.
    const matched = cpuTerms.filter((t) => textContainsCpuTerm(evidence, t));
    if (matched.length > 0) {
      verified.push({ ...merged, cpu_terms: matched });
      continue;
    }

    // Sem termo confirmado. Só descartamos como "CPU não confere" quando a
    // verificação foi CONCLUSIVA (conseguimos a descrição e mesmo assim nada bate).
    const conclusive = fetchSucceeded;
    if (conclusive) {
      dropped += 1;
      console.log(`  Descartado (CPU não confere): "${merged.title}" [buscado: ${(item.cpu_terms ?? []).join(", ")}]`);
      continue;
    }
    // Inconclusivo nesta rodada (fetch falhou ou orçamento esgotado): preserva se
    // já havia CPU validado antes; item novo não confirmável é descartado.
    if (prevTerms.length > 0) {
      preserved += 1;
      console.log(`  Mantido sem reconfirmar (inconclusivo nesta rodada): "${merged.title}" [cpu prévio: ${prevTerms.join(", ")}]`);
      verified.push({ ...merged, cpu_terms: prevTerms });
      continue;
    }
    dropped += 1;
    console.log(`  Descartado (não confirmável e sem histórico): "${merged.title}"`);
  }

  if (opened > 0) console.log(`Detalhes Enjoei abertos: ${opened}`);
  if (preserved > 0) console.log(`Itens preservados sem reconfirmar (inconclusivo): ${preserved}`);
  if (dropped > 0) console.log(`Itens descartados por CPU não confirmado: ${dropped}`);
  return verified;
}

function mergeCachedDetails(item, details) {
  if (!details) return item;
  return {
    ...item,
    cpu: item.cpu ?? details.cpu ?? null,
    ram_gb: item.ram_gb ?? details.ram_gb ?? null,
    storage_gb: item.storage_gb ?? details.storage_gb ?? null,
    gpu: item.gpu ?? details.gpu ?? null,
  };
}

function needsProductDetails(item) {
  return item.cpu == null || item.ram_gb == null || item.storage_gb == null;
}

async function fetchProductDetails(item) {
  if (!item.id) return null;
  const response = await fetchWithRetry(`https://pages.enjoei.com.br/products/${item.id}/v2.json`, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const product = await response.json();
  const text = `${product.title ?? item.title}\n${product.description ?? ""}\n${product.brand?.name ?? ""}`;
  return {
    cpu: extractCpuLabel(text),
    ram_gb: extractRamGb(text),
    storage_gb: extractStorageGb(text),
    gpu: extractGpuLabel(text),
    text, // texto-evidência (título + descrição) para verificar o CPU de fato
  };
}

// Reaproveita melhorias dos parsers em itens carregados de snapshots antigos.
// Itens "not_seen" sao copiados verbatim do snapshot anterior (lib/snapshot.mjs)
// e nao passam por normalizeProduct/enriquecimento, entao ficam com campos
// defasados — ex.: sem o campo cpu, que so foi adicionado depois, ou sem ram/ssd
// que um parser melhorado agora consegue extrair. Preenchemos a partir do TITULO
// apenas (puro, sem rede) e nunca sobrescrevemos dado ja existente. O que so
// existe na descricao (3 dos itens sem cpu) nao e recuperavel aqui de proposito:
// nao refazemos fetch de anuncios que sairam dos resultados.
function backfillSpecsFromTitle(snapshot) {
  for (const item of snapshot.items ?? []) {
    const title = item.title ?? "";
    if (item.cpu == null) { const v = extractCpuLabel(title); if (v != null) item.cpu = v; }
    if (item.ram_gb == null) { const v = extractRamGb(title); if (v != null) item.ram_gb = v; }
    if (item.storage_gb == null) { const v = extractStorageGb(title); if (v != null) item.storage_gb = v; }
    if (item.gpu == null) { const v = extractGpuLabel(title); if (v != null) item.gpu = v; }
  }
}

// Itens "not_seen" são copiados verbatim do snapshot anterior e não passam pela
// verificação de CPU da coleta. Se vierem de um snapshot pré-fix, podem carregar
// termos errados (ex.: um notebook "pro max" marcado como aimax395 pela busca
// difusa). Aqui re-validamos os cpu_terms dos carregados contra título + marca +
// label de CPU já extraído (a descrição não está disponível aqui), descartando
// os que não confirmam nenhum termo. Itens ativos já foram verificados na coleta.
function verifyCarriedItems(snapshot) {
  snapshot.items = (snapshot.items ?? []).filter((item) => {
    if (item.status !== "not_seen") return true;
    const evidence = `${item.title ?? ""} ${item.brand ?? ""} ${item.cpu ?? ""}`;
    // Re-deriva os termos a partir da evidência (não só o termo da busca): um
    // anúncio devolvido por uma busca mas que na verdade é outra CPU da lista
    // recebe a etiqueta correta, em vez de ser descartado.
    const terms = DEFAULT_CPU_TERMS.filter((t) => textContainsCpuTerm(evidence, t));
    if (terms.length === 0) return false;
    item.cpu_terms = terms;
    return true;
  });
}

// Merge com cobertura por termo de CPU. Função pura (sem rede/I/O), exportada
// para teste de regressão.
//  - termo que FALHOU → seus itens não viram not_seen (preservados);
//  - termo TRUNCADO (incompleto) → idem (pode haver itens além da página);
//  - item com 2 termos, um ok e um falho → preservado;
//  - grava run.partial + contagens + coverage arrays.
export function mergeEnjoeiNotebookSnapshot({
  runDate,
  collected,
  previousSnapshot,
  scheduledTerms,
  successfulTerms = [],
  failedTerms = [],
  incompleteTerms = [],
  priceMin,
  priceMax,
}) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => i.price_brl != null && i.price_brl >= priceMin && i.price_brl <= priceMax
  );
  // Termos truncados entram na cobertura FALHA (impede falsos not_seen). Seus
  // itens coletados continuam active (o merge sempre marca o coletado como active).
  const failedCoverage = [...new Set([...failedTerms, ...incompleteTerms])];
  const result = mergeMonitorSnapshot({
    previousSnapshot: previousSnapshot ? { ...previousSnapshot, items: previousItems } : null,
    collected,
    now: new Date(`${runDate}T12:00:00Z`),
    run: {
      partial: failedCoverage.length > 0,
      successful_term_count: successfulTerms.length,
      failed_term_count: failedTerms.length,
      incomplete_term_count: incompleteTerms.length,
      incomplete_coverage: [...new Set(incompleteTerms)],
    },
    scheduledCoverage: scheduledTerms,
    successfulCoverage: successfulTerms,
    failedCoverage,
    configuredCoverage: scheduledTerms,
    itemCoverage: (item) => item.cpu_terms ?? [],
  });
  result.price_range_brl = { min: priceMin, max: priceMax };
  result.filters = { ...result.filters, price_brl: result.price_range_brl };
  return result;
}

// ── relatório ─────────────────────────────────────────────────────────────────

function buildReport({ runDate, snapshot, previousSnapshot, failedTerms = [], incompleteTerms = [] }) {
  const currentItems = snapshot.items.filter(
    (i) => i.status === "active" && i.price_brl != null && i.price_brl >= minPriceBrl && i.price_brl <= maxPriceBrl
  );
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => i.price_brl != null && i.price_brl >= minPriceBrl && i.price_brl <= maxPriceBrl
  );
  const previousById = new Map(previousItems.map((i) => [i.id ?? i.url, i]));
  const currentById = new Map(currentItems.map((i) => [i.id ?? i.url, i]));

  const newItems = currentItems.filter((i) => !previousById.has(i.id ?? i.url));
  const stillActive = currentItems.filter((i) => previousById.has(i.id ?? i.url));
  const notSeen = previousItems
    .filter((i) => i.status === "active")
    .filter((i) => !currentById.has(i.id ?? i.url));

  const priceChanges = [];
  for (const item of currentItems) {
    const prev = previousById.get(item.id ?? item.url);
    if (prev?.price_brl != null && item.price_brl != null && prev.price_brl !== item.price_brl) {
      priceChanges.push({ item, from: prev.price_brl, to: item.price_brl });
    }
  }

  const lines = [];
  lines.push(`# Monitor Enjoei notebooks por CPU — ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos notebooks (R$ ${fmtBrl(minPriceBrl)}–R$ ${fmtBrl(maxPriceBrl)}): **${newItems.length}**`);
  lines.push(`- Já vistos e ativos: **${stillActive.length}**`);
  lines.push(`- Não vistos nesta rodada: **${notSeen.length}**`);
  lines.push(`- Alterações de preço: **${priceChanges.length}**`);
  lines.push(`- Termos: ${terms.join(", ")}`);
  if (snapshot.run?.partial) {
    lines.push(`- ⚠️ Cobertura parcial: ${failedTerms.length} com falha, ${incompleteTerms.length} truncado(s) — itens desses termos foram preservados (não marcados como não vistos).`);
  }
  lines.push("");

  if (failedTerms.length || incompleteTerms.length) {
    lines.push("## Cobertura incompleta");
    if (failedTerms.length) lines.push(`- Termos com falha: ${failedTerms.join(", ")}`);
    if (incompleteTerms.length) lines.push(`- Termos truncados (atingiram o limite de ${first} resultados): ${incompleteTerms.join(", ")}`);
    lines.push("");
  }

  lines.push(`## Novos notebooks`);
  if (!newItems.length) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(newItems)) lines.push(formatLine(item));
  }
  lines.push("");

  if (priceChanges.length) {
    lines.push("## Mudanças de preço");
    for (const c of priceChanges.sort((a, b) => a.to - b.to)) {
      lines.push(`- R$ ${fmtBrl(c.from)} → R$ ${fmtBrl(c.to)} — ${c.item.title} — ${c.item.url}`);
    }
    lines.push("");
  }

  lines.push("## Já vistos e ativos");
  if (!stillActive.length) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(stillActive)) lines.push(formatLine(item));
  }
  lines.push("");

  if (notSeen.length) {
    lines.push("## Não vistos nesta rodada");
    lines.push("- Observação: ausência não garante remoção do anúncio.");
    for (const item of sortByPrice(notSeen)) lines.push(`- ${item.title} — ${item.url}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatLine(item) {
  const ram = item.ram_gb ? `${item.ram_gb} GB RAM` : "RAM n/d";
  const sto = item.storage_gb ? `${item.storage_gb} GB` : "armazenamento n/d";
  const ship = item.shipping_free ? " — frete grátis" : "";
  const terms = item.cpu_terms?.length ? ` — cpu: ${item.cpu_terms.join(", ")}` : "";
  return `- R$ ${fmtBrl(item.price_brl)} — ${item.title} — ${ram} / ${sto}${ship}${terms} — ${item.url}`;
}

function sortByPrice(items) {
  return [...items].sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function fmtBrl(v) {
  if (v == null || !Number.isFinite(Number(v))) return "n/d";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── utilitários ───────────────────────────────────────────────────────────────

async function getLatestSnapshotPath(root) {
  const entries = await fs.readdir(root).catch(() => []);
  const snapshots = entries
    .filter((n) => /^snapshot-.*\.json$/.test(n))
    .map((n) => path.join(root, n))
    .sort();
  return snapshots.at(-1) ?? null;
}

async function readJsonSafe(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return null; }
}

function getOptionValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}
