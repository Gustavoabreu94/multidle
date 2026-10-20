# Multidle

**Site: https://gustavoabreu94.github.io/multidle/**

Várias contas de jogos idle numa janela só, com um painel que mostra o resumo de cada conta — sem precisar deixar uma pilha de abas do navegador abertas.

> Projeto **não oficial**, feito por um jogador. Não tem ligação com os jogos suportados nem com seus desenvolvedores.

Hoje suporta o **[PokeIdle](https://pokeidle.io)**. Outros jogos idle podem ser adicionados (veja [Adicionar um jogo](#adicionar-um-jogo)).

## O que faz

- **Uma janela, várias contas**, cada uma com login separado. Sem moldura do Windows, com barra própria.
- **Painel de cartões** atualizado a cada 15 s. No PokeIdle: XP, lucro, abates e capturas da hunt (com o ritmo por hora), ouro/diamantes/gemas da conta, bolas e poções restantes, achados da hunt e a equipe com o Pokémon mais forte em destaque.
- **Clique no cartão** e o jogo aparece dentro dele; `⤢` ocupa o programa todo; **Mostrar todas** / **Esconder todas**.
- **Leve:** conta escondida sai da tela e para de ser desenhada. Com 4 contas escondidas, ~1,5% de CPU e ~1,2 GB de RAM — e o jogo continua rodando.
- **Simulador de hunt** (PokeIdle): o botão **Simular** do cartão leva a ficha do Pokémon mais forte para o [simulador do Lotuz](https://pokedex.lotuz.tech/hunt-sim) e já roda a simulação, numa janela por cima do painel.
- **Reset** no cartão zera a sessão da conta (como o RESET do jogo), mesmo com ela escondida.
- **Vender Depot** no cartão: mostra o que a confirmação do próprio jogo diz (quantos, quanto rende e se vai algum shiny/P5) e só vende se você confirmar. A Coleção fica de fora, como no jogo.
- Com o Multidle aberto, o Windows **não suspende o PC** (na bateria ele suspendia após alguns minutos e as contas paravam). A tela ainda pode apagar.
- **♥ Apoiar:** Pix (com QR Code) e GitHub Sponsors, se você quiser apoiar o projeto.
- **Atualização automática:** versões novas são baixadas em segundo plano; aparece **⬆ Atualizar** na barra de cima e um clique reinicia já atualizado (ou a atualização é instalada ao fechar o programa).
- Links que saem do jogo (conectar Twitch/Kick) abrem numa janela à parte, com o login da mesma conta.
- **Extensões do navegador** que você já usa no jogo funcionam dentro do Multidle (veja abaixo).

## Extensões

O Multidle carrega nas contas, automaticamente, extensões de jogo que **você já tenha instalado no Google Chrome ou no Microsoft Edge** — ele usa a cópia do seu navegador, não traz nenhuma junto. Sem a extensão instalada, o resto do Multidle funciona normalmente.

| Jogo | Extensão | O que faz |
|---|---|---|
| PokeIdle | [/hunt for PokeIdle](https://chromewebstore.google.com/detail/mhnplloljgchpfpcpbhmcokmnefodjnh), por Liang | Botão **/hunt** acima do Pokémon em campo, com as melhores hunts por XP/h e ouro/h |

Para usar: instale a extensão no Chrome ou no Edge e reabra o Multidle. O botão **/hunt** aparece quando a conta está **aberta na tela** (ele não é desenhado com a conta escondida).

Extensões são de terceiros: o Multidle não as revisa a cada atualização. Instale só as que você confia.

O Multidle **não joga por você** e não fala com o servidor do jogo: ele só mostra o site do jogo e lê os números que já aparecem na tela.

## Regras do PokeIdle — leia antes de usar

Dos [Termos do PokeIdle](https://pokeidle.io/terms) (versão de 12/10/2026):

- **No máximo 4 contas por pessoa.** Ter mais que isso leva ao **banimento de todas** as contas. A detecção usa a rede e o aparelho, e cada rede pode ter até 4 contas conectadas ao mesmo tempo. O Multidle não deixa adicionar a 5ª conta do PokeIdle.
- **A conta é pessoal:** emprestar, vender, comprar ou dividir conta é proibido.
- **Automações são permitidas** se seguirem as mesmas regras de quem joga na mão: sem explorar falhas, sem burlar limites do jogo e sem sobrecarregar o servidor.

As regras podem mudar: confira os termos atuais do jogo. Usar o Multidle é por sua conta e risco.

## Instalar

Baixe o instalador em **[Releases](../../releases)** e execute.

O instalador não é assinado digitalmente: na primeira vez o Windows pode mostrar "O Windows protegeu o computador" → **Mais informações** → **Executar assim mesmo**.

### Dá para confiar no instalador?

- **O código é aberto**: tudo o que o programa faz está neste repositório.
- **O instalador é compilado pelo próprio GitHub** a partir deste código (veja `.github/workflows/release.yml`), sem passar pelo computador de ninguém. Cada release tem um **atestado de origem** que prova isso: `gh attestation verify "Multidle-Setup-X.Y.Z.exe" -R Gustavoabreu94/multidle`.
- **Cada release mostra o SHA-256** do instalador. Confira o seu arquivo com `Get-FileHash ".\Multidle-Setup-X.Y.Z.exe"` no PowerShell.
- Instaladores novos e sem assinatura às vezes recebem 1 ou 2 alertas genéricos de antivírus (falso positivo comum em apps Electron). Na dúvida, compile você mesmo: `npm install` e `npm run dist`.

Requisitos: Windows 10/11 e **Google Chrome** ou **Microsoft Edge** (usados só no login).

## Login

O Google bloqueia login dentro de aplicativos como este. Por isso, **+ Nova conta** (ou **Entrar com Google**) abre o Chrome/Edge numa janela só daquela conta; depois que você entra no jogo, o Multidle copia a sessão do jogo para dentro dele e fecha o navegador. Da próxima vez o Google já lembra o login.

Seus logins ficam só no seu computador, em `%APPDATA%\multidle`. **Nunca compartilhe essa pasta.**

## Desenvolvimento

```powershell
npm install
npm start      # roda da pasta do projeto, com dados em %APPDATA%\multidle-dev
npm test       # testes da leitura do PokeIdle
npm run dist   # gera o instalador em dist\
```

### Adicionar um jogo

Cada jogo é um módulo em `jogos/` (veja `jogos/pokeidle.js`) que informa:

- `url`, `origem` e os domínios que ficam na janela da conta;
- `logado(localStorage)`: como saber que o login terminou;
- `extrair()`: roda **dentro** da página do jogo e lê o que está na tela;
- `montar(dados)`: transforma isso no cartão (formato descrito no topo do `<script>` de `painel.html`);
- opcionalmente `maxContas`, uma `ferramenta` (como o simulador do PokeIdle) e `extensoes` (ids da Chrome Web Store a carregar, se o usuário as tiver instaladas).

Depois é só registrá-lo na lista `JOGOS` em `main.js`.

## Apoie o projeto

O Multidle é gratuito e open source. Se ele te ajuda e você quiser apoiar:

- **GitHub Sponsors:** botão **Sponsor** no topo deste repositório
- **Pix:** `340355d9-a9f1-4b9c-927d-190c4cbe1a12` (chave aleatória) — o botão **♥ Apoiar** do app também mostra o QR Code

## Créditos

- [Simulador de hunt](https://pokedex.lotuz.tech/hunt-sim) por Lotuzx.
- Extensão [/hunt for PokeIdle](https://chromewebstore.google.com/detail/mhnplloljgchpfpcpbhmcokmnefodjnh) por Liang.
- PokeIdle e todas as imagens dentro do jogo pertencem aos seus donos; Pokémon é marca de Nintendo, Game Freak, Creatures e The Pokémon Company.

## Licença

[MIT](LICENSE)
