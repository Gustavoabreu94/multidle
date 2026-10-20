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
  const achados = [...document.querySelectorAll('#eco-achados .eco-slot')].filter((s) => !s.hidden)
    .map((s) => ({ campo: s.dataset.campo, nome: s.title, ico: s.querySelector('img')?.src ?? '' }));
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
  // Bônus da Twitch no painel do treinador: "tw-conectar" (não vinculada) ou "tw-ativo" (bônus valendo)
  const tw = document.querySelector('.tr-ativo.twitch');
  const twitch = tw ? { vinculada: !tw.classList.contains('tw-conectar'), ativo: tw.classList.contains('tw-ativo'), valor: txt(tw.querySelector('.tr-ativo-valor')) } : null;
  let hunt = null;
  try { hunt = JSON.parse(localStorage.getItem('sessao-hunt:' + nick.toLowerCase())); } catch {}
  return { texto: document.body ? document.body.innerText : '', nick, kpis, time, mochila, moedas, achados, lugar, hunt, caca, tempo, hpTxt: hpTxt ?? '', twitch };
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
function montar({ texto = '', nick = '', kpis = {}, time = [], mochila = [], moedas = {}, achados = [], lugar = '', hunt = null, caca = null, tempo: relogio = '', hpTxt = '', twitch = null } = {}) {
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
      ...(twitch?.vinculada ? [{ rot: 'Twitch', v: twitch.ativo ? twitch.valor : 'não detectado', cor: twitch.ativo ? 'twitch' : 'neg' }] : []),
      ...[['Ouro', moedas.ouro, 'ouro'], ['Diamantes', moedas.diamantes, 'diam'], ['Gemas', moedas.gemas, 'gema']]
        .filter(([, v]) => v).map(([rot, v, cor]) => ({ rot, v, cor })),
    ],
    twitchVinculada: !!twitch?.vinculada, // conta de onde o Multidle lê as lives oficiais
    kpis: [kpi('XP treinador', kpis.xpTreinador), kpi('Lucro líquido', kpis.lucro, kpis.lucro ? sinal(kpis.lucro.v) : ''),
      kpi('Abates', kpis.abates), kpi('Capturas', kpis.capturas)].filter(Boolean),
    blocos: [
      { titulo: 'Mochila', vazio: 'Sem bolas, poções ou revives',
        itens: itens.map((i) => ({ ico: i.ico, n: i.q, nome: i.nome + (i.usando ? ' · em uso automático' : ''), destaque: i.usando })) },
      // Todos os achados possíveis no lugar da hunt; os que ainda não caíram ficam apagados
      { titulo: lugar ? `Achados · ${lugar}` : 'Achados', etiqueta: { rot: 'Ouro', n: hunt?.gold ?? 0 },
        itens: achados.filter((a) => doJogo(a.ico)).map((a) => {
          const n = Number(hunt?.[a.campo]) || 0;
          return { ico: a.ico, n, nome: a.nome, apagado: !n };
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
  live: { lerCanais: livesOficiais, url: (login) => `https://www.twitch.tv/${login}`, padrao: 4, limite: 12 },
  // Ao esconder a conta no Multidle
  aoEsconder: voltarEconomia,
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
      { campo: 'bossTokens', nome: 'Boss Tokens', ico: 'https://pokeidle.io/assets/site/assets/items/bronze_boss_token.png' },
      { campo: 'fragShiny', nome: 'Fragmento de Shiny Stone', ico: 'https://pokeidle.io/img/itens/shiny-stone.png' },
    ],
    lugar: 'Outland',
    hunt: { gold: 2823982, fragShiny: 2 },
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
  assert.deepStrictEqual(achadosB.itens.map((i) => [i.n, i.apagado]), [[0, true], [2, false]]);
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
  assert.deepStrictEqual(tw({ vinculada: true, ativo: true, valor: '+22,5% XP' }), { rot: 'Twitch', v: '+22,5% XP', cor: 'twitch' });
  assert.deepStrictEqual(tw({ vinculada: true, ativo: false, valor: 'assista' }), { rot: 'Twitch', v: 'não detectado', cor: 'neg' });
  assert.strictEqual(tw({ vinculada: false, ativo: false, valor: '+15% XP' }), undefined);
  console.log('ok');
}
