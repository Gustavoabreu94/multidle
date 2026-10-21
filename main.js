// Multidle: várias contas de jogos idle numa janela só, sem moldura, com um painel de cartões e uma
// área do jogo por conta. Cada conta tem a própria partição (login isolado). Tudo que é de um jogo
// fica no módulo dele em jogos/. Login do Google é feito num Chrome/Edge de verdade (o Google bloqueia
// login em app embutido) e a sessão do jogo é copiada para cá.
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');

const JOGOS = Object.fromEntries([require('./jogos/pokeidle')].map((j) => [j.id, j]));

const ZOOM = 0.825;
const ATUALIZAR_MS = 15000;
const FERRAMENTA = '__ferramenta:'; // prefixo da área da ferramenta de um jogo no layout (não é conta)

// Pasta fixa (não depende do nome do app). A versão de desenvolvimento (npm start) usa outra:
// não mexe nas sessões da versão instalada e pode abrir junto com ela
app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'multidle' : 'multidle-dev'));
const DADOS = app.getPath('userData');
const ARQ_CONTAS = path.join(DADOS, 'contas.json');
const ARQ_UA = path.join(DADOS, 'ua.txt');

// Quem usava o PokeIdle x4 (versão anterior) traz as contas e sessões na primeira vez. A lista de
// contas vai por último: se a cópia falhar no meio (o app antigo aberto, por exemplo), nada fica
// pela metade e a próxima abertura tenta de novo.
const ANTIGO = path.join(app.getPath('appData'), 'pokeidle-x4');
if (app.isPackaged && !fs.existsSync(ARQ_CONTAS) && fs.existsSync(path.join(ANTIGO, 'contas.json'))) {
  try {
    fs.cpSync(ANTIGO, DADOS, { recursive: true, filter: (src) => !/Cache$|lockfile$|DevToolsActivePort$|contas\.json$/i.test(src) });
    fs.copyFileSync(path.join(ANTIGO, 'contas.json'), ARQ_CONTAS);
  } catch {
    fs.rmSync(DADOS, { recursive: true, force: true });
  }
}

// User agent do navegador real usado no login: o cookie do jogo pode estar preso a ele
app.userAgentFallback = fs.existsSync(ARQ_UA)
  ? fs.readFileSync(ARQ_UA, 'utf8').trim()
  : app.userAgentFallback.replace(/\s?(Electron|multidle)\/\S+/gi, '');

// Navegador para o login: Chrome, ou o Edge que vem em todo Windows
const NAVEGADOR = [
  [process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'],
  [process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'],
  [process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
  [process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'],
  [process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'],
].filter(([base]) => base).map(([base, exe]) => path.join(base, exe)).find((p) => fs.existsSync(p));

// Extensão instalada no Chrome/Edge do usuário (qualquer perfil): pasta da versão mais nova
function acharExtensao(id) {
  const versao = (v) => v.split(/[._]/).map(Number);
  const maisNova = (a, b) => { const x = versao(a), y = versao(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b; return a; };
  const achadas = [];
  for (const base of ['Google/Chrome/User Data', 'Microsoft/Edge/User Data'].map((p) => path.join(process.env.LOCALAPPDATA ?? '', p))) {
    if (!fs.existsSync(base)) continue;
    for (const perfil of fs.readdirSync(base)) {
      const dir = path.join(base, perfil, 'Extensions', id);
      if (!fs.existsSync(dir)) continue;
      for (const v of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, v, 'manifest.json'))) achadas.push(path.join(dir, v));
    }
  }
  return achadas.reduce((a, b) => (a ? (maisNova(path.basename(a), path.basename(b)) === path.basename(a) ? a : b) : b), null);
}

// Precisa vir antes de a página carregar: os scripts da extensão rodam no início do documento
async function carregarExtensoes({ id, jogo }) {
  for (const ext of JOGOS[jogo].extensoes ?? []) {
    const pasta = acharExtensao(ext.id);
    if (pasta) await session.fromPartition(`persist:${id}`).loadExtension(pasta).catch(() => {});
  }
}

let win;
let contas = []; // [{ id: 'Conta1', jogo: 'pokeidle' }]
const views = new Map(); // id da conta (ou da ferramenta) -> WebContentsView
const entrando = new Set(); // contas com login em andamento no navegador

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const salvarContas = () => fs.writeFileSync(ARQ_CONTAS, JSON.stringify(contas));
const hostDe = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const jogoDe = (id) => JOGOS[contas.find((c) => c.id === id)?.jogo];

// ---------- DevTools do navegador de login ----------

function rpc(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('sem conexão')); };
  });
}

// Primeira aba do jogo com sessão salva: devolve localStorage, cookies e user agent
async function lerSessaoNavegador(porta, jogo) {
  const base = `http://127.0.0.1:${porta}`;
  const host = hostDe(jogo.origem);
  const { 'User-Agent': userAgent } = await (await fetch(`${base}/json/version`)).json();
  for (const t of (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === 'page' && hostDe(t.url).endsWith(host))) {
    const r = await rpc(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'JSON.stringify(localStorage)', returnByValue: true });
    const storage = JSON.parse(r.result.value || '{}');
    if (!jogo.logado(storage)) continue;
    const { cookies } = await rpc(t.webSocketDebuggerUrl, 'Network.getCookies', { urls: [jogo.origem] });
    return { storage, cookies, userAgent };
  }
  return null;
}

