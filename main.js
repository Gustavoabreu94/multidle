// Multidle: várias contas de jogos idle numa janela só, sem moldura, com um painel de cartões e uma
// área do jogo por conta. Cada conta tem a própria partição (login isolado). Tudo que é de um jogo
// fica no módulo dele em jogos/. Login do Google é feito num Chrome/Edge de verdade (o Google bloqueia
// login em app embutido) e a sessão do jogo é copiada para cá.
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

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

  wc.loadURL(jogo.url);
  views.set(id, v);
}

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
      v.setBounds(r);
      if (!naJanela.has(id)) { win.contentView.addChildView(v); naJanela.add(id); }
    } else if (naJanela.delete(id)) {
      win.contentView.removeChildView(v);
    }
  }
});
ipcMain.on('janela', (_e, acao) => {
  if (acao === 'min') win.minimize();
  if (acao === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (acao === 'fechar') win.close();
});
ipcMain.handle('jogos', () => Object.values(JOGOS).map(({ id, nome, maxContas, avisoLimite, ferramenta, apoioTerceiros, acoes }) => ({
  id, nome, maxContas, avisoLimite, apoioTerceiros,
  acoes: (acoes ?? []).map(({ id: acao, rotulo, dica, confirmar }) => ({ id: acao, rotulo, dica, confirmar })),
  ferramenta: ferramenta && { rotulo: ferramenta.rotulo, titulo: ferramenta.titulo, dica: ferramenta.dica },
})));
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
    setInterval(coletar, ATUALIZAR_MS);
  });
}
