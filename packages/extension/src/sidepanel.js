/**
 * Painel lateral do NOMOS — cliente da API v1, exatamente como a NOMOS Web.
 *
 * TRÊS REGRAS, herdadas do console e não renegociáveis aqui:
 *
 *  1. O painel NUNCA fala com o Chromium. Toda intenção vira chamada ao
 *     runtime (browser.task, browser.*), que aplica política, autonomia,
 *     aprovação e auditoria. O LLM não tem atalho por dentro da extensão.
 *  2. A UI LÊ, NÃO DEDUZ. Estado, modo de autonomia, fila de aprovação e
 *     controle vêm de `/live` e dos eventos. Sem estado comprovado, o painel
 *     mostra DESCONHECIDA e trata como PERGUNTAR (fail-safe).
 *  3. O feed mostra o que o agente FEZ (eventos operacionais). Raciocínio
 *     privado do modelo não aparece — transparência não é voyeurismo.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  base: null,
  token: null,
  sessionId: null,
  ws: null,
  backoff: 1000,
  controle: "agent",
  pausado: false,
  modo: null,
  pendente: null,
  decidindo: false,
  contextoPagina: null,
  timers: [],
};

function auth(h) {
  const o = Object.assign({}, h || {});
  if (S.token !== null) o.authorization = "Bearer " + S.token;
  return o;
}

async function gestao(rota, metodo, corpo) {
  const r = await fetch(S.base + rota, {
    method: metodo || "GET",
    headers: auth(corpo ? { "content-type": "application/json" } : {}),
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) {
    const e = new Error(rota + " → HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function acaoCrua(tool, corpo) {
  const r = await fetch(S.base + "/api/v1/" + tool, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify(Object.assign({ session_id: S.sessionId }, corpo || {})),
  });
  const env = await r.json().catch(() => null);
  if (env === null) throw new Error("resposta não-JSON do runtime");
  if (env.success === false) {
    const cod = (env.error && env.error.code) || "INTERNAL";
    const e = new Error((env.error && env.error.message) || cod);
    e.code = cod;
    e.detail = env.error && env.error.detail;
    throw e;
  }
  return env.result;
}

// O lease do criador da sessão EXPIRA com a ociosidade (TTL curto, de
// propósito). O teste de produção real pegou o buraco: painel aberto, dono
// toma um café, primeira ação seguinte morria em CONTROL_NOT_OWNED. Aqui o
// painel readquire o lease — UMA vez, com registro no feed — e repete a ação.
// Se o lease estiver com OUTRO portador, a recusa fica de pé: readquirir só é
// legítimo quando o volante está no chão, nunca para tomá-lo de alguém.
function semLease(e) {
  const d = e.detail || {};
  return e.code === "CAPABILITY_DENIED" &&
    (d.lease === "CONTROL_NOT_OWNED" || d.reason === "CONTROL_NOT_OWNED") &&
    (d.current_holder === null || d.current_holder === undefined);
}

async function acao(tool, corpo) {
  try {
    return await acaoCrua(tool, corpo);
  } catch (e) {
    if (!semLease(e) || S.sessionId === null) throw e;
    await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/lease", "POST", {});
    feed("lease.readquirido", "a sessão estava ociosa; volante retomado");
    return acaoCrua(tool, corpo);
  }
}

// ── chat ──────────────────────────────────────────────────────────────
function bolha(cls, html, texto) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  if (html !== null) d.innerHTML = html;
  if (texto !== undefined) d.appendChild(document.createTextNode(texto));
  const m = $("mensagens");
  m.appendChild(d);
  m.scrollTop = m.scrollHeight;
  while (m.childElementCount > 200) m.firstElementChild.remove();
  return d;
}
const gi = (t, erro) => bolha("gi" + (erro ? " erro" : ""), "<b>Gi</b> · ", t);
const sistema = (t) => bolha("sistema", null, t);

// ── feed operacional ──────────────────────────────────────────────────
const ROTULO = {
  "action.proposed": "Pedindo autorização",
  "action.approved": "Autorizado",
  "action.denied": "Negado",
  "action.started": "Executando",
  "action.completed": "Concluído",
  "action.failed": "Falhou",
  "autonomy.changed": "Autonomia alterada",
  "cancel.too_late": "Tarde demais — a ação já havia terminado",
  "owner.changed": "Controle transferido",
  "agent.paused": "Agente pausado",
  "agent.resumed": "Agente retomado",
  "emergency_stop": "PARADA DE EMERGÊNCIA",
  "page.loaded": "Página carregada",
  "task.started": "Task iniciada",
  "task.progress": "Progresso",
  "task.completed": "Task concluída",
  "task.failed": "Task falhou",
  "lease.readquirido": "Sessão retomada",
};

function feed(nome, texto, erro) {
  const d = document.createElement("div");
  d.className = "ev" + (erro ? " erro" : "");
  const hora = new Date().toLocaleTimeString("pt-BR", { hour12: false });
  const b = document.createElement("b");
  b.textContent = ROTULO[nome] || nome;
  d.appendChild(b);
  d.appendChild(document.createTextNode(" " + hora + (texto ? " · " + texto : "")));
  const f = $("feed");
  f.prepend(d);
  while (f.childElementCount > 80) f.lastElementChild.remove();
}

// ── conexão ───────────────────────────────────────────────────────────
async function conectar(base, token) {
  S.base = base.replace(/\/$/, "");
  S.token = token || null;
  const h = await gestao("/health"); // 401 aqui = token errado; catch do chamador
  $("vivo").dataset.live = h.runtime === "ok" ? "1" : "0";
  $("conexao").hidden = true;
  $("chat").hidden = false;
  await sessoes();
  conectarEventos();
  pararTimers();
  S.timers.push(setInterval(saude, 5000));
  S.timers.push(setInterval(sessoes, 4000));
  S.timers.push(setInterval(estadoVivo, 800));
  S.timers.push(setInterval(abas, 5000));
  await estadoVivo();
  await abas();
  sistema("Conectado ao runtime " + S.base);
  await boasVindas();
}

// Primeira impressão: o painel nunca abre mudo. Uma saudação da Gi em estado
// vazio, o input focado e — só na primeira vez — um cartão de boas-vindas
// curto. Nada de tutorial longo: depois disto, é conversa direta.
async function boasVindas() {
  try {
    const { nomos_onboarded } = await chrome.storage.local.get("nomos_onboarded");
    if (!nomos_onboarded) $("onboarding").hidden = false;
  } catch { /* sem storage.local: sem onboarding, sem bloqueio */ }
  if ($("mensagens").childElementCount === 0) {
    gi("Olá! Sou a Gi. Estou vendo a página ao lado — pergunte sobre ela ou peça uma ação. Quando algo exigir sua autorização, eu peço aqui mesmo.");
  }
  $("texto").focus();
}