// Abre um navegador só desta conta (pasta própria, então o Google lembra o login), espera o jogo
// salvar a sessão, copia para cá e fecha o navegador
async function entrar(id) {
  const jogo = jogoDe(id);
  if (!jogo || !NAVEGADOR || entrando.has(id)) return;
  entrando.add(id);
  coletar();
  const dir = path.join(DADOS, 'login', id);
  const arqPorta = path.join(dir, 'DevToolsActivePort');
  fs.rmSync(arqPorta, { force: true });
  spawn(NAVEGADOR, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--new-window', jogo.url],
    { detached: true, stdio: 'ignore' }).unref();
  try {
    for (const fim = Date.now() + 10 * 60_000; Date.now() < fim;) {
      await espera(1500);
      if (!fs.existsSync(arqPorta)) continue;
      const porta = fs.readFileSync(arqPorta, 'utf8').split('\n')[0].trim();
      const sessao = await lerSessaoNavegador(porta, jogo).catch(() => null);
      if (!sessao) continue;
      await aplicarSessao(id, jogo, sessao);
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json();
      await rpc(webSocketDebuggerUrl, 'Browser.close').catch(() => {});
      return;
    }
  } finally {
    entrando.delete(id);
    coletar();
  }
}

const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };

async function aplicarSessao(id, jogo, { storage, cookies, userAgent }) {
  if (userAgent && !fs.existsSync(ARQ_UA)) {
    fs.writeFileSync(ARQ_UA, userAgent);
    app.userAgentFallback = userAgent;
  }
  const ses = session.fromPartition(`persist:${id}`);
  if (userAgent) ses.setUserAgent(userAgent);
  for (const c of cookies) {
    await ses.cookies.set({
      url: jogo.origem, name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: SAME_SITE[c.sameSite] ?? 'unspecified',
      ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
    });
  }
  const wc = views.get(id).webContents;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  await wc.executeJavaScript(`(${(s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }})(${JSON.stringify(storage)})`);
  wc.reload();
}

// ---------- Contas ----------

function criarView({ id, jogo: jogoId }) {
  const jogo = JOGOS[jogoId];
  // A conta começa fora da janela: só entra quando for mostrada (ver 'layout')
  const v = new WebContentsView({ webPreferences: { partition: `persist:${id}` } });
  const wc = v.webContents;
  wc.setAudioMuted(true);
  wc.on('did-finish-load', () => { wc.setZoomFactor(ZOOM); setTimeout(coletar, 3000); });

  // Links que saem do jogo (Twitch, Kick...) abrem numa janela à parte com o mesmo login;
  // o login do Google vai para o navegador; o resto do jogo fica aqui
  const desviar = (e, url = e.url) => {
    const host = hostDe(url);
    if (!host || jogo.hostsDaConta.test(host)) return;
    e.preventDefault();
    if (jogo.hostsLoginExterno.test(host)) return entrar(id);
    new BrowserWindow({ width: 1000, height: 800, autoHideMenuBar: true, webPreferences: { partition: `persist:${id}` } }).loadURL(url);
  };
  wc.on('will-navigate', desviar);
  wc.on('will-redirect', desviar);
  wc.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }));

  views.set(id, v);
  // O sniper precisa do "ouvido" na conexão do jogo antes de a página carregar (o jogo conecta logo
  // no início); o debugger interno do Electron injeta o script no começo de cada carregamento
  if (jogo.sniper?.gancho) {
    try {
      wc.debugger.attach('1.3');
      // sem página nenhuma o comando não responde: carrega uma em branco antes (e o jogo carrega mesmo se falhar)
      const tchau = new Promise((ok) => setTimeout(ok, 5000));
      wc.loadURL('about:blank')
        .then(() => Promise.race([wc.debugger.sendCommand('Page.enable').then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: jogo.sniper.gancho })), tchau]))
        .catch(() => {})
        .finally(() => wc.loadURL(jogo.url));
      return;
    } catch {
      // sem o ouvido o sniper não funciona nesta conta, mas o jogo carrega normalmente
    }
  }
  wc.loadURL(jogo.url);
}

const ultimosCartoes = new Map(); // id da conta -> último cartão lido (as lives usam para achar a conta vinculada)

async function coletar() {
  if (!win || win.isDestroyed()) return;
  const lista = await Promise.all(contas.map(async ({ id, jogo: jogoId }) => {
    const jogo = JOGOS[jogoId];
    const base = { conta: id, jogo: jogoId, entrando: entrando.has(id), semNavegador: !NAVEGADOR };
    try {
      return { ...base, ...jogo.montar(await views.get(id).webContents.executeJavaScript(`(${jogo.extrair})()`)) };
    } catch {
      return base;
    }
  }));
  for (const c of lista) ultimosCartoes.set(c.conta, c);
  if (!win.isDestroyed()) win.webContents.send('dados', lista);
}

// ---------- Painel ----------

