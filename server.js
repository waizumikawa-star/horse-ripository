const SUITS = ["spade", "heart", "diamond", "club"];
const SHUFFLE_TEXT = {
  1: "左の人と手札を全交換",
  2: "右の人と手札を全交換",
  3: "右から2番目の人と手札を全交換",
  4: "全員で時計回りに手札を全交換",
  5: "全員で反時計回りに手札を全交換",
  6: "ドクロ。何も起きない"
};

export default class Server {
  constructor(party) {
    this.party = party;
    this.state = null;
    this.connectionPlayers = new Map();
    this.npcTimer = null;
  }

  async onStart() {
    this.state = await this.party.storage.get("state");
  }

  onConnect(connection) {
    if (this.state) this.sendState(connection);
  }

  async onClose(connection) {
    const playerId = this.connectionPlayers.get(connection.id);
    this.connectionPlayers.delete(connection.id);
    if (!this.state || !playerId) return;
    const player = this.state.players.find((item) => item.id === playerId);
    if (player && this.state.status === "playing") {
      player.isNPC = true;
      player.connected = false;
      player.name = `${player.name} (NPC)`;
      this.state.lastAction = {
        title: "切断",
        text: `${player.name} をNPCに置き換えました。`,
        detail: "ゲームは続行されます。"
      };
      await this.persistAndBroadcast();
    }
  }

  async onMessage(message, connection) {
    const data = JSON.parse(message);
    if (data.playerId) this.connectionPlayers.set(connection.id, data.playerId);

    if (data.type === "hello") {
      if (this.state) this.sendState(connection);
      return;
    }

    if (data.type === "create") {
      this.state = createWaitingState(this.party.id, data.playerId, data.name, Number(data.playerCount), Number(data.npcLevel));
      await this.persistAndBroadcast();
      return;
    }

    if (!this.state) return;

    if (data.type === "join" && this.state.status === "waiting") joinGame(this.state, data.playerId, data.name);
    if (data.type === "start" && this.state.hostId === data.playerId && this.state.status === "waiting") startGame(this.state);
    if (data.type === "draw") drawCard(this.state, data.playerId, data.index);
    if (data.type === "shuffle") runShuffleTime(this.state, data.playerId);
    if (data.type === "reorder") reorderHand(this.state, data.playerId, data.handIds);
    if (data.type === "rematch" && this.state.hostId === data.playerId) rematch(this.state);

    await this.persistAndBroadcast();
  }

  async persistAndBroadcast() {
    await this.party.storage.put("state", this.state);
    this.broadcastState();
    this.scheduleNpc();
  }

  broadcastState() {
    if (typeof this.party.getConnections === "function") {
      for (const connection of this.party.getConnections()) this.sendState(connection);
      return;
    }
    this.party.broadcast(JSON.stringify({ type: "state", state: redactState(this.state, "") }));
  }

  sendState(connection) {
    const playerId = this.connectionPlayers.get(connection.id) || "";
    connection.send(JSON.stringify({ type: "state", state: redactState(this.state, playerId) }));
  }

  scheduleNpc() {
    clearTimeout(this.npcTimer);
    const turn = currentPlayer(this.state);
    if (!turn?.isNPC || this.state.status !== "playing") return;
    this.npcTimer = setTimeout(async () => {
      const npc = currentPlayer(this.state);
      if (!npc?.isNPC || this.state.status !== "playing") return;
      if (npcShouldShuffle(npc, this.state)) runShuffleTime(this.state, npc.id);
      if (this.state.status === "playing" && currentPlayer(this.state)?.id === npc.id) {
        const target = drawTargetFor(npc, this.state);
        drawCard(this.state, npc.id, npcPickIndex(npc, target, this.state.npcLevel));
      }
      await this.persistAndBroadcast();
    }, 700 + Math.random() * 1000);
  }
}

function createWaitingState(roomId, hostId, name, playerCount, npcLevel) {
  return {
    roomId,
    status: "waiting",
    hostId,
    playerCount: playerCount === 5 ? 5 : 4,
    npcLevel: [1, 2, 3].includes(npcLevel) ? npcLevel : 2,
    players: [newPlayer(hostId, name || "ゲスト", false, 0)],
    currentTurnIndex: 0,
    turnPhase: "draw",
    finishCounter: 0,
    lastAction: { title: "待機中", text: "ルームを作成しました。", detail: "URLを共有して参加できます。" }
  };
}

function newPlayer(id, name, isNPC, seatIndex) {
  return {
    id,
    name,
    isNPC,
    connected: true,
    hand: [],
    hasShuffleUsed: false,
    isFinished: false,
    finishOrder: null,
    seatIndex,
    memory: []
  };
}