function pararTimers() {
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
}

async function saude() {
  try {
    const h = await gestao("/health");
    $("vivo").dataset.live = h.runtime === "ok" ? "1" : "0";
  } catch (e) {
    $("vivo").dataset.live = "0";
    // 401/403 NÃO é "inalcançável" — é o daemon vivo recusando a credencial.
    // O caso real: o runtime reiniciou e o token rotacionou. Dizer
    // "inalcançável" mandaria o dono investigar o processo errado. A tela
    // reabre a conexão e diz o que aconteceu; o token novo está no
    // clipboard (o lançador copia a cada arranque).
    if (e.status === 401 || e.status === 403) {
      $("hSessao").textContent = "credencial expirada — reconecte";
      $("conexao").hidden = false;
      $("cErro").textContent = "o runtime reiniciou e a credencial mudou — cole o token novo (Cmd+V)";
      $("cToken").value = "";
    } else {
      $("hSessao").textContent = "runtime inalcançável";
    }
  }
}

async function sessoes() {
  let lista = [];
  try {
    lista = await gestao("/api/v1/sessions");
  } catch {
    return;
  }
  if (lista.length === 0) {
    if (S.sessionId !== null) sistema("A sessão terminou.");
    S.sessionId = null;
    $("hSessao").textContent = "sem sessão ativa";
    return;
  }
  if (S.sessionId === null || !lista.some((s) => s.session_id === S.sessionId)) {
    const viva = lista.find((s) => s.status === "ACTIVE" || s.status === "IDLE") || lista[0];
    S.sessionId = viva.session_id;
    sistema("Sessão " + S.sessionId.slice(-6) + " · perfil " + viva.profile);
  }
  const s = lista.find((x) => x.session_id === S.sessionId);
  $("hSessao").textContent =
    "sessão " + S.sessionId.slice(-6) + " · " + (s ? s.status : "?");
}