// Conta escondida sai da janela (não só fica invisível): assim a página fica "oculta" e o
// Chromium para de desenhar, como numa janela minimizada (~1% de CPU em vez de ~20%)
const naJanela = new Set();
ipcMain.on('layout', (_e, mapa) => {
  for (const [id, v] of views) {
    const r = mapa[id];
    if (r) {
      if (!naJanela.has(id)) {
        if (id.startsWith(LIVE)) janelaLives?.contentView.removeChildView(v); // sai da janela invisível
        win.contentView.addChildView(v);
        naJanela.add(id);
      }
      v.setBounds(r);
    } else if (naJanela.delete(id)) {
      win.contentView.removeChildView(v);
      if (id.startsWith(LIVE)) { guardarLive(v); continue; } // live escondida volta para a janela invisível
      const aoEsconder = jogoDe(id)?.aoEsconder; // só contas (ferramentas e lives não têm jogo)
      if (aoEsconder) v.webContents.executeJavaScript(`(${aoEsconder})()`).then((mudou) => mudou && setTimeout(coletar, 2000)).catch(() => {});
    }
  }
  if (mapa[VOLTAR]) win.contentView.addChildView(views.get(VOLTAR)); // reposiciona por cima da conta maximizada
});
// Botão "Voltar ao painel" por cima da conta maximizada: a página do jogo cobre o painel, então o
// botão é uma área própria (pequena e transparente) posta acima dela, no centro do topo
const VOLTAR = '__voltar';
const HTML_VOLTAR = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
a{display:flex;align-items:center;justify-content:center;height:100%;border-radius:0 0 10px 10px;background:rgba(22,15,25,.72);
color:#f3e9f5;font:600 12px system-ui;text-decoration:none;opacity:.75}a:hover{opacity:1;background:#9b4dca}</style>
<a href="https://multidle.local/voltar" title="Sair do modo maximizado e voltar aos cartões">&#x2921; Voltar ao painel</a>`;
function criarBotaoVoltar() {
  const v = new WebContentsView();
  v.setBackgroundColor('#00000000');
  v.webContents.on('will-navigate', (e) => { e.preventDefault(); win.webContents.send('voltar'); });
  v.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML_VOLTAR)}`);
  views.set(VOLTAR, v);
}

ipcMain.on('janela', (_e, acao) => {
  if (acao === 'min') win.minimize();
  if (acao === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (acao === 'fechar') win.close();
});
ipcMain.handle('jogos', () => Object.values(JOGOS).map(({ id, nome, maxContas, avisoLimite, ferramenta, apoioTerceiros, acoes, venda }) => ({
  id, nome, maxContas, avisoLimite, apoioTerceiros,
  venda: venda && { rotulo: venda.rotulo, dica: venda.dica },
  depot: !!JOGOS[id].depot,
  acoes: (acoes ?? []).map(({ id: acao, rotulo, dica, confirmar }) => ({ id: acao, rotulo, dica, confirmar })),
  ferramenta: ferramenta && { rotulo: ferramenta.rotulo, titulo: ferramenta.titulo, dica: ferramenta.dica },
})));
// Venda do Depot (duas etapas; a confirmação do jogo fica aberta entre elas, esperando o usuário)
ipcMain.handle('venda-preparar', async (_e, id) => {
  const venda = jogoDe(id)?.venda;
  if (!venda) return { erro: 'Este jogo não tem venda pelo Multidle.' };
  const pagina = views.get(id).webContents;
  pagina.setBackgroundThrottling(false); // a preparação espera a aba e a confirmação do jogo abrirem
  return pagina.executeJavaScript(`(${venda.preparar})()`).catch((e) => ({ erro: e.message }))
    .finally(() => pagina.setBackgroundThrottling(true));
});
ipcMain.handle('venda-concluir', async (_e, id, vender) => {
  const venda = jogoDe(id)?.venda;
  if (!venda) return false;
  const ok = await views.get(id).webContents.executeJavaScript(`(${venda.concluir})(${vender ? 'true' : 'false'})`).catch(() => false);
  setTimeout(coletar, 1500);
  return ok;
});

// Depot: listar (abre e fecha a ficha de cada Pokémon, por isso sem desaceleração) e guardar na Coleção
async function rodarSemDesacelerar(id, codigo) {
  const pagina = views.get(id).webContents;
  pagina.setBackgroundThrottling(false);
  return pagina.executeJavaScript(codigo).catch((e) => ({ erro: e.message })).finally(() => pagina.setBackgroundThrottling(true));
}
ipcMain.handle('depot-listar', (_e, id) => {
  const depot = jogoDe(id)?.depot;
  return depot ? rodarSemDesacelerar(id, `(${depot.listar})()`) : { erro: 'Este jogo não tem Depot no Multidle.' };
});
ipcMain.handle('depot-guardar', async (_e, id, chave) => {
  const depot = jogoDe(id)?.depot;
  if (!depot || typeof chave !== 'string') return false;
  return views.get(id).webContents.executeJavaScript(`(${depot.guardar})(${JSON.stringify(chave)})`).catch(() => false);
});

// Ação do jogo numa conta (ex.: RESET da sessão), mesmo com a conta escondida
ipcMain.handle('acao', async (_e, id, acaoId) => {
  const acao = jogoDe(id)?.acoes?.find((a) => a.id === acaoId);
  if (!acao) return false;
  const ok = await views.get(id).webContents.executeJavaScript(`(${acao.rodar})()`).catch(() => false);
  setTimeout(coletar, 500);
  return ok;
});
ipcMain.on('nova', async (_e, jogoId) => {
  const jogo = JOGOS[jogoId];
  if (!jogo || contas.filter((c) => c.jogo === jogoId).length >= jogo.maxContas) return;
  const conta = { id: `Conta${Math.max(0, ...contas.map((c) => +c.id.slice(5))) + 1}`, jogo: jogoId };
  contas.push(conta);
  salvarContas();
  await carregarExtensoes(conta);
  criarView(conta);
  entrar(conta.id);
});
ipcMain.on('remover', async (_e, id) => {
  const v = views.get(id);
  if (!v || !jogoDe(id)) return;
  if (naJanela.delete(id)) win.contentView.removeChildView(v);
  v.webContents.close();
  views.delete(id);
  contas = contas.filter((c) => c.id !== id);
  salvarContas();
  await session.fromPartition(`persist:${id}`).clearStorageData(); // apaga o login dela
  fs.rmSync(path.join(DADOS, 'login', id), { recursive: true, force: true });
  coletar();
});
ipcMain.on('entrar', (_e, id) => entrar(id));

// Atualização automática pelas releases do GitHub: baixa em segundo plano, avisa no painel e instala
// ao clicar no aviso (ou ao fechar o programa). Só na versão instalada.
const VERIFICAR_ATUALIZACAO_MS = 6 * 3600_000;
let versaoBaixada = null;
function vigiarAtualizacoes() {
  if (!app.isPackaged) return;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', ({ version }) => {
    versaoBaixada = version;
    win.webContents.send('atualizacao', version);
  });
  autoUpdater.on('error', () => {}); // sem internet ou GitHub fora: tenta de novo no próximo ciclo
  const verificar = () => autoUpdater.checkForUpdates().catch(() => {});
  verificar();
  setInterval(verificar, VERIFICAR_ATUALIZACAO_MS);
}
ipcMain.handle('versao-baixada', () => versaoBaixada);
ipcMain.on('instalar-atualizacao', () => { if (versaoBaixada) autoUpdater.quitAndInstall(true, true); });
ipcMain.on('atualizar', () => coletar());

// Ferramenta do jogo (no PokeIdle, o simulador de hunt) numa área própria. Com conta: o jogo
// prepara os dados dela (a ficha do Pokémon) e a ferramenta já roda com eles.
function viewFerramenta(jogo) {
  const chave = FERRAMENTA + jogo.id;
  if (views.has(chave)) return views.get(chave);
  const v = new WebContentsView({ webPreferences: { partition: `persist:${chave}` } });
  v.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  v.webContents.loadURL(jogo.ferramenta.url);
  views.set(chave, v);
  return v;
}

ipcMain.handle('ferramenta', async (_e, jogoId, id) => {
  const jogo = JOGOS[jogoId];
  if (!jogo?.ferramenta) return false;
  const wc = viewFerramenta(jogo).webContents;
  if (!id) return true;
  if (jogoDe(id) !== jogo) return false;
  // Conta escondida tem os timers desacelerados (até 1 por minuto): a preparação espera alguns
  // décimos entre um passo e outro, então libera só enquanto ela roda
  const conta = views.get(id).webContents;
  conta.setBackgroundThrottling(false);
  const dados = await conta.executeJavaScript(`(${jogo.ferramenta.preparar})()`).catch(() => '')
    .finally(() => conta.setBackgroundThrottling(true));
  if (!dados) return false;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  await wc.executeJavaScript(`(${jogo.ferramenta.aplicar})(${JSON.stringify(dados)})`);
  return true;
});

// ---------- Lives da Twitch ----------
// Bônus de live: o servidor do jogo procura o jogador no CHAT da live oficial uma vez por minuto. As
// lives ficam abertas aqui (twitch.tv de verdade, logada na conta do usuário, sem som, 160p); a cada
// 2 min o Multidle lê no jogo quais lives com bônus estão no ar, abre/fecha conforme, e recarrega a
// que está aberta há um tempo sem o jogo detectar o jogador nela (o caso de "caiu").
const ARQ_CONFIG = path.join(DADOS, 'config.json');
const config = fs.existsSync(ARQ_CONFIG) ? JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')) : {};
const salvarConfig = () => fs.writeFileSync(ARQ_CONFIG, JSON.stringify(config));
const LIVE = '__live:'; // prefixo da área de cada live no layout
const VIGIAR_LIVES_MS = 2 * 60_000;
// A lista de quem está no chat que a Twitch dá ao jogo demora alguns minutos para atualizar (no teste,
// ~5 min); recarregar antes disso sai e entra da sala de novo e pode zerar a espera
const RECARREGAR_SEM_DETECTAR_MS = 10 * 60_000;
const lives = new Map(); // login -> { view, nome, aqui, desde }
let canaisOficiais = [];

// Live solta (fora de janela) fica com largura 0 e o chat da Twitch NUNCA entra na sala do canal (testado:
// loga no chat mas não manda o JOIN, e o jogo não acha o jogador). Por isso as lives moram numa janela
// invisível de tamanho normal, sem desacelerar; o modal só pega emprestado para mostrar.
// No modo "só o chat" a janela pode ser pequena e desacelerar normalmente: o chat entra na sala e continua
// recebendo do mesmo jeito (testado lado a lado); a live com vídeo precisa do tamanho cheio
const LIVE_TAMANHO = { x: 0, y: 0, width: 1280, height: 720 };
const CHAT_TAMANHO = { x: 0, y: 0, width: 400, height: 500 };
const tamanhoLive = () => (config.livesSoChat ? CHAT_TAMANHO : LIVE_TAMANHO);
let janelaLives = null;
function guardarLive(v) {
  janelaLives ??= new BrowserWindow({ show: false, ...LIVE_TAMANHO, skipTaskbar: true, title: 'Multidle — lives' });
  janelaLives.contentView.addChildView(v);
  v.setBounds(tamanhoLive());
}

function abrirLive(login, nome, url) {
  const v = new WebContentsView({ webPreferences: { partition: 'persist:twitch', backgroundThrottling: !!config.livesSoChat } });
  guardarLive(v);
  const wc = v.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(({ url: externo }) => { shell.openExternal(externo); return { action: 'deny' }; });
  wc.on('render-process-gone', () => wc.reload());
  // Menor qualidade para gastar menos: a Twitch guarda a escolha no localStorage do site
  wc.on('did-finish-load', async () => {
    const mudou = await wc.executeJavaScript(`(() => { const q = JSON.stringify({ default: '160p30' });
      if (localStorage.getItem('video-quality') === q) return false; localStorage.setItem('video-quality', q); return true; })()`).catch(() => false);
    if (mudou) wc.reload();
  });
  wc.loadURL(url);
  views.set(LIVE + login, v);
  lives.set(login, { view: v, nome, url, aqui: false, desde: Date.now() });
}

function fecharLive(login) {
  const l = lives.get(login);
  if (!l) return;
  if (naJanela.delete(LIVE + login)) win.contentView.removeChildView(l.view);
  else janelaLives?.contentView.removeChildView(l.view);
  l.view.webContents.close();
  views.delete(LIVE + login);
  lives.delete(login);
}

const jogoComLive = () => Object.values(JOGOS).find((j) => j.live);
const maxLives = (jogo) => Math.min(jogo.live.limite, Math.max(1, Number(config.maxLives) || jogo.live.padrao));

// Conta da Twitch logada nas lives (cookie "login" da Twitch), para o modal dizer se precisa entrar
const usuarioTwitch = async () => (await session.fromPartition('persist:twitch').cookies.get({ domain: 'twitch.tv', name: 'login' }).catch(() => []))[0]?.value ?? '';

const enviarLives = async () => win?.webContents.send('lives', {
  disponivel: !!config.mostrarLives, // recurso experimental: o botão só aparece para quem liga nas configurações
  ligado: !!config.lives,
  soChat: !!config.livesSoChat,
  entrando: entrandoTwitch,
  usuario: await usuarioTwitch(),
  max: maxLives(jogoComLive()),
  limite: jogoComLive().live.limite,
  abertas: [...lives].map(([login, l]) => ({ login, nome: l.nome, aqui: l.aqui })),
  semConta: !contas.some((c) => ultimosCartoes.get(c.id)?.twitchVinculada),
});

async function vigiarLives() {
  if (!config.lives) return enviarLives();
  const vinculadas = contas.filter((c) => ultimosCartoes.get(c.id)?.twitchVinculada && JOGOS[c.jogo].live);
  // A leitura abre e fecha uma tela do jogo: numa conta aberta na frente do usuário isso piscava e podia
  // fechar a janela que ele estava usando. Só lê de conta escondida; se não houver, mantém a última lista.
  const fonte = vinculadas.find((c) => !naJanela.has(c.id));
  if (!fonte) return enviarLives();
  const jogo = JOGOS[fonte.jogo];
  const pagina = views.get(fonte.id).webContents;
  pagina.setBackgroundThrottling(false); // a leitura espera a tela da Twitch do jogo abrir
  const canais = await pagina.executeJavaScript(`(${jogo.live.lerCanais})()`).catch(() => null)
    .finally(() => pagina.setBackgroundThrottling(true));
  if (!canais) return enviarLives();
  canaisOficiais = canais;
  const queremos = canais.filter((c) => c.aoVivo && c.bonus).slice(0, maxLives(jogo));
  for (const login of [...lives.keys()]) if (!queremos.some((c) => c.login === login)) fecharLive(login);
  const urlDe = (login) => (config.livesSoChat ? jogo.live.urlChat(login) : jogo.live.url(login));
  for (const c of queremos) {
    const l = lives.get(c.login);
    if (l && l.url !== urlDe(c.login)) fecharLive(c.login); // trocou entre "só o chat" e "live com vídeo"
    if (!lives.has(c.login)) { abrirLive(c.login, c.nome, urlDe(c.login)); continue; }
    l.aqui = c.aqui;
    if (c.aqui) l.desde = Date.now();
    else if (Date.now() - l.desde > RECARREGAR_SEM_DETECTAR_MS) { l.view.webContents.reload(); l.desde = Date.now(); }
  }
  enviarLives();
}

// A Twitch bloqueia login em app embutido ("navegador não suportado") e TAMBÉM num Chrome controlado
// por depuração (testado). Então: 1) login num Chrome/Edge normal, sem controle nenhum, até o usuário
// fechar a janela; 2) o mesmo perfil abre escondido, com depuração e sem carregar a Twitch, só para ler
// os cookies salvos; 3) os cookies vão para as lives.
// Abre o perfil do navegador escondido (sem carregar site nenhum) e devolve todos os cookies salvos.
// Logo depois de o usuário fechar a janela o navegador ainda segura o perfil por uns segundos
// (testado: a primeira leitura falhava), então tenta algumas vezes.
async function lerCookiesDoPerfil(dir) {
  const arqPorta = path.join(dir, 'DevToolsActivePort');
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    fs.rmSync(arqPorta, { force: true });
    const leitor = spawn(NAVEGADOR, ['--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 20 && !fs.existsSync(arqPorta); i++) await espera(250);
      if (fs.existsSync(arqPorta)) {
        const base = `http://127.0.0.1:${fs.readFileSync(arqPorta, 'utf8').split('\n')[0].trim()}`;
        const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
        const { cookies } = await rpc(webSocketDebuggerUrl, 'Storage.getCookies');
        await rpc(webSocketDebuggerUrl, 'Browser.close').catch(() => {});
        return cookies;
      }
    } catch {
      // perfil ainda em uso ou navegador lento para subir: tenta de novo
    } finally {
      leitor.kill();
    }
    await espera(2000);
  }
  return [];
}