function joinGame(game, playerId, name) {
  if (game.players.some((player) => player.id === playerId)) return;
  if (game.players.filter((player) => !player.isNPC).length >= game.playerCount) return;
  game.players.push(newPlayer(playerId, name || "ゲスト", false, game.players.length));
  game.lastAction = { title: "参加", text: `${name || "ゲスト"} が参加しました。`, detail: "ホストが開始できます。" };
}

function startGame(game) {
  while (game.players.length < game.playerCount) {
    game.players.push(newPlayer(randomId("npc"), `NPC ${game.players.length + 1}`, true, game.players.length));
  }
  game.players.forEach((player, index) => {
    player.seatIndex = index;
    player.hand = [];
    player.hasShuffleUsed = false;
    player.isFinished = false;
    player.finishOrder = null;
    player.memory = [];
  });
  const deck = shuffle(createDeck());
  deck.forEach((card, index) => game.players[index % game.players.length].hand.push(card));
  game.players.forEach((player) => {
    arrangeNpcJoker(player, game.npcLevel);
    discardPairs(player);
  });
  const maxCards = Math.max(...game.players.map((player) => player.hand.length));
  const maxPlayer = game.players.find((player) => player.hand.length === maxCards);
  game.currentTurnIndex = nextSeat(maxPlayer.seatIndex, game, 1);
  game.status = "playing";
  game.finishCounter = 0;
  game.lastAction = {
    title: "ゲーム開始",
    text: `${game.players.find((player) => player.seatIndex === game.currentTurnIndex).name} から開始`,
    detail: "初期ペアを捨てました。"
  };
  checkFinished(game);
  if (game.status === "playing" && playerBySeat(game.currentTurnIndex, game)?.isFinished) {
    game.currentTurnIndex = nextSeat(game.currentTurnIndex, game, -1);
  }
}

function drawCard(game, playerId, index) {
  const player = game.players.find((item) => item.id === playerId);
  if (!player || player.isFinished || player.seatIndex !== game.currentTurnIndex) return;
  const target = drawTargetFor(player, game);
  if (!target || !target.hand.length) return;
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, target.hand.length - 1));
  const [card] = target.hand.splice(safeIndex, 1);
  player.hand.push(card);
  player.memory.push({ from: target.id, rank: card.rank });
  const discardCount = discardPairs(player);
  arrangeNpcJoker(player, game.npcLevel);
  game.lastAction = {
    title: `${player.name} がカードを引いた`,
    text: `${target.name} から1枚引きました。`,
    detail: discardCount ? `${discardCount / 2} 組のペアを捨てました。` : "ペアはできませんでした。"
  };
  checkFinished(game);
  if (game.status === "playing") game.currentTurnIndex = nextSeat(game.currentTurnIndex, game, -1);
}

function runShuffleTime(game, playerId) {
  const player = game.players.find((item) => item.id === playerId);
  if (!canShuffleFor(player, game)) return;
  player.hasShuffleUsed = true;
  const roll = Math.floor(Math.random() * 6) + 1;
  const active = activePlayers(game);
  let success = true;
  if (roll === 1) swapHands(player, playerBySeat(nextSeat(player.seatIndex, game, 1), game));
  if (roll === 2) swapHands(player, playerBySeat(nextSeat(player.seatIndex, game, -1), game));
  if (roll === 3) {
    if (active.length < 4) success = false;
    else swapHands(player, playerBySeat(nextSeat(player.seatIndex, game, -2), game));
  }
  if (roll === 4) rotateHands(game, 1);
  if (roll === 5) rotateHands(game, -1);
  if (roll === 6) success = false;
  game.players.forEach((item) => {
    if (!item.isFinished) discardPairs(item);
    arrangeNpcJoker(item, game.npcLevel);
  });
  game.lastAction = {
    title: `出目: ${roll}`,
    text: SHUFFLE_TEXT[roll],
    detail: success ? "シャッフルタイムが成立しました。" : "対象不在またはドクロのため、何も起きませんでした。"
  };
  checkFinished(game);
  if (game.status === "playing" && player.isFinished) {
    game.currentTurnIndex = nextSeat(game.currentTurnIndex, game, -1);
  }
}

function discardPairs(player) {
  const buckets = new Map();
  player.hand.forEach((card) => {
    if (card.rank === null) return;
    if (!buckets.has(card.rank)) buckets.set(card.rank, []);
    buckets.get(card.rank).push(card);
  });
  const discardIds = new Set();
  buckets.forEach((cards, rank) => {
    const pairCount = Math.floor(cards.length / 2) * 2;
    cards.slice(0, pairCount).forEach((card) => discardIds.add(card.id));
    if (pairCount) player.memory.push({ discarded: rank });
  });
  player.hand = player.hand.filter((card) => !discardIds.has(card.id));
  return discardIds.size;
}