// ── estado vivo (a tela LÊ) ───────────────────────────────────────────
const NOME_DO_ESTADO = {
  IDLE: "ocioso", OBSERVING: "observando", THINKING: "pensando", ACTING: "navegando",
  WAITING_APPROVAL: "aguardando sua aprovação", PAUSED: "pausado",
  USER_CONTROL: "você está no controle", CANCELLING: "cancelando",
  CANCELLED: "cancelado", COMPLETED: "concluído", ERROR: "erro", DISCONNECTED: "desconectado",
};

function desconhecido() {
  $("aEstado").textContent = "estado desconhecido";
  $("aEstado").dataset.estado = "DISCONNECTED";
  S.modo = null;
  $("mAsk").setAttribute("aria-pressed", "false");
  $("mAuto").setAttribute("aria-pressed", "false");
  $("mTotal").setAttribute("aria-pressed", "false");
  $("bannerTotal").hidden = true;
  $("mAviso").textContent = "sem estado comprovado — tratando como PERGUNTAR";
}

async function estadoVivo() {
  if (S.sessionId === null) { desconhecido(); return; }
  let e;
  try {
    e = await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/live");
  } catch { desconhecido(); return; }

  $("aEstado").textContent = NOME_DO_ESTADO[e.runtime_state] || e.runtime_state;
  $("aEstado").dataset.estado = e.runtime_state;
  $("aAcao").textContent = e.current_action
    ? e.current_action + (e.action_level ? " · risco " + e.action_level : "")
    : "";

  S.modo = e.autonomy_mode || null;
  $("mAsk").setAttribute("aria-pressed", String(S.modo === "ASK"));
  $("mAuto").setAttribute("aria-pressed", String(S.modo === "AUTO"));
  const total = e.controle_total === true;
  $("mTotal").setAttribute("aria-pressed", String(total));
  $("bannerTotal").hidden = !total;
  $("mAviso").textContent =
    S.modo === "AUTO" && Array.isArray(e.sempre_aprovam) && e.sempre_aprovam.length > 0
      ? "mesmo em AUTO, ainda pergunto: " + e.sempre_aprovam.join(", ")
      : S.modo === null ? "modo desconhecido — tratando como PERGUNTAR" : "";

  aplicarControle(e.control);
  pintarAprovacao(e.approvals_pending || []);
}

function aplicarControle(modo) {
  S.controle = modo;
  document.body.dataset.controle = modo;
  $("btControle").textContent = modo === "human" ? "Devolver controle" : "Assumir controle";
}

// ── aprovação (amarrada à ação; o painel só transporta a decisão) ─────
function pintarAprovacao(pendentes) {
  const caixa = $("aprovacao");
  if (pendentes.length === 0) { caixa.hidden = true; S.pendente = null; return; }
  const a = pendentes[0];
  if (S.pendente !== null && S.pendente.approval_id === a.approval_id && !caixa.hidden) return;
  S.pendente = a;
  $("aprFila").textContent = pendentes.length > 1
    ? pendentes.length + " pedidos na fila; decidindo o mais antigo" : "";
  $("aprAcao").textContent = a.rota || "—";
  $("aprOnde").textContent = a.recurso || "—";
  $("aprNivel").textContent = a.nivel || "—";
  $("aprMotivo").textContent = a.motivo || "—";
  $("aprConsequencia").textContent = a.consequencia || "—";
  $("aprArgs").textContent = JSON.stringify(a.args_visiveis || {}, null, 1);
  caixa.hidden = false;
}

async function decidir(qual) {
  if (S.pendente === null || S.decidindo) return;
  S.decidindo = true;
  const id = S.pendente.approval_id;
  try {
    await gestao("/api/v1/approvals/" + encodeURIComponent(id) + "/" + qual, "POST", { by: "painel" });
    feed("action." + (qual === "approve" ? "approved" : "denied"), S.pendente.rota);
  } catch (e) {
    feed("aprovacao.falhou", String(e.message || e), true);
  } finally {
    S.decidindo = false;
    await estadoVivo();
  }
}