let entrandoTwitch = false;
async function entrarTwitch() {
  if (!NAVEGADOR || entrandoTwitch) return;
  entrandoTwitch = true;
  enviarLives();
  const dir = path.join(DADOS, 'login', 'twitch');
  try {
    const login = spawn(NAVEGADOR, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'https://www.twitch.tv/login'], { stdio: 'ignore' });
    await new Promise((r) => login.once('exit', r)); // o usuário fechou a janela do navegador

    const daTwitch = (await lerCookiesDoPerfil(dir)).filter((c) => /(^|\.)twitch\.tv$/.test(c.domain.replace(/^\./, '')));
    if (!daTwitch.some((c) => c.name === 'auth-token')) return; // fechou sem terminar o login
    const ses = session.fromPartition('persist:twitch');
    for (const c of daTwitch) {
      await ses.cookies.set({
        url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: SAME_SITE[c.sameSite] ?? 'unspecified',
        ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
      }).catch(() => {});
    }
    for (const l of lives.values()) l.view.webContents.reload();
  } catch {
    // navegador não abriu ou o perfil não pôde ser lido: o botão volta e dá para tentar de novo
  } finally {
    entrandoTwitch = false;
    enviarLives();
  }
}
ipcMain.on('lives-entrar', () => { entrarTwitch(); enviarLives(); });

