const SUITS = ["spade", "heart", "diamond", "club"];
const SHUFFLE_TEXT = {
  1: "左の人と手札を全交換",
  2: "右の人と手札を全交換",
  3: "右から2番目の人と手札を全交換",
  4: "全員で時計回りに手札を全交換",
  5: "全員で反時計回りに手札を全交換",
  6: "ドクロ。何も起きない"
};
const ACTION_HOLD_MS = 1600;

export default class Server {
  constructor(party) {
    this.party = party;
    this.state = null;
    this.connectionPlayers = new Map();
    this.npcTimer = null;
    this.resolveTimer = null;
  }

  async onStart() {
    this.state = await this.party.storage.get("state");
    ensureGameDefaults(this.state);
    this.scheduleResolution();
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
      setAction(this.state, "切断", `${player.name} をNPCに置き換えました。`, "ゲームは続行されます。", "disconnect");
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
    this.scheduleResolution();
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
    if (!turn?.isNPC || this.state.status !== "playing" || this.state.turnPhase !== "draw") return;
    this.npcTimer = setTimeout(async () => {
      const npc = currentPlayer(this.state);
      if (!npc?.isNPC || this.state.status !== "playing" || this.state.turnPhase !== "draw") return;
      if (npcShouldShuffle(npc, this.state)) {
        runShuffleTime(this.state, npc.id);
        await this.persistAndBroadcast();
        return;
      }
      if (this.state.status === "playing" && currentPlayer(this.state)?.id === npc.id) {
        const target = drawTargetFor(npc, this.state);
        drawCard(this.state, npc.id, npcPickIndex(npc, target, this.state.npcLevel));
      }
      await this.persistAndBroadcast();
    }, 700 + Math.random() * 1000);
  }

  scheduleResolution() {
    clearTimeout(this.resolveTimer);
    if (!this.state || this.state.status !== "playing" || this.state.turnPhase === "draw") return;
    const waitTime = Math.max(0, (this.state.resolveAt || Date.now()) - Date.now());
    this.resolveTimer = setTimeout(async () => {
      completeResolution(this.state);
      await this.persistAndBroadcast();
    }, waitTime);
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
    pendingTurnIndex: null,
    resolveAt: null,
    finishCounter: 0,
    actionLog: [],
    lastAction: makeAction("待機中", "ルームを作成しました。", "URLを共有して参加できます。")
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
  setAction(game, "参加", `${name || "ゲスト"} が参加しました。`, "ホストが開始できます。", "join");
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
  game.turnPhase = "draw";
  game.pendingTurnIndex = null;
  game.resolveAt = null;
  game.finishCounter = 0;
  setAction(game, "ゲーム開始", `${game.players.find((player) => player.seatIndex === game.currentTurnIndex).name} から開始`, "初期ペアを捨てました。", "start");
  checkFinished(game);
  if (game.status === "playing" && playerBySeat(game.currentTurnIndex, game)?.isFinished) {
    game.currentTurnIndex = nextSeat(game.currentTurnIndex, game, -1);
  }
}

function drawCard(game, playerId, index) {
  const player = game.players.find((item) => item.id === playerId);
  if (game.turnPhase !== "draw") return;
  if (!player || player.isFinished || player.seatIndex !== game.currentTurnIndex) return;
  const target = drawTargetFor(player, game);
  if (!target || !target.hand.length) return;
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, target.hand.length - 1));
  const [card] = target.hand.splice(safeIndex, 1);
  player.hand.push(card);
  player.memory.push({ from: target.id, rank: card.rank });
  const discardCount = discardPairs(player);
  arrangeNpcJoker(player, game.npcLevel);
  setAction(
    game,
    `${player.name} がカードを引いた`,
    `${target.name} から1枚引きました。`,
    discardCount ? `${discardCount / 2} 組のペアを捨てました。` : "ペアはできませんでした。",
    "draw"
  );
  checkFinished(game);
  if (game.status === "playing") holdForNextTurn(game, nextSeat(game.currentTurnIndex, game, -1));
}

function runShuffleTime(game, playerId) {
  const player = game.players.find((item) => item.id === playerId);
  if (game.turnPhase !== "draw") return;
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
  setAction(
    game,
    `シャッフルタイム 出目: ${roll}`,
    SHUFFLE_TEXT[roll],
    success ? "シャッフルタイムが成立しました。" : "対象不在またはドクロのため、何も起きませんでした。",
    "shuffle",
    { roll }
  );
  checkFinished(game);
  if (game.status === "playing") holdForNextTurn(game, player.isFinished ? nextSeat(game.currentTurnIndex, game, -1) : game.currentTurnIndex);
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
    setAction(game, "ゲーム終了", `${active[0]?.name || "不明"} が最弱王です。`, "最後までジョーカーを持っていたプレイヤーの負けです。", "finish");
  }
}

function holdForNextTurn(game, nextTurnIndex) {
  game.turnPhase = "resolving";
  game.pendingTurnIndex = nextTurnIndex;
  game.resolveAt = Date.now() + ACTION_HOLD_MS;
}

function completeResolution(game) {
  if (!game || game.status !== "playing" || game.turnPhase === "draw") return;
  if (typeof game.pendingTurnIndex === "number") game.currentTurnIndex = game.pendingTurnIndex;
  game.pendingTurnIndex = null;
  game.resolveAt = null;
  game.turnPhase = "draw";
  const turn = game.players.find((player) => player.seatIndex === game.currentTurnIndex);
  if (turn) setAction(game, `${turn.name} のターン`, "カードを1枚引いてください。", "ジョーカーを持っている場合は、引く前にシャッフルタイムを使えます。", "turn");
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
  game.turnPhase = "draw";
  game.pendingTurnIndex = null;
  game.resolveAt = null;
  game.finishCounter = 0;
  game.actionLog = [];
  setAction(game, "再戦待機", "同じ人間プレイヤーで再戦できます。", "開始するとNPCを補填します。", "rematch");
}

function makeAction(title, text, detail, kind = "info", extra = {}) {
  return { id: randomId("action"), title, text, detail, kind, at: Date.now(), ...extra };
}

function setAction(game, title, text, detail, kind = "info", extra = {}) {
  const action = makeAction(title, text, detail, kind, extra);
  game.lastAction = action;
  game.actionLog = [action, ...(game.actionLog || [])].slice(0, 6);
}

function ensureGameDefaults(game) {
  if (!game) return game;
  if (!game.turnPhase) game.turnPhase = "draw";
  if (!("pendingTurnIndex" in game)) game.pendingTurnIndex = null;
  if (!("resolveAt" in game)) game.resolveAt = null;
  if (!Array.isArray(game.actionLog)) game.actionLog = [];
  if (!game.lastAction) game.lastAction = makeAction("進行中", "ゲームを再開しました。", "次の操作を選んでください。");
  if (!game.lastAction.id) game.lastAction.id = randomId("action");
  if (!game.lastAction.kind) game.lastAction.kind = "info";
  return game;
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