// ── abas (posse do agente; as SUAS abas não aparecem aqui) ────────────
async function abas() {
  if (S.sessionId === null) return;
  if (S.controle === "human") return; // observação congelada durante takeover
  let lista;
  try { lista = await acao("browser.tabs", {}); } catch { return; }
  const p = $("abas");
  p.innerHTML = "";
  for (const t of Array.isArray(lista) ? lista : []) {
    const d = document.createElement("div");
    d.className = "aba";
    d.dataset.ativa = t.active ? "1" : "0";
    const ponto = document.createElement("span"); ponto.className = "ponto";
    const tt = document.createElement("span"); tt.className = "t";
    tt.textContent = (t.title || t.url || t.page_id);
    tt.title = t.url || "";
    const posse = document.createElement("span"); posse.className = "posse";
    posse.textContent = "agente";
    d.append(ponto, tt, posse);
    p.appendChild(d);
  }
}

// ── eventos ao vivo ───────────────────────────────────────────────────
function conectarEventos() {
  if (S.ws !== null) { try { S.ws.close(); } catch { /* já fechado */ } }
  let ws;
  const qs = S.token !== null ? "?token=" + encodeURIComponent(S.token) : "";
  try { ws = new WebSocket(S.base.replace(/^http/, "ws") + "/events" + qs); } catch { return; }
  S.ws = ws;
  ws.onopen = () => { S.backoff = 1000; };
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    const p = ev.payload || {};
    switch (ev.event) {
      case "page.loaded": feed(ev.event, p.url || ""); abas(); break;
      case "session.created":
      case "session.closed": sessoes(); break;
      case "control.taken": aplicarControle("human"); break;
      case "control.returned": aplicarControle("agent"); break;
      case "task.started": gi("Comecei. Acompanhe em AGORA."); break;
      case "task.progress":
        // Só mostra progresso com TEXTO real. O id do passo sozinho ("s1", "s2")
        // é ruído que parecia conversa e não dizia nada.
        if (p.descricao || p.message) gi(String(p.descricao || p.message));
        break;
      case "task.completed":
        gi("Concluído. " + (p.summary || p.resultado || ""));
        // O modelo às vezes deixa a RESPOSTA no próprio plano (ex.: um passo
        // de extract cujo value explica o que encontrou). Isso ficava preso no
        // registro da task — o dono perguntava e a resposta não chegava ao
        // chat (achado do teste de produção real). O painel busca o registro
        // e repete a nota, dizendo de onde ela veio.
        if (ev.task_id || p.task_id) {
          gestao("/api/v1/tasks/" + encodeURIComponent(ev.task_id || p.task_id) +
            "?session_id=" + encodeURIComponent(S.sessionId))
            .then((t) => {
              const passos = (t.plan && t.plan.steps) || [];
              const nota = passos.map((s) => s.value || "").filter((v) => v.length > 40).pop();
              if (nota) gi("Do plano: " + nota.slice(0, 500));
            })
            .catch(() => { /* registro indisponível: o Concluído acima fica */ });
        }
        break;
      case "task.failed": gi("Não consegui terminar: " + (p.error || p.reason || "falha"), true); break;
      case "action.proposed":
      case "action.approved":
      case "action.denied":
      case "cancel.too_late":
      case "agent.paused":
      case "agent.resumed":
      case "emergency_stop":
      case "autonomy.changed":
      case "owner.changed":
        feed(ev.event, p.tool || "", ev.event === "action.denied" || ev.event === "emergency_stop");
        estadoVivo();
        break;
      default:
        if (ev.event.endsWith(".failed")) feed(ev.event, p.tool || p.url || "", true);
    }
  };
  ws.onclose = () => {
    S.backoff = Math.min(S.backoff * 2, 30000);
    setTimeout(() => { if (S.base !== null) conectarEventos(); }, S.backoff);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* fechado */ } };
}