ipcMain.on('lives-ligar', (_e, ligar) => {
  config.lives = !!ligar;
  salvarConfig();
  if (!config.lives) for (const login of [...lives.keys()]) fecharLive(login);
  vigiarLives();
});
ipcMain.on('lives-pedir', () => enviarLives());
ipcMain.on('lives-so-chat', (_e, soChat) => {
  config.livesSoChat = !!soChat;
  salvarConfig();
  vigiarLives(); // reabre as lives no modo novo
});
ipcMain.on('lives-max', (_e, n) => {
  config.maxLives = Number(n);
  salvarConfig();
  vigiarLives(); // abre ou fecha lives na hora para bater com o número novo
});

// ---------- Sniper do Mercado ----------
// Vigia anúncios dos alvos (item por id ou "qualquer shiny") e compra os que estão dentro do preço,
// sempre por UMA conta por anúncio (a com mais saldo; várias contas no mesmo anúncio multiplicariam a
// chance no sorteio, o que os termos tratam como abuso). Respeita a retenção: o pedido sai logo depois
// dela, dentro da janela do sorteio. Começa desligado e em simulação (só registra o que compraria).
const SNIPER_PADRAO = { ligado: false, simulacao: true, saldoMinimo: 20, tetoDiaConta: 500, intervaloS: 45 };
const ARQ_REGISTRO = path.join(DADOS, 'sniper-registro.jsonl');
const jogoComSniper = () => Object.values(JOGOS).find((j) => j.sniper);
function cfgSniper() {
  config.sniper ??= { ...SNIPER_PADRAO, alvos: structuredClone(jogoComSniper().sniper.alvosPadrao) };
  return config.sniper;
}
const hoje = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso do PC
function gastos() {
  if (config.sniperGasto?.dia !== hoje()) config.sniperGasto = { dia: hoje(), real: { conta: {}, alvo: {} }, sim: { conta: {}, alvo: {} } };
  return config.sniperGasto[cfgSniper().simulacao ? 'sim' : 'real'];
}
// As últimas linhas do histórico (arquivo) voltam para a tela ao abrir o programa. Uma tentativa de compra é
// UMA linha que muda de estado (tentando -> comprado/perdido...): cada mudança vai para o fim do arquivo e,
// ao ler, fica só a versão mais nova de cada uma, no lugar da primeira.
const registroSniper = (() => {
  try {
    const porChave = new Map();
    fs.readFileSync(ARQ_REGISTRO, 'utf8').trim().split(/\r?\n/).slice(-8000)
      .forEach((l, i) => { const j = JSON.parse(l); porChave.set(j.anuncio ? `a${j.anuncio}` : i, j); });
    return [...porChave.values()].slice(-5000);
  } catch { return []; }
})();
const gravarLinha = (linha) => fs.appendFile(ARQ_REGISTRO, JSON.stringify(linha) + '\n', () => {});
function registrar(texto, extra = {}) {
  const linha = { em: Date.now(), texto, ...extra };
  registroSniper.push(linha);
  if (registroSniper.length > 5000) registroSniper.shift();
  gravarLinha(linha);
  enviarSniper();
  return linha;
}
function atualizarLinha(linha, mudancas) {
  // A tentativa reserva no teto do dia (para várias ao mesmo tempo não passarem do limite); só a compra fica
  // contando: perdeu, não passou ou ficou sem resposta, a reserva volta
  if (linha.reserva && (mudancas.tipo === 'perdido' || mudancas.tipo === 'erro')) {
    const r = linha.reserva;
    const g = config.sniperGasto?.dia === r.dia ? config.sniperGasto.real : null;
    if (g) { g.conta[r.conta] = Math.max(0, (g.conta[r.conta] ?? 0) - r.gemas); g.alvo[linha.alvo] = Math.max(0, (g.alvo[linha.alvo] ?? 0) - r.qtd); salvarConfig(); }
    delete linha.reserva;
  }
  Object.assign(linha, mudancas, { mudouEm: Date.now() });
  gravarLinha(linha);
  enviarSniper();
}
const tentativas = new Map(); // id do anúncio -> linha da tentativa ainda sem resultado
const numero = (v) => Number(String(v ?? '').replace(/\./g, '').replace(',', '.')) || 0;
const saldoDe = (id, moeda) => numero(ultimosCartoes.get(id)?.selos?.find((s) => s.rot === (moeda === 'orb' ? 'Gemas' : 'Ouro'))?.v);
// saldo mínimo e teto são em Gemas; em ouro valem × ouroPorGema (e o gasto em ouro conta convertido)
const emGemas = (valor, moeda) => (moeda === 'gold' ? valor / (jogoComSniper().sniper.ouroPorGema || 1) : valor);
const nomeDe = (id) => ultimosCartoes.get(id)?.nome || id;
const enviarSniper = () => win?.webContents.send('sniper', { cfg: cfgSniper(), gasto: gastos(), moedas: jogoComSniper().sniper.moedas,
  ouroPorGema: jogoComSniper().sniper.ouroPorGema, nomes: Object.fromEntries(contas.map((c) => [c.id, nomeDe(c.id)])) });

