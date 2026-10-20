# Multidle

Várias contas de jogos idle numa janela só, com um painel que mostra o resumo de cada conta — sem precisar deixar uma pilha de abas do navegador abertas.

> Projeto **não oficial**, feito por um jogador. Não tem ligação com os jogos suportados nem com seus desenvolvedores.

Hoje suporta o **[PokeIdle](https://pokeidle.io)**. Outros jogos idle podem ser adicionados (veja [Adicionar um jogo](#adicionar-um-jogo)).

## O que faz

- **Uma janela, várias contas**, cada uma com login separado. Sem moldura do Windows, com barra própria.
- **Painel de cartões** atualizado a cada 15 s. No PokeIdle: XP, lucro, abates e capturas da hunt (com o ritmo por hora), ouro/diamantes/gemas da conta, bolas e poções restantes, achados da hunt e a equipe com o Pokémon mais forte em destaque.
- **Clique no cartão** e o jogo aparece dentro dele; `⤢` ocupa o programa todo; **Mostrar todas** / **Esconder todas**.
- **Leve:** conta escondida sai da tela e para de ser desenhada. Com 4 contas escondidas, ~1,5% de CPU e ~1,2 GB de RAM — e o jogo continua rodando.
- **Simulador de hunt** (PokeIdle): o botão **Simular** do cartão leva a ficha do Pokémon mais forte para o [simulador do Lotuz](https://pokedex.lotuz.tech/hunt-sim) e já roda a simulação.
- Links que saem do jogo (conectar Twitch/Kick) abrem numa janela à parte, com o login da mesma conta.

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
- opcionalmente `maxContas` e uma `ferramenta` (como o simulador do PokeIdle).

Depois é só registrá-lo na lista `JOGOS` em `main.js`.

## Apoie o projeto

O Multidle é gratuito e open source. Se ele te ajuda e você quiser apoiar:

- **GitHub Sponsors:** botão **Sponsor** no topo deste repositório
- **Pix:** `CHAVE-PIX-AQUI`

## Créditos

- [Simulador de hunt](https://pokedex.lotuz.tech/hunt-sim) por Lotuzx.
- PokeIdle e todas as imagens dentro do jogo pertencem aos seus donos; Pokémon é marca de Nintendo, Game Freak, Creatures e The Pokémon Company.

## Licença

[MIT](LICENSE)