// ── intenção → control plane ──────────────────────────────────────────
// Contexto da aba ativa (título + URL + trecho), pela rota do runtime — nunca
// por API de página do Chromium. É o que faz "que página é esta?" funcionar.
async function montarContexto() {
  if (S.contextoPagina !== null) { const c = S.contextoPagina; S.contextoPagina = null; return c; }
  if (S.controle === "human") return "";
  try {
    const tabs = await acao("browser.tabs", {});
    const ativa = (Array.isArray(tabs) ? tabs : []).find((x) => x.active);
    if (!ativa) return "";
    let excerto = "";
    try { const ex = await acao("browser.extract", { format: "text" }); excerto = String(ex.content || "").slice(0, 1500); }
    catch { /* sem extract: só título+URL */ }
    return '"' + (ativa.title || "") + '" (' + ativa.url + ")" + (excerto !== "" ? " — conteúdo: " + excerto : "");
  } catch { return ""; }
}

// Bolha transitória "Gi · pensando…" — o painel nunca fica mudo esperando.
function giPensando() {
  const d = gi("pensando…");
  d.dataset.pensando = "1";
  return d;
}

// Abre uma task (ação real na página). Em controle total, o runtime aprova
// sozinho; em ASK/AUTO, a aprovação aparece no próprio painel.
async function abrirTask(goal) {
  try {
    const r = await acao("browser.task", { goal });
    gi("Comecei. Acompanhe em AGORA. (task " + String(r.task_id || "").slice(-6) + ")");
  } catch (e) {
    if (e.code === "AGENT_UNAVAILABLE" || /provider|agent/i.test(String(e.message))) {
      gi("O runtime está sem provedor de IA (ai_provider). Sem ele eu não executo tasks — mas controles e auditoria continuam valendo.", true);
    } else {
      gi("O runtime recusou: " + String(e.message || e.code), true);
    }
  }
}

async function enviar() {
  const t = $("texto").value.trim();
  if (t === "" || S.sessionId === null) return;
  $("texto").value = "";
  bolha("user", null, t);
  // A Gi PRIMEIRO responde (rota /ask, leitura, sem aprovação). Se a mensagem
  // for um pedido de AÇÃO, o runtime devolve `act` e o painel abre a task. É o
  // que faz a resposta APARECER aqui — e a ação acontecer quando é o caso.
  const page_context = await montarContexto();
  const pensando = giPensando();
  let r;
  try {
    r = await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/ask", "POST",
      { question: t, page_context });
  } catch (e) {
    pensando.remove();
    gi(e.status === 400
      ? "Preciso de um provedor de IA local (Ollama) para responder. Confira se o Ollama está rodando."
      : "O runtime recusou: " + String(e.message || e.status), true);
    return;
  }
  pensando.remove();
  if (r && typeof r.answer === "string" && r.answer !== "") { gi(r.answer); return; }
  if (r && typeof r.act === "string" && r.act !== "") { gi("Certo — vou fazer isso na página."); await abrirTask(r.act); return; }
  gi("Não consegui responder agora. Pode reformular?", true);
}

// ── contexto da página (via runtime, caminho A0 governado) ────────────
async function contextoDaPagina() {
  if (S.sessionId === null) return;
  try {
    const tabs = await acao("browser.tabs", {});
    const ativa = (tabs || []).find((t) => t.active);
    if (!ativa) { sistema("Nenhuma aba do agente ativa."); return; }
    let excerto = "";
    try {
      const ex = await acao("browser.extract", { format: "text" });
      excerto = String(ex.content || "").slice(0, 600);
    } catch { /* extract pode exigir capability; o contexto segue só com URL */ }
    S.contextoPagina = '"' + (ativa.title || "") + '" (' + ativa.url + ")" +
      (excerto !== "" ? " — trecho: " + excerto : "");
    sistema("Contexto anexado: " + (ativa.title || ativa.url) + ". A próxima mensagem vai com ele.");
    $("texto").focus();
  } catch (e) {
    sistema("Não consegui ler a página: " + String(e.message || e));
  }
}