const tentados = new Set(); // anúncios já tratados (agendados, simulados ou sem saldo)
let rodandoSniper = false;
let ultimaRodada = 0;
let giro = 0;

// A conta que compra: a de maior saldo que ainda cabe no teto do dia e no saldo mínimo
function escolherComprador(prontas, a, unidadesRestantes) {
  const s = cfgSniper();
  const g = gastos();
  for (const c of [...prontas].sort((x, y) => saldoDe(y.id, a.moeda) - saldoDe(x.id, a.moeda))) {
    const livre = Math.min(emGemas(saldoDe(c.id, a.moeda), a.moeda) - s.saldoMinimo, s.tetoDiaConta - (g.conta[c.id] ?? 0));
    const qtd = Math.min(a.qtd, unidadesRestantes, Math.floor(livre / emGemas(a.preco, a.moeda)));
    if (qtd >= 1) return { conta: c, qtd };
  }
  return null;
}

function agendarCompra(alvo, a, desvio, prontas) {
  const s = cfgSniper();
  const g = gastos();
  tentados.add(a.id);
  const restantes = alvo.maxDia - (g.alvo[alvo.id] ?? 0);
  if (restantes <= 0) return;
  const escolha = escolherComprador(prontas, a, restantes);
  const descricao = `${a.shiny ? '✨ ' : ''}${a.nome || alvo.nome}${a.nivel ? ` Nv${a.nivel}` : ''} por ${a.preco} ${jogoComSniper().sniper.moedas[a.moeda] ?? a.moeda} (de ${a.vendedor})`;
  if (!escolha) return registrar(`Sem saldo/teto para ${descricao}`, { alvo: alvo.id, tipo: 'sem-saldo' });
  const { conta, qtd } = escolha;
  // reserva no teto do dia já ao agendar (um sorteio perdido não devolve: o teto fica conservador)
  g.conta[conta.id] = (g.conta[conta.id] ?? 0) + qtd * emGemas(a.preco, a.moeda);
  g.alvo[alvo.id] = (g.alvo[alvo.id] ?? 0) + qtd;
  salvarConfig();
  // O pedido sai 0,3 s depois do fim da retenção, no relógio do servidor (dentro da janela de 3 s do sorteio)
  const espera = Math.max(0, a.compravelEm + (desvio || 0) + 300 - Date.now());
  const quando = new Date(Date.now() + espera).toLocaleTimeString('pt-BR');
  const base = { alvo: alvo.id, conta: nomeDe(conta.id) };
  if (s.simulacao) return registrar(`${qtd}× ${descricao}`, { ...base, tipo: 'simulado', detalhe: `🧪 Simulação: compraria às ${quando}` });
  // sem resultado em 90 s depois da liberação, a linha avisa (ver rodarSniper)
  const linha = registrar(`${qtd}× ${descricao}`, { ...base, anuncio: a.id, tipo: 'tentando', detalhe: `⏳ Tentando (libera às ${quando})`, ate: Date.now() + espera + 90_000,
    reserva: { dia: hoje(), conta: conta.id, gemas: qtd * emGemas(a.preco, a.moeda), qtd } });
  tentativas.set(a.id, linha);
  setTimeout(async () => {
    if (!cfgSniper().ligado || cfgSniper().simulacao) { tentativas.delete(a.id); return atualizarLinha(linha, { tipo: 'erro', detalhe: '⚠ Cancelado (sniper desligado)' }); }
    const enviado = await views.get(conta.id)?.webContents
      .executeJavaScript(`(${JOGOS[conta.jogo].sniper.comprar})(${JSON.stringify(JOGOS[conta.jogo].sniper.pedidoCompra(a, qtd))})`).catch(() => false);
    if (!enviado) tentativas.delete(a.id);
    if (linha.tipo === 'tentando') atualizarLinha(linha, enviado ? { enviadoEm: Date.now(), detalhe: '📨 Pedido enviado, aguardando o resultado' } : { tipo: 'erro', detalhe: '⚠ Falhou ao enviar (conta sem conexão)' });
  }, espera);
}

