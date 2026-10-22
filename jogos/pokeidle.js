// Módulo do PokeIdle (pokeidle.io). Cada jogo do Multidle é um módulo assim: diz onde o jogo fica,
// como saber se a conta está logada e como ler a tela para montar o cartão (formato em painel.html).
// As funções `extrair`, `copiarFicha` e `preencherSimulador` rodam DENTRO das páginas (executeJavaScript),
// então só podem usar o que existe lá.

// Roda na página do jogo: só lê o que o jogo já mostra (blocos da sessão, equipe, Automações,
// moedas, achados) e o resumo da hunt que ele mesmo guarda no localStorage
function extrair() {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const nick = txt(document.getElementById('tr-nick'));
  const kpis = {};
  for (const k of document.querySelectorAll('.eco-kpi')) {
    kpis[k.dataset.kpi] = { v: txt(k.querySelector('.eco-kpi-v')), h: txt(k.querySelector('.eco-kpi-h')), sub: txt(k.querySelector('.eco-kpi-sub')) };
  }
  const time = [...document.querySelectorAll('#time .poke-linha')].map((p) => ({
    nome: txt(p.querySelector('.pl-nome')).replace(/Nv\d+|★/g, '').trim(),
    nv: txt(p.querySelector('.pl-lv')).replace('Nv', ''),
    poder: +(p.title.match(/poder (\d+)/)?.[1] ?? 0),
  }));
  // Bolas, revives e poções restantes: os botões do painel de Automações (sempre carregado)
  const mochila = [...document.querySelectorAll('#auto-ball-opts .auto-chip, #auto-revive-opts .auto-chip, #auto-potion-opts .auto-chip')]
    .map((b) => ({
      nome: b.title.split(' — ')[0],
      q: +txt(b.querySelector('.q')).replace(/\D/g, '') || 0,
      ico: b.querySelector('img')?.src ?? '',
      usando: b.classList.contains('on'), // marcado para uso automático
    }));
  const moedas = { ouro: txt(document.getElementById('tr-gold')), diamantes: txt(document.getElementById('tr-diamantes')), gemas: txt(document.getElementById('tr-gemas')) };
  // Achados possíveis no lugar da hunt: o jogo esconde os que não caem ali (ex.: shiny na Outland)
  // Os de shiny (vistos/pegos) não têm imagem: o ícone é um desenho do jogo, vai o rótulo no lugar
  const achados = [...document.querySelectorAll('#eco-achados .eco-slot')].filter((s) => !s.hidden)
    .map((s) => ({ campo: s.dataset.campo, nome: s.title, ico: s.querySelector('img')?.src ?? '',
      ...(s.classList.contains('eco-slot-shiny') && { shiny: txt(s.querySelector('small')) }) }));
  const lugar = txt(document.querySelector('#eco-achados .eco-achados-lugar')).replace(/^·\s*/, '');
  // Estado da caça. Na hunt, o jogo calcula ao lado do relógio: cacando, parado (sem batalha há um
  // tempo), fora ou caindo (sem conexão). Fora da hunt esse painel some (testado: Pokémon no Centro
  // Pokémon); aí vale a tela do jogo (#palco "hunt-ativa") e o botão "Desistir" da hunt.
  const luz = document.querySelector('.eco-luz');
  const palco = document.getElementById('palco')?.className ?? '';
  const desistir = document.getElementById('eco-desistir');
  const naHunt = /hunt-ativa/.test(palco) || (!!desistir && !desistir.hidden && !desistir.classList.contains('hidden'));
  const caca = luz ? { id: luz.dataset.estado ?? '', texto: txt(document.querySelector('.eco-estado')) }
    // Na hunt fora do Modo Economia (testado: voltar do Centro Pokémon não religa o modo): está caçando,
    // mas sem o painel não dá para saber se parou
    : naHunt ? { id: 'cacando', texto: 'na hunt (sem Modo Economia)' }
    : { id: 'fora', texto: /centro-ativo/.test(palco) ? 'no Centro Pokémon' : 'fora da hunt' };
  const tempo = txt(document.querySelector('.eco-tempo'));
  // HP do Pokémon em campo: o primeiro "atual / máximo" do cartão Em campo (o segundo é o XP)
  const hpTxt = [...(document.getElementById('ativo-card')?.querySelectorAll('*') ?? [])]
    .map((e) => (e.children.length ? '' : e.textContent.trim())).find((s) => /^[\d.]+ \/ [\d.]+$/.test(s));
  // Bônus ativos do painel do treinador (VIP, Passe, Guild, Raid...), com o tempo que o jogo mostra. Twitch
  // e Kick sem bônus valendo ("Conectar", "vincular", "assista") ficam de fora.
  const bonus = [...document.querySelectorAll('#tr-ativos .tr-ativo')]
    .filter((b) => !b.matches('.twitch, .kick'))
    .map((b) => ({ nome: [txt(b.querySelector('.selo-vip')), txt(b.querySelector('.tr-ativo-nome'))].filter(Boolean).join(' '), valor: txt(b.querySelector('.tr-ativo-valor')), tempo: txt(b.querySelector('.tr-ativo-tempo')) }))
    .filter((b) => b.nome);
  // Kick: com bônus trocados por pontos, o botão guarda até quando valem (data-kk-fim) e lista quais na dica
  const kk = document.querySelector('.tr-ativo.kick');
  // dica: "Bônus da Kick ativo: +15% XP. Clique para ver..." -> "+15% XP"
  const kick = kk?.dataset.kkFim ? { fim: Number(kk.dataset.kkFim), lista: (kk.title || '').replace(/^[^:]*:\s*/, '').split('. ')[0].replace(/\.$/, '') } : null;
  // Bônus da Twitch no painel do treinador: "tw-conectar" (não vinculada) ou "tw-ativo" (bônus valendo)
  const tw = document.querySelector('.tr-ativo.twitch');
  const twitch = tw ? { vinculada: !tw.classList.contains('tw-conectar'), ativo: tw.classList.contains('tw-ativo'), valor: txt(tw.querySelector('.tr-ativo-valor')) } : null;
  let hunt = null;
  try { hunt = JSON.parse(localStorage.getItem('sessao-hunt:' + nick.toLowerCase())); } catch {}
  return { texto: document.body ? document.body.innerText : '', nick, kpis, time, mochila, moedas, achados, lugar, hunt, caca, tempo, hpTxt: hpTxt ?? '', twitch, bonus, kick, agora: Date.now() };
}