function checkFinished(game) {
  game.players.forEach((player) => {
    if (!player.isFinished && player.hand.length === 0) {
      game.finishCounter += 1;
      player.isFinished = true;
      player.finishOrder = game.finishCounter;
    }
  });
  const active = activePlayers(game);
  if (active.length <= 1 && game.status === "playing") {
    game.status = "finished";
    game.loser = active[0] || null;
    game.lastAction = {
      title: "ゲーム終了",
      text: `${active[0]?.name || "不明"} が最弱王です。`,
      detail: "最後までジョーカーを持っていたプレイヤーの負けです。"
    };
  }
}

function rematch(game) {
  game.status = "waiting";
  game.players = game.players.filter((player) => !player.isNPC).map((player, index) => ({
    ...player,
    connected: true,
    hand: [],
    hasShuffleUsed: false,
    isFinished: false,
    finishOrder: null,
    seatIndex: index,
    memory: []
  }));
  game.currentTurnIndex = 0;
  game.finishCounter = 0;
  game.lastAction = { title: "再戦待機", text: "同じ人間プレイヤーで再戦できます。", detail: "開始するとNPCを補填します。" };
}

function reorderHand(game, playerId, handIds) {
  const player = game.players.find((item) => item.id === playerId);
  if (!player || !Array.isArray(handIds)) return;
  const byId = new Map(player.hand.map((card) => [card.id, card]));
  const nextHand = handIds.map((id) => byId.get(id)).filter(Boolean);
  if (nextHand.length === player.hand.length) player.hand = nextHand;
}

function activePlayers(game) {
  return game.players.filter((player) => !player.isFinished).sort((a, b) => a.seatIndex - b.seatIndex);
}

function currentPlayer(game) {
  return game.players.find((player) => player.seatIndex === game.currentTurnIndex);
}

function nextSeat(seatIndex, game, direction) {
  const seats = activePlayers(game).map((player) => player.seatIndex);
  if (!seats.length) return seatIndex;
  const currentPos = seats.indexOf(seatIndex);
  const base = currentPos >= 0 ? currentPos : 0;
  return seats[(base + direction + seats.length) % seats.length];
}

function playerBySeat(seatIndex, game) {
  return game.players.find((player) => player.seatIndex === seatIndex);
}

function drawTargetFor(player, game) {
  return playerBySeat(nextSeat(player.seatIndex, game, -1), game);
}

function canShuffleFor(player, game) {
  return player && player.hand.some((card) => card.suit === "joker") && !player.hasShuffleUsed && activePlayers(game).length >= 3;
}

function npcShouldShuffle(npc, game) {
  if (!canShuffleFor(npc, game)) return false;
  if (game.npcLevel === 1) return true;
  if (game.npcLevel === 2) return npc.hand.length % 2 === 1;
  const usedByOthers = game.players.filter((player) => player.id !== npc.id && player.hasShuffleUsed).length;
  return npc.hand.length % 2 === 1 || activePlayers(game).length >= 4 || usedByOthers >= 2;
}

function npcPickIndex(npc, target, level) {
  if (!target?.hand.length) return 0;
  if (level < 3) return Math.floor(Math.random() * target.hand.length);
  const targetIndex = target.hand.findIndex((card) => npc.hand.some((own) => own.rank !== null && own.rank === card.rank));
  return targetIndex >= 0 ? targetIndex : Math.floor(Math.random() * target.hand.length);
}

function swapHands(a, b) {
  if (!a || !b) return;
  const hand = a.hand;
  a.hand = b.hand;
  b.hand = hand;
}

function rotateHands(game, direction) {
  const active = activePlayers(game);
  const hands = active.map((player) => player.hand);
  active.forEach((player, index) => {
    const from = (index - direction + active.length) % active.length;
    player.hand = hands[from];
  });
}

function createDeck() {
  const deck = [];
  SUITS.forEach((suit) => {
    for (let rank = 1; rank <= 13; rank += 1) deck.push({ id: randomId("card"), suit, rank });
  });
  deck.push({ id: randomId("card"), suit: "joker", rank: null });
  return deck;
}

function shuffle(items) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function arrangeNpcJoker(player, level) {
  if (!player.isNPC || !player.hand.some((card) => card.suit === "joker")) return;
  const jokerIndex = player.hand.findIndex((card) => card.suit === "joker");
  const [joker] = player.hand.splice(jokerIndex, 1);
  if (level === 1) player.hand.splice(Math.floor(Math.random() * (player.hand.length + 1)), 0, joker);
  else if (level === 2) player.hand.splice(Math.floor(player.hand.length / 2), 0, joker);
  else player.hand.push(joker);
}

function redactState(game, viewerId) {
  if (!game) return null;
  return {
    ...game,
    players: game.players.map((player) => ({
      ...player,
      hand: player.id === viewerId ? player.hand : player.hand.map((_, index) => ({ id: `back_${player.id}_${index}`, suit: "back", rank: null }))
    }))
  };
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