// ── histórico: Audit e Replay (somente leitura) ───────────────────────
async function historico(filtro) {
  const sec = $("historico");
  if (!sec.hidden && sec.dataset.filtro === filtro) { sec.hidden = true; return; }
  sec.dataset.filtro = filtro;
  sec.hidden = false;
  const meta = $("histMeta"), linha = $("histLinha");
  if (S.sessionId === null) { meta.textContent = "sem sessão"; return; }
  let r;
  try {
    r = await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/replay");
  } catch (e) {
    meta.textContent = "não foi possível ler o histórico";
    linha.textContent = String(e.message || e);
    $("histSelo").hidden = true; $("histSelado").hidden = true;
    return;
  }
  $("histSelo").hidden = r.read_only !== true;
  $("histSelado").hidden = r.selado !== true;
  const c = r.contagens || {};
  meta.textContent = (filtro === "audit" ? "Audit — só ações · " : "Replay — linha do tempo completa · ") +
    (c.acoes || 0) + " ações · " + (c.eventos || 0) + " eventos";
  linha.innerHTML = "";
  const itens = (Array.isArray(r.timeline) ? r.timeline : [])
    .filter((i) => (filtro === "audit" ? i.source === "action" : true));
  if (itens.length === 0) { linha.textContent = "Sem histórico gravado."; return; }
  for (const item of itens.slice(-120)) {
    const d = document.createElement("div");
    d.className = "hi";
    const h = document.createElement("span"); h.className = "h";
    h.textContent = (item.timestamp || "").slice(11, 23) || "—";
    const l = document.createElement("span"); l.className = "l";
    const dd = item.data || {};
    l.textContent = item.label + (item.source === "action" && dd.capability
      ? " (" + [dd.capability, dd.policy_decision, dd.result].filter(Boolean).join(" · ") + ")" : "");
    d.append(h, l);
    linha.appendChild(d);
  }
}

// ── controles ─────────────────────────────────────────────────────────
async function alternarModo(mode) {
  if (S.sessionId === null) return;
  try {
    await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/autonomy", "POST",
      { mode, by: "painel" });
  } catch (e) {
    feed("autonomy.falhou", String(e.message || e), true);
    if (e.status === 403) sistema("O runtime recusou a troca de modo: o token do painel não tem esse escopo. AUTO não é atalho — é delegação, e delegar exige credencial de dono.");
  }
  await estadoVivo();
}

$("mAsk").addEventListener("click", () => alternarModo("ASK"));
$("mAuto").addEventListener("click", () => alternarModo("AUTO"));
$("mTotal").addEventListener("click", async () => {
  if (S.sessionId === null) return;
  const ligar = $("mTotal").getAttribute("aria-pressed") !== "true";
  try {
    await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/full-control", "POST", { on: ligar });
    sistema(ligar
      ? "Controle total LIGADO — a Gi age sem pedir permissão nesta sessão. Desligue quando terminar."
      : "Controle total desligado — a governança voltou (ASK/AUTO valem de novo).");
  } catch (e) {
    feed("controle-total.falhou", String(e.message || e.status), true);
    if (e.status === 403) sistema("Ligar o controle total exige o token do dono (ADMIN).");
  }
  await estadoVivo();
});
$("aprPermitir").addEventListener("click", () => decidir("approve"));
$("aprNegar").addEventListener("click", () => decidir("deny"));
$("enviar").addEventListener("click", enviar);
$("texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
});
$("btPagina").addEventListener("click", contextoDaPagina);
$("btAudit").addEventListener("click", () => historico("audit"));
$("btReplay").addEventListener("click", () => historico("replay"));

$("onbComecar").addEventListener("click", async () => {
  $("onboarding").hidden = true;
  try { await chrome.storage.local.set({ nomos_onboarded: true }); } catch { /* sem storage: reaparece no próximo arranque, sem dano */ }
  $("texto").focus();
});