// "faltam N ms" -> "1h 20m" / "45m" / "2d 3h"
function duracao(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

// Roda na página do jogo: lê as lives oficiais da tela da Twitch do jogo (abre e fecha a tela).
// "aqui" = o servidor do jogo já te achou no chat daquela live (ele confere uma vez por minuto).
// Se outra janela do jogo estiver aberta, não mexe e devolve null (tenta na próxima).
async function livesOficiais() {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const botao = document.querySelector('.tr-ativo.twitch');
  const modal = document.getElementById('modal');
  if (!botao || !modal) return null;
  const abri = modal.classList.contains('hidden');
  if (!abri && !document.getElementById('tw-corpo')) return null;
  if (abri) botao.click();
  for (let i = 0; i < 30 && !document.querySelector('#tw-corpo .tw-canal'); i++) await espera(100);
  const canais = [...document.querySelectorAll('#tw-corpo .tw-canal')].map((a) => ({
    login: (a.getAttribute('href') ?? '').split('/').pop().toLowerCase(),
    nome: a.querySelector('.tw-canal-nome')?.textContent.trim() ?? '',
    aoVivo: a.classList.contains('ao-vivo'),
    bonus: a.classList.contains('com-bonus'),
    aqui: a.classList.contains('tw-aqui'),
  })).filter((c) => /^\w+$/.test(c.login));
  if (abri) document.getElementById('modal-fechar')?.click();
  return canais;
}

// Roda na página do jogo: abre a ficha do Pokémon mais forte e aciona o "Copiar p/ ChatGPT" do jogo,
// capturando o texto antes da área de transferência (a do usuário não é tocada). É a ficha que o
// simulador de hunt aceita.
async function copiarFicha() {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const poder = (p) => +(p.title.match(/poder (\d+)/)?.[1] ?? 0);
  const maior = [...document.querySelectorAll('#time .poke-linha')].sort((a, b) => poder(b) - poder(a))[0];
  if (!maior) return '';
  const jaAberta = !document.getElementById('ficha')?.classList.contains('hidden');
  const original = navigator.clipboard.writeText;
  let texto = '';
  navigator.clipboard.writeText = async (t) => { texto = t; };
  try {
    document.getElementById('fi-gpt')?.remove(); // não confundir com o botão de uma ficha anterior
    maior.querySelector('.pl-ficha').click();
    for (let i = 0; i < 30 && !document.getElementById('fi-gpt'); i++) await espera(100);
    document.getElementById('fi-gpt')?.click();
    for (let i = 0; i < 30 && !texto; i++) await espera(100);
  } finally {
    navigator.clipboard.writeText = original;
    if (!jaAberta) document.getElementById('ficha-fechar')?.click();
  }
  return texto;
}

// Roda na página do jogo quando a conta é escondida: quem abriu a conta e foi para a tela de combate
// sai do Modo Economia, e escondida assim o cartão fica sem números (testado). Religa o modo pelo botão
// do jogo, só se estiver na hunt e com o modo desligado.
function voltarEconomia() {
  const naHunt = /hunt-ativa/.test(document.getElementById('palco')?.className ?? '');
  if (!naHunt || localStorage.getItem('cfg-economia') === '1') return false;
  document.getElementById('hunt-eco')?.click();
  return true;
}

// Venda do Depot em duas etapas, sempre pela confirmação do próprio jogo (que já deixa a Coleção de
// fora e lista shiny/P5 que iriam junto). 1) prepararVenda: abre a aba Depot do Modo Economia, clica
// em "Vender todo o Depot" e lê a confirmação do jogo, que fica aberta; 2) concluirVenda: Sim ou Não
// nessa confirmação. A confirmação do jogo só vende até o último Pokémon que estava na tela.
async function prepararVenda() {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  if (!document.getElementById('confirmar')?.classList.contains('hidden')) return { erro: 'Há uma confirmação do jogo aberta nesta conta. Abra a conta e feche-a.' };
  const aba = document.querySelector('.eco-aba[data-eco-aba="depot"]');
  if (!aba) return { erro: 'Ligue o Modo Economia desta conta para vender pelo Multidle.' };
  if (!aba.classList.contains('on')) aba.click();
  let botao = null;
  for (let i = 0; i < 30 && !(botao = document.querySelector('#eco-cofre .mk-vender-tudo .mk-acao')); i++) await espera(100);
  if (!botao) return { erro: 'Não achei o botão "Vender todo o Depot".' };
  const info = txt(botao.closest('.mk-vender-tudo').querySelector('.mk-vt-info'));
  if (botao.disabled) return { nada: true, info };
  botao.click();
  for (let i = 0; i < 30 && document.getElementById('confirmar').classList.contains('hidden'); i++) await espera(100);
  if (document.getElementById('confirmar').classList.contains('hidden')) return { erro: 'A confirmação do jogo não abriu.' };
  const texto = document.getElementById('confirmar-texto');
  return {
    info,
    titulo: txt(document.getElementById('confirmar-titulo')),
    valiosos: [...texto.querySelectorAll('.dlg-ficha-pk')].map((f) => txt(f)),
  };
}

// Roda na página do jogo: lista o Depot (aba do Modo Economia) com os dados da ficha de cada Pokémon. O
// quadradinho do Depot só tem nome e nível; a ficha (abre e fecha, sem mudar nada) tem potência,
// qualidade, IV, nota e poder.
async function listarDepot() {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const aba = document.querySelector('.eco-aba[data-eco-aba="depot"]');
  if (!aba) return { erro: 'Ligue o Modo Economia desta conta para ver o Depot pelo Multidle.' };
  if (!aba.classList.contains('on')) aba.click();
  await espera(400);
  const ficha = document.getElementById('ficha');
  if (!ficha.classList.contains('hidden')) return { erro: 'Há uma ficha aberta nesta conta. Abra a conta e feche-a.' };
  // lê só com o Depot parado (o jogo pode estar redesenhando, ex.: logo depois de uma venda)
  const chaves = () => [...document.querySelectorAll('#eco-cofre-corpo .eco-pk')].map((pk) => pk.dataset.chave).join();
  for (let i = 0, antes = null; i < 15 && chaves() !== antes; i++) { antes = chaves(); await espera(200); }
  const lista = [];
  for (const pk of [...document.querySelectorAll('#eco-cofre-corpo .eco-pk')].slice(0, 80)) {
    const [nome, nv] = (pk.title || '').split(' · ');
    const item = { chave: pk.dataset.chave, nome: nome ?? '', nv: (nv ?? '').replace('Nv ', ''), novo: !!pk.querySelector('.eco-pk-novo') };
    pk.querySelector('.eco-pk-abrir')?.click();
    for (let i = 0; i < 20 && ficha.classList.contains('hidden'); i++) await espera(50);
    const corpo = document.getElementById('ficha-corpo');
    const selo = (classe) => txt(corpo.querySelector(`.pk-selo-${classe}`)).replace(/^\D+/, '');
    const texto = corpo.innerText.replace(/\s+/g, ' ');
    item.potencia = (texto.match(/POTÊNCIA (P\d)/i) ?? [])[1] ?? '';
    item.qualidade = selo('q');
    item.iv = selo('iv');
    // O texto da nota começa em 0,000 e anima até o valor (e com a conta escondida a animação nem
    // anda): o valor final vem pronto em data-nota
    const nota = Number(corpo.querySelector('.fi-nota-num[data-nota]')?.dataset.nota);
    item.nota = Number.isFinite(nota) ? nota.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '';
    item.faixa = txt(corpo.querySelector('.calc-nota-rotulo')).toLowerCase();
    item.shiny = /shiny|✨/i.test(txt(document.getElementById('ficha-titulo')) + txt(corpo.querySelector('.fi-nome')));
    lista.push(item);
    document.getElementById('ficha-fechar').click();
    await espera(60);
  }
  const venda = txt(document.querySelector('#eco-cofre-corpo .mk-vt-info'));
  return { lista, venda };
}

// Roda na página do jogo: "Enviar para a Coleção" do Pokémon (sai da venda ao NPC), pelo botão do jogo
function moverParaColecao(chave) {
  const botao = document.querySelector(`#eco-cofre-corpo .eco-pk[data-chave="${CSS.escape(chave)}"] .eco-pk-mover[data-para="colecao"]`);
  botao?.click();
  return !!botao;
}

// Depois do Sim, espera o jogo redesenhar o Depot com a resposta do servidor (até 5 s): ler antes
// disso pegava a lista no meio do redesenho (vazia ou ainda com os vendidos)
async function concluirVenda(vender) {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const caixa = document.getElementById('confirmar');
  if (caixa.classList.contains('hidden')) return false;
  const lista = () => [...document.querySelectorAll('#eco-cofre-corpo .eco-pk')].map((pk) => pk.dataset.chave).join();
  const antes = lista();
  document.getElementById(vender ? 'confirmar-sim' : 'confirmar-nao').click();
  if (vender) for (let i = 0; i < 50 && lista() === antes; i++) await espera(100);
  return true;
}

// Roda na página do jogo: o RESET da sessão (zera só os contadores locais: XP, lucro, abates...)
function resetarSessao() {
  const b = document.querySelector('.eco-reset');
  b?.click();
  return !!b;
}

// Roda na página do simulador: cola a ficha e simula
function preencherSimulador(ficha) {
  const campo = document.getElementById('sheet');
  campo.value = ficha;
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  campo.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('run')?.click();
}

// ---------- Sniper do Mercado ----------
// "Ouvido" na conexão do jogo, instalado ANTES do jogo carregar (o Multidle injeta no início da página).
// Guarda a conexão para enviar os mesmos pedidos que os botões do Mercado enviam, repassa as mensagens
// e guarda os eventos de compra/sorteio para o registro. Não altera nada do que o jogo envia ou recebe.
const GANCHO_CONEXAO = `(() => {
  if (window.__multidle) return;
  const Original = window.WebSocket;
  const ouvintes = new Set();
  const m = (window.__multidle = { ws: null, desvio: 0, eventos: [], ouvir: (fn) => (ouvintes.add(fn), () => ouvintes.delete(fn)) });
  function Observado(...args) {
    const ws = new Original(...args);
    if (/pokeidle/.test(String(args[0]))) {
      m.ws = ws;
      ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        // os eventos de compra/sorteio vêm dentro das mensagens de eventos do jogo (tipo no campo "k")
        const guardar = (o, fundo) => {
          if (!o || typeof o !== 'object' || fundo > 4) return;
          if (/^(marketComprado|mktSorteio)$/.test(o.k) || (o.k === 'aviso' && /^market[.]/.test(o.msg))) { m.eventos.push(o); if (m.eventos.length > 100) m.eventos.shift(); return; }
          for (const v of Object.values(o)) guardar(v, fundo + 1);
        };
        if (/"(marketComprado|mktSorteio)"|"market[.]/.test(ev.data)) guardar(msg, 0);
        // hora do servidor: desde a v1.345 do jogo vem dentro de "estado" (antes, no topo da mensagem)
        const agora = msg?.servidorAgora ?? msg?.estado?.servidorAgora;
        if (agora) m.desvio = Date.now() - agora;
        // os itens próprios do jogo (fragmentos, casas...) só vêm na mensagem de entrada, não no catálogo público
        if (Array.isArray(msg?.itensNossos)) m.itensNossos = msg.itensNossos.map((i) => [i.id, i.nome ?? i.name]);
        for (const fn of ouvintes) { try { fn(msg); } catch {} }
      });
    }
    return ws;
  }
  Observado.prototype = Original.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Observado[k] = Original[k];
  window.WebSocket = Observado;
})();`;

// Roda na página: envia um pedido de CONSULTA do Mercado e espera a resposta "market" da aba esperada
async function consultarMercado(pedido, aba) {
  const m = window.__multidle;
  if (!m?.ws || m.ws.readyState !== 1) return { erro: 'sem conexão do jogo (reinicie o Multidle para ativar o sniper nesta conta)' };
  if (pedido.t === 'market.comprar') return { erro: 'consulta não compra' };
  return new Promise((ok) => {
    const tchau = setTimeout(() => { parar(); ok({ erro: 'o servidor não respondeu' }); }, 8000);
    const parar = m.ouvir((msg) => {
      if (msg.t === 'market' && (!aba || msg.aba === aba)) { clearTimeout(tchau); parar(); ok({ linhas: msg.linhas ?? [], resumo: msg.resumo, desvio: m.desvio }); }
    });
    m.ws.send(JSON.stringify(pedido));
  });
}

// Roda na página: o pedido de compra de um anúncio (o mesmo do botão "Comprar" do jogo)
function comprarNoMercado(pedido) {
  const m = window.__multidle;
  if (!m?.ws || m.ws.readyState !== 1 || pedido.t !== 'market.comprar') return false;
  m.ws.send(JSON.stringify(pedido));
  return true;
}

// Roda na página: nome de cada item (catálogo público do jogo + itens próprios que vieram na entrada)
async function nomesDosItens() {
  const publico = await fetch('/assets/items.json').then((r) => r.json()).catch(() => ({ items: [] }));
  return [...(publico.items ?? []).map((i) => [i.id, i.name]), ...(window.__multidle?.itensNossos ?? [])];
}

// Roda na página: eventos de compra/sorteio guardados pelo ouvido desde a última leitura
function eventosDoMercado() {
  const m = window.__multidle;
  return m ? m.eventos.splice(0) : [];
}

const OURO_POR_GEMA = 3_000_000;

// Uma linha do Mercado -> anúncio no formato do sniper
const anuncioDe = (l) => ({
  id: l.id, preco: Number(l.preco) || 0, qtd: Number(l.qtd) || 1, moeda: l.moeda, vendedor: l.vendedor ?? '',
  compravelEm: Number(l.compravelEm) || 0, aberto: l.estado === 'aberto' && !l.comprador,
  nome: l.ficha?.nome ?? '', shiny: !!l.ficha?.shiny, nivel: l.ficha?.level ?? null, nota: l.ficha?.nota ?? null, potencia: l.ficha?.potencia ?? null,
});

// Um evento de compra/sorteio -> { id do anúncio, tipo, detalhe } para o registro (ou null). O sorteio chega
// em partes: "entrou" (quem está disputando), "lista" (quem entrou depois e quem levou) e "fim" (o
// resultado deste pedido); `memoria` guarda as partes de cada anúncio até o fim.
function resultadoDoMercado(e, memoria) {
  const r = (tipo, detalhe) => ({ id: e.id, tipo, detalhe, descricao: e.descricao ?? '', sorteio: !!e.sorteio });
  if (e.k === 'marketComprado') return r('comprado', e.sorteio ? '✅ Comprado no sorteio' : '✅ Comprado');
  // Avisos do Mercado (testado: é assim que o resultado do sorteio chega). Não dizem o anúncio: quem chama
  // liga o aviso à tentativa enviada mais antiga da conta.
  if (e.k === 'aviso') {
    if (e.msg === 'market.sorteio' || e.msg === 'market.sorteioEspera') return r('tentando', '🎲 Entrou no sorteio');
    if (e.msg === 'market.sorteioPerdeu') return r('perdido', '❌ Outro jogador levou no sorteio (nada cobrado)');
    if (e.msg === 'market.retencao') return r('erro', '⚠ Não passou: o anúncio ainda estava em retenção');
    return /^market\./.test(e.msg) ? r('erro', `⚠ Não passou (${e.msg.slice(7)})`) : null;
  }
  if (e.k !== 'mktSorteio' || !e.id) return null;
  const s = memoria.get(e.id) ?? { quem: new Set(), levaram: [], total: 0 };
  memoria.set(e.id, s);
  for (const n of e.quem ?? []) s.quem.add(n);
  for (const c of e.levaram ?? []) if (c?.nick && !s.levaram.includes(c.nick)) s.levaram.push(c.nick);
  s.total = Math.max(s.total, Number(e.total) || 0, s.quem.size);
  if (e.fase === 'entrou') return r('tentando', `🎲 No sorteio (${s.total} na disputa)`);
  if (e.fase !== 'fim') return null;
  memoria.delete(e.id);
  if (e.ok) return r('comprado', `✅ Comprado no sorteio (${s.total} na disputa)`);
  if (e.perdeu) return r('perdido', `❌ Perdeu para ${s.levaram.join(', ') || 'outro jogador'} (${s.total} na disputa, nada cobrado)`);
  return r('erro', `⚠ Não passou: ${e.msg ?? 'sem motivo informado'}`);
}

// Alvos que o sniper sabe vigiar: um item (por id) ou "qualquer shiny"
const sniper = {
  gancho: GANCHO_CONEXAO,
  consultar: consultarMercado,
  comprar: comprarNoMercado,
  eventos: eventosDoMercado,
  resultado: resultadoDoMercado,
  // pedido de consulta do alvo + aba da resposta
  // shiny e diamante vêm da vitrine (a mesma consulta das abas do jogo); item, do painel do item
  consulta: (alvo) => (alvo.tipo === 'shiny' || alvo.tipo === 'diamante'
    ? { pedido: { t: 'market.listar', tipo: alvo.tipo === 'diamante' ? 'diamante' : 'pokemon', moeda: alvo.moeda, busca: '', ordem: 'baratos', criterios: [], elementos: [], categoria: '',
      soShiny: alvo.tipo === 'shiny', soP5: false, soMega: false, soLendario: false, soTmElemental: false, soTmAoe: false, semOutland: false, pagina: 0, especieId: 0 }, aba: null }
    : { pedido: { t: 'market.item', itemId: Number(alvo.itemId), moeda: alvo.moeda }, aba: 'item' }),
  anuncios: (linhas, alvo) => linhas.map(anuncioDe).filter((a) => (alvo.tipo === 'shiny' ? a.shiny : true)),
  nomes: nomesDosItens,
  pedidoItens: { t: 'market.itens', elementos: [], categoria: '' },
  // itens à venda agora (resumo do Mercado) com nome, para escolher um alvo novo
  catalogo: (resumo, nomes) => {
    const nome = new Map(nomes.map(([id, n]) => [Number(id), n]));
    return Object.entries(resumo ?? {}).map(([id, r]) => ({ itemId: Number(id), nome: nome.get(Number(id)) ?? `Item ${id}`, minOrb: r.minOrb ?? null, minGold: r.minGold ?? null }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  },
  pedidoCompra: (a, qtd) => ({ t: 'market.comprar', id: a.id, qtd, preco: a.preco, moeda: a.moeda }),
  // Ouro vale por Gemas nesta taxa: preço máximo em ouro, saldo mínimo e teto do dia em ouro saem daqui
  ouroPorGema: OURO_POR_GEMA,
  // padrão: os alvos do usuário (preço máx. em Gemas; em ouro = × OURO_POR_GEMA), todos começando desligados
  alvosPadrao: [
    ['boss', 70000, 'Boss Token', 3, 50],
    ['aoe', 40530, 'Fragmento de AoE TM', 300, 1],
    ['zmove', 59194, 'Fragmento de Z-Move', 220, 1],
    ['bike', 70013, 'Fragmento de Bicicleta', 100, 2],
    ['casa', 70011, 'Fragmento de Chave (Casa)', 180, 1],
    ['mega', 70014, 'Fragmento de Mega Stone', 40, 3],
    ['shinystone', 70012, 'Fragmento de Shiny Stone', 80, 2],
    ['shiny', null, 'Qualquer shiny', 100, 2],
    // shiny só se vende por Gemas no Mercado
  ].flatMap(([id, itemId, nome, precoMax, maxDia]) => (itemId ? ['orb', 'gold'] : ['orb']).map((moeda) => ({
    id: `${id}-${moeda}`, tipo: itemId ? 'item' : 'shiny', ...(itemId && { itemId }), nome, moeda,
    precoMax: moeda === 'gold' ? precoMax * OURO_POR_GEMA : precoMax, maxDia, ativo: false,
  }))),
  moedas: { orb: 'Gemas', gold: 'Ouro' },
};

const doJogo = (url) => /^https:\/\/pokeidle\.io\//.test(url); // ícones só do próprio jogo
const sinal = (v) => (/^[-−]/.test(String(v)) ? 'neg' : 'pos'); // o jogo usa "−" (sinal de menos) e "-"

// Hunt e tempo só existem como texto: hunt é "Nome · nível N", tempo é a linha antes de "caçando"
function parse(texto) {
  const l = texto.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    hunt: l.find((s) => / · nível \d+/.test(s)) ?? '',
    tempo: l[l.indexOf('caçando') - 1] ?? '',
  };
}

// Estado da caça do jogo -> só dois selos no cartão: "Caçando" ou "Parado" (sem batalha, fora da hunt,
// Centro Pokémon ou sem conexão; o motivo do jogo fica na dica do selo)

// "8.318 / 13.344" -> 62 (% de vida)
function porcentagem(hpTxt) {
  const [atual, max] = hpTxt.split('/').map((s) => Number(s.replace(/\D/g, '')));
  return max > 0 ? Math.round((atual / max) * 100) : null;
}

// Dados da página -> cartão genérico do painel
function montar({ texto = '', nick = '', kpis = {}, time = [], mochila = [], moedas = {}, achados = [], lugar = '', hunt = null, caca = null, tempo: relogio = '', hpTxt = '', twitch = null, bonus = [], kick = null, agora = Date.now() } = {}) {
  const { hunt: nomeHunt, tempo: tempoTexto } = parse(texto);
  const tempo = relogio || tempoTexto;
  const hp = hpTxt ? porcentagem(hpTxt) : null;
  const cacando = caca?.id === 'cacando';
  const kpi = (rot, d, cor = '') => d && { rot, v: d.v, h: d.h, sub: d.sub, cor };
  const equipe = time.filter((p) => p.nome).sort((a, b) => b.poder - a.poder);
  const itens = mochila.filter((i) => i.q > 0 && doJogo(i.ico));
  return {
    nome: nick,
    subtitulo: nomeHunt,
    tempo,
    // Selo do estado e a vida do Pokémon em campo
    estado: caca ? { texto: cacando ? 'Caçando' : 'Parado', nivel: cacando ? 'ok' : 'alerta', dica: caca.texto, extra: hp != null ? `HP ${hp}%` : '' } : null,
    alerta: !!caca && !cacando,
    selos: [
      // ativo, a Twitch vai para a linha de bônus; aqui só o alerta de vinculada e não detectada
      ...(twitch?.vinculada && !twitch.ativo ? [{ rot: 'Twitch', v: 'não detectado', cor: 'neg' }] : []),
      ...[['Ouro', moedas.ouro, 'ouro'], ['Diamantes', moedas.diamantes, 'diam'], ['Gemas', moedas.gemas, 'gema']]
        .filter(([, v]) => v).map(([rot, v, cor]) => ({ rot, v, cor })),
    ],
    twitchVinculada: !!twitch?.vinculada, // conta de onde o Multidle lê as lives oficiais
    // Linha "Bônus ativos": o que o painel do treinador mostra valendo, mais Twitch e Kick quando ativos
    bonus: [
      ...bonus.map((b) => ({ rot: b.nome, v: [b.valor, b.tempo].filter(Boolean).join(' · ') })),
      ...(twitch?.ativo ? [{ rot: 'Twitch', v: twitch.valor }] : []),
      ...(kick && kick.fim > agora ? [{ rot: 'Kick', v: `${kick.lista || 'bônus ativo'} · ${duracao(kick.fim - agora)}` }] : []),
    ],
    kpis: [kpi('XP treinador', kpis.xpTreinador), kpi('Lucro líquido', kpis.lucro, kpis.lucro ? sinal(kpis.lucro.v) : ''),
      kpi('Abates', kpis.abates), kpi('Capturas', kpis.capturas)].filter(Boolean),
    blocos: [
      { titulo: 'Mochila', vazio: 'Sem bolas, poções ou revives',
        itens: itens.map((i) => ({ ico: i.ico, n: i.q, nome: i.nome + (i.usando ? ' · em uso automático' : ''), destaque: i.usando })) },
      // Todos os achados possíveis no lugar da hunt; os que ainda não caíram ficam apagados
      { titulo: lugar ? `Achados · ${lugar}` : 'Achados', etiqueta: { rot: 'Ouro', n: hunt?.gold ?? 0 },
        itens: achados.filter((a) => a.shiny != null || doJogo(a.ico)).map((a) => {
          const n = Number(hunt?.[a.campo]) || 0;
          return a.shiny != null
            ? { rot: `✨ ${a.shiny}`, n, nome: a.nome, apagado: !n, destaque: n > 0 }
            : { ico: a.ico, n, nome: a.nome, apagado: !n };
        }) },
      { titulo: 'Equipe', largo: true, vazio: 'Equipe não encontrada',
        linhas: equipe.map((p, i) => ({ esq: p.nome, meio: `Nv${p.nv}`, dir: `poder ${p.poder.toLocaleString('pt-BR')}`, destaque: i === 0 })) },
    ],
    // Os números da sessão só existem no Modo Economia do jogo (configuração salva em cada janela)
    dicaSemKpis: 'Ligue o Modo Economia no jogo (abra esta conta aqui no Multidle) para ver XP, lucro, abates e capturas.',
    pronto: !!nick && !/^[—–-]$/.test(nick), // logado e com a tela carregada (deslogado, o jogo mostra "—")
    ferramenta: equipe.length > 0, // dá para simular
  };
}

module.exports = {
  id: 'pokeidle',
  nome: 'PokeIdle',
  url: 'https://pokeidle.io/app',
  // Domínios que ficam na janela da conta (o resto abre à parte); login do Google vai para o Chrome
  hostsDaConta: /(^|\.)(pokeidle\.io|discord\.com)$/,
  hostsLoginExterno: /(^|\.)google\.com$/,
  // Termos do jogo (versão 2026-10-12): mais de 4 contas por pessoa/aparelho = banimento de TODAS
  maxContas: 4,
  avisoLimite: 'Limite de 4 contas por pessoa (regras do PokeIdle: mais que isso bane todas)',
  // Login: a sessão do jogo fica no localStorage ("sessao") + cookies do domínio
  origem: 'https://pokeidle.io',
  logado: (storage) => !!storage.sessao,
  // Extensões do Chrome/Edge que o Multidle carrega nas contas, se o usuário tiver instalado no navegador
  // (id da Chrome Web Store). "/hunt" mostra onde caçar acima do Pokémon em campo.
  extensoes: [{ id: 'mhnplloljgchpfpcpbhmcokmnefodjnh', nome: '/hunt for PokeIdle' }],
  // Autores das ferramentas que o Multidle usa neste jogo (aparecem em "Apoiar")
  apoioTerceiros: [
    { nome: 'Simulador de hunt (Lotuzx)', url: 'https://pokedex.lotuz.tech/hunt-sim', obs: 'o simulador do botão Simular' },
    { nome: 'Extensão /hunt (Liang)', url: 'https://livepix.gg/crispim', obs: 'doação para o autor da extensão' },
  ],
  // Lives da Twitch com bônus: de onde vem a lista (a tela da Twitch do jogo) e o endereço de cada canal
  // padrão 4 lives abertas; o usuário escolhe até o limite (cada live ~250 MB de RAM e ~1,3% de CPU)
  // urlChat: só o chat do canal (a página "chat em janela separada" da Twitch), bem mais leve; o jogo
  // detecta pela presença no chat
  live: {
    lerCanais: livesOficiais, padrao: 4, limite: 12,
    url: (login) => `https://www.twitch.tv/${login}`,
    urlChat: (login) => `https://www.twitch.tv/popout/${login}/chat?popout=`,
  },
  // Ao esconder a conta no Multidle
  aoEsconder: voltarEconomia,
  // Sniper do Mercado (ver "Sniper do Mercado" acima); gemas/ouro de cada conta vêm do cartão
  sniper,
  // Vender o Depot pelo cartão (duas etapas, ver prepararVenda)
  venda: { rotulo: 'Vender Depot', dica: 'Vende o Depot pela confirmação do próprio jogo (a Coleção fica de fora)', preparar: prepararVenda, concluir: concluirVenda },
  // Lista do Depot com os dados da ficha, e "Enviar para a Coleção" (tira da venda)
  depot: { listar: listarDepot, guardar: moverParaColecao },
  // Botões no cartão que acionam o próprio jogo (funcionam com a conta escondida)
  acoes: [{ id: 'reset', rotulo: 'Reset', dica: 'Zera a sessão desta conta (XP, lucro, abates...), como o RESET do jogo',
    confirmar: 'Zerar a sessão desta conta? XP, lucro, abates, capturas e achados da sessão voltam a 0 (a conta e os itens não mudam).',
    rodar: resetarSessao }],
  ferramenta: { rotulo: 'Simular', titulo: 'Simulador de hunt (pokedex.lotuz.tech)', url: 'https://pokedex.lotuz.tech/hunt-sim',
    dica: 'Simular a melhor hunt para o Pokémon mais forte', preparar: copiarFicha, aplicar: preencherSimulador },
  extrair,
  montar,
};

if (require.main === module) {
  const assert = require('node:assert');
  const mem = new Map();
  assert.strictEqual(resultadoDoMercado({ k: 'mktSorteio', id: 7, fase: 'entrou', quem: ['A', 'B'], total: 2 }, mem).detalhe, '🎲 No sorteio (2 na disputa)');
  assert.strictEqual(resultadoDoMercado({ k: 'mktSorteio', id: 7, fase: 'lista', quem: ['C'], levaram: [{ nick: 'C' }] }, mem), null);
  assert.deepStrictEqual(resultadoDoMercado({ k: 'mktSorteio', id: 7, fase: 'fim', perdeu: true }, mem),
    { id: 7, tipo: 'perdido', detalhe: '❌ Perdeu para C (3 na disputa, nada cobrado)', descricao: '', sorteio: false });
  assert.strictEqual(mem.size, 0);
  assert.strictEqual(resultadoDoMercado({ k: 'mktSorteio', id: 8, fase: 'fim', ok: true }, mem).tipo, 'comprado');
  assert.strictEqual(sniper.consulta({ tipo: 'diamante', moeda: 'orb' }).pedido.tipo, 'diamante');
  assert.strictEqual(sniper.consulta({ tipo: 'diamante', moeda: 'orb' }).pedido.soShiny, false);
  // formato real (capturado em 20/10/2026): aviso sem o id do anúncio
  assert.strictEqual(resultadoDoMercado({ k: 'aviso', msg: 'market.sorteio' }, mem).tipo, 'tentando');
  assert.deepStrictEqual(resultadoDoMercado({ k: 'aviso', msg: 'market.sorteioPerdeu' }, mem),
    { id: undefined, tipo: 'perdido', detalhe: '❌ Outro jogador levou no sorteio (nada cobrado)', descricao: '', sorteio: false });
  assert.strictEqual(resultadoDoMercado({ k: 'aviso', msg: 'hunt.qualquer' }, mem), null);
  assert.strictEqual(resultadoDoMercado({ k: 'marketComprado', id: 9, sorteio: true, descricao: '1× Bronze Boss Token' }, mem).detalhe, '✅ Comprado no sorteio');
  assert.deepStrictEqual(sniper.catalogo({ 70013: { minOrb: 136 }, 999: { minGold: 5 } }, [[70013, 'Bicycle Fragment']]),
    [{ itemId: 70013, nome: 'Bicycle Fragment', minOrb: 136, minGold: null }, { itemId: 999, nome: 'Item 999', minOrb: null, minGold: 5 }]);
  const c = montar({
    texto: 'MODO ECONOMIA\nAncient Pupitar · nível 150\nSESSÃO\n14:37\ncaçando\nXP TREINADOR',
    nick: 'Timoteo',
    kpis: { lucro: { v: '−9.322', h: '−38.256/h', sub: '' }, abates: { v: '142', h: '583/h', sub: 'um a cada 6s' } },
    time: [{ nome: 'Charizard', nv: '88', poder: 340 }, { nome: 'Golem', nv: '717', poder: 2312 }, { nome: '', nv: '', poder: 0 }],
    mochila: [
      { nome: 'Ultra Ball', q: 51356, ico: 'https://pokeidle.io/assets/site/assets/ui/ball-ultra.png', usando: true },
      { nome: 'Poke Ball', q: 0, ico: 'https://pokeidle.io/assets/site/assets/ui/ball-poke.png', usando: true },
      { nome: 'Estranho', q: 5, ico: 'https://outro.site/x.png', usando: false },
    ],
    moedas: { ouro: '207.596.603', diamantes: '5', gemas: '' },
    achados: [
      { campo: 'shiniesVistos', nome: 'Shinies vistos', ico: '', shiny: 'vistos' },
      { campo: 'shinies', nome: 'Shinies capturados', ico: '', shiny: 'pegos' },
      { campo: 'bossTokens', nome: 'Boss Tokens', ico: 'https://pokeidle.io/assets/site/assets/items/bronze_boss_token.png' },
      { campo: 'fragShiny', nome: 'Fragmento de Shiny Stone', ico: 'https://pokeidle.io/img/itens/shiny-stone.png' },
    ],
    lugar: 'Outland',
    hunt: { gold: 2823982, fragShiny: 2, shiniesVistos: 1 },
  });
  assert.strictEqual(c.nome, 'Timoteo');
  assert.strictEqual(c.subtitulo, 'Ancient Pupitar · nível 150');
  assert.strictEqual(c.tempo, '14:37');
  assert.deepStrictEqual(c.selos.map((s) => s.rot), ['Ouro', 'Diamantes']);
  assert.deepStrictEqual(c.kpis.map((k) => [k.rot, k.cor]), [['Lucro líquido', 'neg'], ['Abates', '']]);
  const [mochilaB, achadosB, equipeB] = c.blocos;
  assert.deepStrictEqual(mochilaB.itens.map((i) => i.n), [51356]);
  assert.strictEqual(achadosB.titulo, 'Achados · Outland');
  assert.strictEqual(achadosB.etiqueta.n, 2823982);
  assert.deepStrictEqual(achadosB.itens.map((i) => [i.rot ?? '', i.n, i.apagado]),
    [['✨ vistos', 1, false], ['✨ pegos', 0, true], ['', 0, true], ['', 2, false]]); // shiny entra mesmo sem imagem
  assert.deepStrictEqual(equipeB.linhas.map((l) => [l.esq, l.destaque]), [['Golem', true], ['Charizard', false]]);
  assert.strictEqual(montar().pronto, false);
  assert.strictEqual(montar({ nick: '—' }).pronto, false);
  const parado = montar({ nick: 'X', caca: { id: 'parado', texto: 'parado há 2m' }, tempo: '1:02:03', hpTxt: '8.318 / 13.344', texto: '' });
  assert.deepStrictEqual(parado.estado, { texto: 'Parado', nivel: 'alerta', dica: 'parado há 2m', extra: 'HP 62%' });
  assert.strictEqual(parado.alerta, true);
  assert.strictEqual(parado.tempo, '1:02:03');
  assert.strictEqual(montar({ nick: 'X', caca: { id: 'fora', texto: 'no Centro Pokémon' } }).estado.texto, 'Parado');
  const cacandoSemEco = montar({ nick: 'X', caca: { id: 'cacando', texto: 'na hunt (sem Modo Economia)' } });
  assert.strictEqual(cacandoSemEco.estado.texto, 'Caçando');
  assert.strictEqual(cacandoSemEco.alerta, false);
  assert.strictEqual(montar({ nick: 'X' }).estado, null); // fora do modo economia: sem selo
  const tw = (t) => montar({ nick: 'X', twitch: t }).selos.find((s) => s.rot === 'Twitch');
  assert.strictEqual(tw({ vinculada: true, ativo: true, valor: '+22,5% XP' }), undefined); // ativo: vai para a linha de bônus
  assert.deepStrictEqual(tw({ vinculada: true, ativo: false, valor: 'assista' }), { rot: 'Twitch', v: 'não detectado', cor: 'neg' });
  assert.strictEqual(tw({ vinculada: false, ativo: false, valor: '+15% XP' }), undefined);
  const b = montar({ nick: 'X', agora: 0, bonus: [{ nome: '+50% XP', valor: '', tempo: '20 dias' }, { nome: 'Boost Guild', valor: '+10% XP', tempo: '10d' }],
    twitch: { vinculada: true, ativo: true, valor: '+20% XP' }, kick: { fim: 80 * 60000, lista: 'XP +15%' } }).bonus;
  assert.deepStrictEqual(b.map((x) => `${x.rot}: ${x.v}`), ['+50% XP: 20 dias', 'Boost Guild: +10% XP · 10d', 'Twitch: +20% XP', 'Kick: XP +15% · 1h 20m']);
  assert.strictEqual(montar({ nick: 'X', agora: 100, kick: { fim: 50, lista: 'XP' } }).bonus.length, 0); // Kick vencido não aparece
  // Sniper: linhas reais do Mercado (formato da sondagem) -> anúncios
  const linhaItem = { id: 310967, vendedor: 'LauraBpi', qtd: 5, preco: 5, moeda: 'orb', estado: 'aberto', compravelEm: 1792540431323, comprador: null, ficha: { nome: 'Bronze Boss Token' } };
  const linhaShiny = { id: 284009, vendedor: 'cacetinho', qtd: 1, preco: 380, moeda: 'orb', estado: 'aberto', compravelEm: 1, comprador: null, ficha: { nome: 'Shedinja', shiny: true, level: 100, nota: 4.41, potencia: 1 } };
  assert.deepStrictEqual(sniper.anuncios([linhaItem], { tipo: 'item' })[0], { id: 310967, preco: 5, qtd: 5, moeda: 'orb', vendedor: 'LauraBpi', compravelEm: 1792540431323, aberto: true, nome: 'Bronze Boss Token', shiny: false, nivel: null, nota: null, potencia: null });
  assert.strictEqual(sniper.anuncios([linhaItem, linhaShiny], { tipo: 'shiny' }).length, 1); // só shiny
  assert.strictEqual(sniper.anuncios([{ ...linhaItem, comprador: 'X' }], { tipo: 'item' })[0].aberto, false);
  assert.deepStrictEqual(sniper.pedidoCompra({ id: 1, preco: 3, moeda: 'orb' }, 2), { t: 'market.comprar', id: 1, qtd: 2, preco: 3, moeda: 'orb' });
  assert.strictEqual(sniper.consulta({ tipo: 'item', itemId: '70000', moeda: 'orb' }).pedido.itemId, 70000);
  console.log('ok');
}
