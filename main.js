// Multidle: várias contas de jogos idle numa janela só, sem moldura, com um painel de cartões e uma
// área do jogo por conta. Cada conta tem a própria partição (login isolado). Tudo que é de um jogo
// fica no módulo dele em jogos/. Login do Google é feito num Chrome/Edge de verdade (o Google bloqueia
// login em app embutido) e a sessão do jogo é copiada para cá.
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
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

  wc.loadURL(jogo.url);
  views.set(id, v);
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
      v.setBounds(r);
      if (!naJanela.has(id)) { win.contentView.addChildView(v); naJanela.add(id); }
    } else if (naJanela.delete(id)) {
      win.contentView.removeChildView(v);
      const aoEsconder = jogoDe(id)?.aoEsconder; // só contas (ferramentas e lives não têm jogo)
      if (aoEsconder) v.webContents.executeJavaScript(`(${aoEsconder})()`).then((mudou) => mudou && setTimeout(coletar, 2000)).catch(() => {});
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
const RECARREGAR_SEM_DETECTAR_MS = 5 * 60_000;
const lives = new Map(); // login -> { view, nome, aqui, desde }
let canaisOficiais = [];

function abrirLive(login, nome, url) {
  const v = new WebContentsView({ webPreferences: { partition: 'persist:twitch' } });
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
  lives.set(login, { view: v, nome, aqui: false, desde: Date.now() });
}

function fecharLive(login) {
  const l = lives.get(login);
  if (!l) return;
  if (naJanela.delete(LIVE + login)) win.contentView.removeChildView(l.view);
  l.view.webContents.close();
  views.delete(LIVE + login);
  lives.delete(login);
}

const jogoComLive = () => Object.values(JOGOS).find((j) => j.live);
const maxLives = (jogo) => Math.min(jogo.live.limite, Math.max(1, Number(config.maxLives) || jogo.live.padrao));

const enviarLives = () => win?.webContents.send('lives', {
  ligado: !!config.lives,
  entrando: entrandoTwitch,
  max: maxLives(jogoComLive()),
  limite: jogoComLive().live.limite,
  abertas: [...lives].map(([login, l]) => ({ login, nome: l.nome, aqui: l.aqui })),
  semConta: !contas.some((c) => ultimosCartoes.get(c.id)?.twitchVinculada),
});

async function vigiarLives() {
  if (!config.lives) return enviarLives();
  const fonte = contas.find((c) => ultimosCartoes.get(c.id)?.twitchVinculada && JOGOS[c.jogo].live);
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
  for (const c of queremos) {
    const l = lives.get(c.login);
    if (!l) { abrirLive(c.login, c.nome, jogo.live.url(c.login)); continue; }
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
ipcMain.on('lives-max', (_e, n) => {
  config.maxLives = Number(n);
  salvarConfig();
  vigiarLives(); // abre ou fecha lives na hora para bater com o número novo
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
    vigiarAtualizacoes();
    // Lives: primeira leitura depois que as contas carregarem e o primeiro cartão for lido
    setTimeout(vigiarLives, 30_000);
    setInterval(vigiarLives, VIGIAR_LIVES_MS);
  });
}
