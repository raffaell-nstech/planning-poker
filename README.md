# Planning Poker

Planning poker em tempo real para o time, feito com **Node.js + Express + Socket.IO**.
Todo o estado (salas, jogadores, votos, issues) fica **em memória**: não há banco de dados.

## Funcionalidades

- Criar sala e compartilhar o link (ou o código de 6 letras)
- Baralhos: Fibonacci, Fibonacci modificado, T-shirt, Potências de 2
- Votos escondidos até alguém clicar em **Revelar cartas**
- Resultado com média (ou carta mais votada no T-shirt), distribuição dos votos e aviso de consenso
- **Nova votação** zera a rodada
- Lista de issues: adicionar, **Votar esta**, estimativa gravada automaticamente ao revelar (carta mais próxima da média) e editável
- Modo espectador (assiste sem votar)
- Opção de só o facilitador (quem criou a sala) revelar e controlar a rodada. Se o facilitador cair, o controle fica liberado para todos
- F5 ou queda de rede não perde o voto: o jogador volta para a mesma cadeira

## Rodando localmente

Requer Node.js 18 ou superior.

```bash
npm install
npm start
```

Abra http://localhost:3000. Para o time acessar pela rede, use `http://SEU_IP:3000`.

Ou com Docker:

```bash
docker build -t planning-poker .
docker run --rm -p 3000:3000 planning-poker
```

## Configuração

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `ROOM_TTL_MINUTES` | `60` | Sala sem ninguém conectado é apagada depois desse tempo |
| `PLAYER_GRACE_SECONDS` | `30` | Jogador desconectado sai da mesa depois desse tempo |

## Quando os dados somem

O estado vive só enquanto o processo estiver rodando. Ele é apagado quando:

- o servidor reinicia, cai ou recebe um deploy novo;
- a hospedagem "dorme" por inatividade (ex.: Render free, depois de ~15 min sem acesso);
- a sala fica vazia por mais de `ROOM_TTL_MINUTES`.

## Deploy gratuito no Render

1. Suba este repositório no GitHub.
2. No [Render](https://render.com), crie um **Web Service** apontando para o repositório.
3. Configure:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Cada push na branch principal faz um deploy novo.

No plano free o serviço dorme sem uso; o primeiro acesso depois disso leva de 30 a 60 segundos e começa com a memória vazia.

## Deploy em container (cluster da empresa, etc.)

Use o `Dockerfile` do projeto. O app escuta na porta definida em `PORT` e expõe `GET /health` para health check.

**Importante:** rode com **uma única réplica**. Como o estado fica em memória, duas réplicas teriam salas diferentes.