// Partes dos sorteios em andamento (o resultado só fecha no fim de cada um)
const sorteios = new Map();

async function rodarSniper() {
  const s = cfgSniper();
  if (!s.ligado || rodandoSniper || Date.now() - ultimaRodada < s.intervaloS * 1000) return;
  rodandoSniper = true;
  ultimaRodada = Date.now();
  try {
    const prontas = contas.filter((c) => JOGOS[c.jogo].sniper && ultimosCartoes.get(c.id)?.pronto);
    if (!prontas.length) return;
    for (const c of prontas) {
      const ev = await views.get(c.id).webContents.executeJavaScript(`(${JOGOS[c.jogo].sniper.eventos})()`).catch(() => []);
      for (const e of ev) {
        const r = JOGOS[c.jogo].sniper.resultado(e, sorteios);
        if (!r) continue;
        // O aviso do sorteio não diz o anúncio: vai para a tentativa enviada mais antiga desta conta
        const maisAntiga = () => [...tentativas.values()].filter((l) => l.conta === nomeDe(c.id) && l.enviadoEm).sort((x, y) => x.enviadoEm - y.enviadoEm)[0];
        const linha = tentativas.get(r.id) ?? (!r.id || r.sorteio ? maisAntiga() : null);
        if (!linha) { // compra feita à mão no jogo (os avisos soltos não entram)
          if (r.tipo === 'comprado') registrar(r.descricao || `Anúncio ${r.id}`, { conta: nomeDe(c.id), tipo: r.tipo, detalhe: `${r.detalhe} (à mão)` });
          continue;
        }
        if (r.descricao) r.detalhe = `${r.detalhe}: ${r.descricao}`;
        r.id = linha.anuncio;
        if (r.tipo !== 'tentando') tentativas.delete(r.id);
        atualizarLinha(linha, { tipo: r.tipo, detalhe: r.detalhe });
      }
    }
    for (const [id, linha] of tentativas) {
      if (Date.now() < linha.ate) continue;
      tentativas.delete(id);
      atualizarLinha(linha, { tipo: 'erro', detalhe: '⚠ Sem resposta do jogo (confira no Mercado)' });
    }
    const nossos = new Set(prontas.map((c) => nomeDe(c.id)));
    for (const alvo of s.alvos.filter((a) => a.ativo)) {
      const consultora = prontas[giro++ % prontas.length]; // a consulta revesa entre as contas
      const j = JOGOS[consultora.jogo].sniper;
      const { pedido, aba } = j.consulta(alvo);
      const r = await rodarSemDesacelerar(consultora.id, `(${j.consultar})(${JSON.stringify(pedido)}, ${JSON.stringify(aba)})`);
      if (r?.erro) { alvo.erro = r.erro; continue; }
      alvo.erro = '';
      const anuncios = j.anuncios(r.linhas, alvo).filter((a) => a.aberto && a.moeda === alvo.moeda && !nossos.has(a.vendedor));
      alvo.menor = anuncios.length ? Math.min(...anuncios.map((a) => a.preco)) : null;
      alvo.visto = Date.now();
      for (const a of anuncios.filter((x) => x.preco <= alvo.precoMax && !tentados.has(x.id))) agendarCompra(alvo, a, r.desvio, prontas);
      await new Promise((ok) => setTimeout(ok, 500)); // espaça as consultas para não pesar no servidor
    }
  } finally {
    rodandoSniper = false;
    enviarSniper();
  }
}