$("btPausar").addEventListener("click", async () => {
  if (S.sessionId === null) return;
  const pausar = !S.pausado;
  try {
    await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/" + (pausar ? "pause" : "resume"),
      "POST", { by: "painel" });
    S.pausado = pausar;
    $("btPausar").textContent = pausar ? "Retomar" : "Pausar";
    // Retomar a sessão retoma também as tasks que a pausa segurou. Sem isto o
    // dono "retomava" e nada voltava a andar — a task ficava PAUSED esperando
    // um resume que o painel não oferecia (achado do teste de produção real).
    if (!pausar) {
      try {
        const ts = await gestao("/api/v1/tasks?session_id=" + encodeURIComponent(S.sessionId));
        for (const tk of (Array.isArray(ts) ? ts : (ts.tasks || [])).filter((x) => x.state === "PAUSED")) {
          await gestao("/api/v1/tasks/" + encodeURIComponent(tk.task_id) + "/resume", "POST", {});
          feed("task.resumed", "task " + String(tk.task_id).slice(-6) + " retomada do checkpoint");
        }
      } catch (e) {
        feed("task.resume.falhou", String(e.message || e), true);
      }
    }
  } catch (e) {
    feed("pausa.falhou", String(e.message || e), true);
    if (e.status === 403 && !pausar) sistema("Retomar exige escopo ADMIN — a assimetria é deliberada: pausar é freio, retomar é delegação.");
  }
  await estadoVivo();
});

$("btControle").addEventListener("click", async () => {
  if (S.sessionId === null) return;
  const alvo = S.controle === "human" ? "release" : "takeover";
  try {
    await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/" + alvo, "POST", {});
    aplicarControle(alvo === "takeover" ? "human" : "agent");
    sistema(alvo === "takeover"
      ? "Você assumiu. O agente está congelado — inclusive para observar."
      : "Controle devolvido. O runtime vai reobservar a página antes de agir.");
  } catch (e) {
    feed("controle.falhou", String(e.message || e), true);
  }
});

$("btParar").addEventListener("click", async () => {
  if (S.sessionId === null) return;
  try {
    const r = await gestao("/api/v1/sessions/" + encodeURIComponent(S.sessionId) + "/emergency-stop",
      "POST", { by: "painel" });
    feed("emergency_stop", "aprovações negadas: " + ((r.aprovacoes_negadas || []).length), true);
    gi("Parei tudo. A parada roda inteira no runtime — mesmo se este painel cair, ela termina.");
  } catch (e) {
    feed("emergency_stop.falhou", String(e.message || e), true);
  }
  await estadoVivo();
});

// ── arranque ──────────────────────────────────────────────────────────
$("cConectar").addEventListener("click", async () => {
  const url = $("cUrl").value.trim() || "http://127.0.0.1:7777";
  const tok = $("cToken").value.trim();
  $("cErro").textContent = "";
  try {
    await conectar(url, tok === "" ? null : tok);
    await chrome.storage.session.set({ nomos: { url, token: tok } });
  } catch (e) {
    S.base = null;
    $("cErro").textContent = e.status === 401 || e.status === 403
      ? "credencial recusada pelo runtime — confira o token"
      : "runtime inalcançável em " + url;
  }
});

(async function iniciar() {
  // 1. HANDSHAKE do daemon (mesma origem). Quando o painel roda no Chromium do
  //    próprio runtime, o daemon injetou `local-runtime.json` DENTRO do pacote
  //    da extensão (ver daemon.ts). Lê-lo é ler um recurso empacotado da
  //    própria origem chrome-extension:// — nenhuma página web o alcança, e não
  //    há chrome.* de página aqui. É isso que faz o painel abrir JÁ conectado:
  //    sem colar token, sem formulário, sem terminal.
  try {
    const r = await fetch("local-runtime.json", { cache: "no-store" });
    if (r.ok) {
      const hs = await r.json().catch(() => null);
      if (hs !== null && typeof hs.base === "string" && hs.base !== "") {
        await conectar(hs.base, hs.token || null);
        try { await chrome.storage.session.set({ nomos: { url: hs.base, token: hs.token || "" } }); } catch { /* sem storage: recarregar refaz o handshake */ }
        return;
      }
    }
  } catch { S.base = null; /* sem handshake ou runtime fora: tenta o storage */ }

  // 2. RECONEXÃO por storage.session (o dono recarregou o painel).
  try {
    const { nomos } = await chrome.storage.session.get("nomos");
    if (nomos && nomos.url) {
      $("cUrl").value = nomos.url;
      $("cToken").value = nomos.token || "";
      await conectar(nomos.url, nomos.token || null);
      return;
    }
  } catch { S.base = null; /* sem estado salvo ou runtime fora */ }

  // 3. FALLBACK: formulário manual (runtime remoto ou avançado).
  $("cAviso").hidden = false;
  $("conexao").hidden = false;
})();