ipcMain.on('sniper-pedir', () => enviarSniper());
ipcMain.on('sniper-historico', () => shell.openPath(ARQ_REGISTRO));
// Zera o que o dia já contou (gasto por conta e quantidade por alvo), real e simulado
ipcMain.on('sniper-zerar-dia', () => { delete config.sniperGasto; gastos(); salvarConfig(); registrar('Contagem de hoje zerada', { tipo: 'config' }); });
ipcMain.on('sniper-limpar', () => { registroSniper.length = 0; tentativas.clear(); fs.rm(ARQ_REGISTRO, { force: true }, () => {}); enviarSniper(); });
// Histórico filtrado (conta, tipo, período), mais recente primeiro
ipcMain.handle('sniper-registro', (_e, f = {}) => registroSniper
  .filter((l) => (!f.conta || l.conta === f.conta) && (!f.tipo || (f.tipo === 'tentativas' ? !!l.anuncio : l.tipo === f.tipo)) && (!f.de || l.em >= f.de) && (!f.ate || l.em <= f.ate))
  .slice(-500).reverse());
// Itens à venda agora, com nome, para a tela escolher um alvo novo
ipcMain.handle('sniper-catalogo', async () => {
  const c = contas.find((x) => JOGOS[x.jogo].sniper && ultimosCartoes.get(x.id)?.pronto);
  if (!c) return { erro: 'Nenhuma conta carregada para consultar o Mercado.' };
  const j = JOGOS[c.jogo].sniper;
  const r = await rodarSemDesacelerar(c.id, `(${j.consultar})(${JSON.stringify(j.pedidoItens)}, 'itens')`);
  if (r?.erro) return r;
  const nomes = await views.get(c.id).webContents.executeJavaScript(`(${j.nomes})()`).catch(() => []);
  return { itens: j.catalogo(r.resumo, nomes) };
});
ipcMain.on('sniper-salvar', (_e, novo) => {
  const s = cfgSniper();
  const n = (v, min, max, padrao) => (v === '' || !Number.isFinite(Number(v)) ? padrao : Math.min(max, Math.max(min, Number(v))));
  if ('ligado' in novo) { s.ligado = !!novo.ligado; registrar(s.ligado ? `Sniper ligado (${s.simulacao ? 'simulação' : 'COMPRA DE VERDADE'})` : 'Sniper desligado', { tipo: 'config' }); }
  if ('simulacao' in novo) { s.simulacao = !!novo.simulacao; registrar(s.simulacao ? 'Modo simulação ligado' : '⚠ Modo simulação DESLIGADO: o sniper vai comprar de verdade', { tipo: 'config' }); }
  if ('saldoMinimo' in novo) s.saldoMinimo = n(novo.saldoMinimo, 0, 1e9, 20);
  if ('tetoDiaConta' in novo) s.tetoDiaConta = n(novo.tetoDiaConta, 0, 1e9, 500);
  if (Array.isArray(novo.alvos)) {
    s.alvos = novo.alvos.map((a) => ({
      id: String(a.id), tipo: ['shiny', 'diamante'].includes(a.tipo) ? a.tipo : 'item', itemId: a.tipo === 'item' ? Number(a.itemId) || 0 : undefined, nome: String(a.nome || '').slice(0, 40),
      moeda: a.moeda === 'gold' ? 'gold' : 'orb', precoMax: n(a.precoMax, 0, 1e9, 0), maxDia: n(a.maxDia, 0, 1e6, 0), ativo: !!a.ativo,
    })).filter((a) => a.tipo !== 'item' || a.itemId > 0);
  }
  salvarConfig();
  enviarSniper();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  app.whenReady().then(async () => {
    win = new BrowserWindow({
      width: 1280, height: 900, frame: false, backgroundColor: '#1f1523', title: 'Multidle',
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    win.on('closed', () => app.quit());
    win.on('maximize', () => win.webContents.send('maximizada', true));
    win.on('unmaximize', () => win.webContents.send('maximizada', false));
    // Links do painel (Apoiar, repositório) abrem no navegador do sistema, nunca dentro do app
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadFile(path.join(__dirname, 'painel.html'));

    // contas.json do PokeIdle x4 era só a lista de nomes (todas do PokeIdle)
    contas = (fs.existsSync(ARQ_CONTAS) ? JSON.parse(fs.readFileSync(ARQ_CONTAS, 'utf8')) : [])
      .map((c) => (typeof c === 'string' ? { id: c, jogo: 'pokeidle' } : c))
      .filter((c) => JOGOS[c.jogo]);
    salvarContas();
    for (const c of contas) await carregarExtensoes(c);
    contas.forEach(criarView);
    criarBotaoVoltar(); // depois das contas: fica por cima delas
    // Jogo idle precisa continuar rodando: com o Multidle aberto o Windows não suspende o PC (na bateria
    // ele suspendia após 5 min sem uso e as contas paravam). A tela ainda pode apagar normalmente.
    powerSaveBlocker.start('prevent-app-suspension');
    setInterval(coletar, ATUALIZAR_MS);
    vigiarAtualizacoes();
    // Lives: primeira leitura depois que as contas carregarem e o primeiro cartão for lido
    setTimeout(vigiarLives, 30_000);
    setInterval(vigiarLives, VIGIAR_LIVES_MS);
    setInterval(rodarSniper, 5000); // o próprio sniper respeita o intervalo configurado
  });
}
