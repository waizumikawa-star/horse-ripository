const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);
const configuredHost = params.get("host") || localStorage.getItem("baba_partykit_host") || "";
const clientId = localStorage.getItem("baba_client_id") || `player_${crypto.randomUUID()}`;
localStorage.setItem("baba_client_id", clientId);

const SUITS = ["spade", "heart", "diamond", "club"];
const SUIT_LABELS = { spade: "♠", heart: "♥", diamond: "♦", club: "♣", joker: "★" };
const RANK_LABELS = { 1: "A", 11: "J", 12: "Q", 13: "K" };
const SHUFFLE_TEXT = {
  1: "左の人と手札を全交換",
  2: "右の人と手札を全交換",
  3: "右から2番目の人と手札を全交換",
  4: "全員で時計回りに手札を全交換",
  5: "全員で反時計回りに手札を全交換",
  6: "ドクロ。何も起きない"
};

let state = null;
let socket = null;
let roomId = null;
let selectedCardId = null;
let localMode = !configuredHost;
let broadcast = null;
let npcTimer = null;
let pendingCreate = null;
let missingRoomId = "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));
const activePlayers = (game = state) => game.players.filter((player) => !player.isFinished).sort((a, b) => a.seatIndex - b.seatIndex);
const currentPlayer = () => state?.players.find((player) => player.seatIndex === state.currentTurnIndex);
const isMe = (player) => player?.id === clientId;
const rankOf = (card) => card.rank ?? "joker";
const cardLabel = (card) => card.suit === "joker" ? "JOKER" : `${RANK_LABELS[card.rank] || card.rank}${SUIT_LABELS[card.suit]}`;
const hasJoker = (player) => player.hand.some((card) => card.suit === "joker");
const canShuffle = (player) => player && hasJoker(player) && !player.hasShuffleUsed && activePlayers().length >= 3;
const roomUrl = (id) => `${location.origin}${location.pathname}#/room/${id}`;
const randomId = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function route() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("/room/")) return { name: "room", id: hash.split("/")[2] };
  if (hash === "/create") return { name: "create" };
  const path = location.pathname;
  const match = path.match(/\/room\/([^/]+)/);
  if (match) return { name: "room", id: match[1] };
  if (path.endsWith("/create")) return { name: "create" };
  return { name: "home" };
}

function shell(content) {
  const status = localMode ? "ローカル/NPCモード" : `PartyKit: ${configuredHost}`;
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">B</span><span>BABA抜き</span></div>
        <span class="status-pill">${escapeHtml(status)}</span>
      </header>
      ${content}
    </div>
  `;
}

function render() {
  const currentRoute = route();
  if (currentRoute.name === "create") {
    renderCreate();
    return;
  }
  if (currentRoute.name === "room") {
    roomId = currentRoute.id;
    if (!state || state.roomId !== roomId) {
      if (!connectRoom(roomId)) return;
      renderLoading();
      return;
    }
    if (state.status === "waiting") renderWaiting();
    if (state.status === "playing") renderGame();
    if (state.status === "finished") renderResult();
    return;
  }
  renderHome();
}

function renderHome() {
  shell(`
    <main class="screen home-grid">
      <section class="panel hero">
        <h1>シャッフルタイム付きババ抜き</h1>
        <p>4〜5人で遊ぶルーム制カードゲーム。人数が足りない場合はNPCが自動参加します。</p>
      </section>
      <section class="panel home-actions">
        <div>
          <h2>ルーム</h2>
          <p class="muted">URLを共有して参加できます。PartyKitホスト未設定時はこのブラウザ内で遊べるNPCモードになります。</p>
        </div>
        <button id="goCreate">ルーム作成</button>
        <div class="field">
          <label for="joinInput">ルームID または URL</label>
          <input id="joinInput" placeholder="abc123 または 共有URL">
        </div>
        <button class="secondary" id="joinRoom">ルーム参加</button>
        <div class="field">
          <label for="hostInput">PartyKit host</label>
          <input id="hostInput" value="${escapeHtml(configuredHost)}" placeholder="your-app.username.partykit.dev">
        </div>
        <button class="secondary" id="saveHost">hostを保存</button>
      </section>
    </main>
  `);
  document.querySelector("#goCreate").addEventListener("click", () => navigate("/create"));
  document.querySelector("#joinRoom").addEventListener("click", () => {
    const raw = document.querySelector("#joinInput").value.trim();
    const id = parseRoomId(raw);
    if (id) navigate(`/room/${id}`);
  });
  document.querySelector("#saveHost").addEventListener("click", () => {
    const host = document.querySelector("#hostInput").value.trim().replace(/^wss?:\/\//, "");
    if (host) localStorage.setItem("baba_partykit_host", host);
    else localStorage.removeItem("baba_partykit_host");
    location.reload();
  });
}

function renderCreate() {
  shell(`
    <main class="screen panel form-panel">
      <h2>ルーム作成</h2>
      <div class="field">
        <label for="playerName">プレイヤー名</label>
        <input id="playerName" maxlength="16" value="${escapeHtml(localStorage.getItem("baba_player_name") || "")}" placeholder="太郎">
      </div>
      <div class="field">
        <span class="choice-label">プレイ人数</span>
        <div class="choice-row">
          <label><input type="radio" name="playerCount" value="4" checked>4人</label>
          <label><input type="radio" name="playerCount" value="5">5人</label>
        </div>
      </div>
      <div class="field">
        <span class="choice-label">NPCの強さ</span>
        <div class="choice-row">
          <label><input type="radio" name="npcLevel" value="1">Lv1</label>
          <label><input type="radio" name="npcLevel" value="2" checked>Lv2</label>
          <label><input type="radio" name="npcLevel" value="3">Lv3</label>
        </div>
      </div>
      <div class="button-row">
        <button id="createRoom">作成</button>
        <button class="secondary" id="backHome">戻る</button>
      </div>
    </main>
  `);
  document.querySelector("#backHome").addEventListener("click", () => navigate("/"));
  document.querySelector("#createRoom").addEventListener("click", () => {
    const name = document.querySelector("#playerName").value.trim() || "ゲスト";
    localStorage.setItem("baba_player_name", name);
    const playerCount = Number(document.querySelector("input[name='playerCount']:checked").value);
    const npcLevel = Number(document.querySelector("input[name='npcLevel']:checked").value);
    const id = randomId("room");
    if (!localMode) {
      pendingCreate = { name, playerCount, npcLevel };
      state = null;
      navigate(`/room/${id}`);
      return;
    }
    state = createWaitingState(id, name, playerCount, npcLevel);
    saveLocal();
    navigate(`/room/${id}`);
  });
}

function renderLoading() {
  shell(`<main class="screen panel room-panel"><h2>接続中</h2><p class="muted">ルーム ${escapeHtml(roomId)} を読み込んでいます。</p></main>`);
}

function renderWaiting() {
  const me = state.players.find((player) => player.id === clientId);
  const missing = Math.max(0, state.playerCount - state.players.filter((player) => !player.isNPC).length);
  shell(`
    <main class="screen panel room-panel">
      <h2>待機ルーム</h2>
      <div class="field">
        <label>ルームURL</label>
        <div class="copy-row">
          <input readonly value="${escapeHtml(roomUrl(state.roomId))}">
          <button id="copyUrl" class="secondary">コピー</button>
        </div>
      </div>
      <p class="muted">あと ${missing} 人募集中。今開始すると NPC ${missing} 人で補填します。</p>
      ${me ? "" : joinFormHtml()}
      <div class="player-list">${state.players.map(playerLineHtml).join("")}</div>
      <div class="button-row">
        ${me?.id === state.hostId ? `<button id="startGame">ゲーム開始</button>` : `<span class="muted">ホストの開始待ち</span>`}
        <button id="leaveRoom" class="secondary">トップへ</button>
      </div>
    </main>
  `);
  document.querySelector("#copyUrl").addEventListener("click", () => navigator.clipboard?.writeText(roomUrl(state.roomId)));
  document.querySelector("#leaveRoom").addEventListener("click", () => navigate("/"));
  document.querySelector("#joinButton")?.addEventListener("click", () => {
    const name = document.querySelector("#joinName").value.trim() || "ゲスト";
    localStorage.setItem("baba_player_name", name);
    sendAction("join", { name });
  });
  document.querySelector("#startGame")?.addEventListener("click", () => sendAction("start"));
}

function renderGame() {
  const me = state.players.find((player) => player.id === clientId);
  const turn = currentPlayer();
  const target = turn ? drawTargetFor(turn, state) : null;
  const myTurn = isMe(turn) && !turn.isNPC;
  const opponents = state.players
    .filter((player) => player.id !== clientId)
    .sort((a, b) => a.seatIndex - b.seatIndex);
  shell(`
    <main class="screen game-layout">
      <section class="panel info-bar">
        <div>
          <h2>${escapeHtml(turn ? `${turn.name} のターン` : "進行中")}</h2>
          <div class="muted">${escapeHtml(state.lastAction?.text || "カードを引く前に、ジョーカー所持者はシャッフルタイムを使えます。")}</div>
        </div>
        <div class="button-row">
          <button id="shuffleTime" class="gold" ${myTurn && canShuffle(turn) ? "" : "disabled"}>シャッフルタイム</button>
        </div>
      </section>
      <section class="table">
        ${opponents.map((player, index) => opponentHtml(player, index, player.id === target?.id)).join("")}
        <div class="center-log">
          <strong>${escapeHtml(state.lastAction?.title || "BABA抜き")}</strong>
          <span>${escapeHtml(state.lastAction?.detail || "右隣から1枚引き、ペアは自動で捨てられます。")}</span>
        </div>
      </section>
      <section class="panel player-hand">
        ${me ? playerHandHtml(me, myTurn, target) : spectateHtml()}
      </section>
    </main>
  `);
  document.querySelector("#shuffleTime")?.addEventListener("click", () => sendAction("shuffle"));
  document.querySelectorAll("[data-card-id]").forEach((button) => {
    button.addEventListener("click", () => selectOwnCard(button.dataset.cardId));
  });
  document.querySelectorAll("[data-pick-index]").forEach((button) => {
    button.addEventListener("click", () => sendAction("draw", { index: Number(button.dataset.pickIndex) }));
  });
  scheduleNpc();
}

function renderResult() {
  const loser = state.players.find((player) => !player.isFinished) || state.loser;
  const ranking = state.players
    .slice()
    .sort((a, b) => (a.finishOrder || 999) - (b.finishOrder || 999));
  shell(`
    <main class="screen panel room-panel">
      <h2>結果発表</h2>
      <p><strong>最弱王: ${escapeHtml(loser?.name || "不明")}</strong></p>
      <div class="result-grid">${ranking.map((player) => `
        <div class="player-line">
          <span class="seat-dot">${player.finishOrder || "負"}</span>
          <span>${escapeHtml(player.name)}</span>
          <span class="muted">${player.isNPC ? "NPC" : "人間"}</span>
        </div>
      `).join("")}</div>
      <div class="button-row">
        ${state.hostId === clientId ? `<button id="rematch">もう一度遊ぶ</button>` : ""}
        <button id="home" class="secondary">トップへ</button>
      </div>
    </main>
  `);
  document.querySelector("#home").addEventListener("click", () => navigate("/"));
  document.querySelector("#rematch")?.addEventListener("click", () => sendAction("rematch"));
}

function createWaitingState(id, name, playerCount, npcLevel) {
  return {
    roomId: id,
    status: "waiting",
    hostId: clientId,
    playerCount,
    npcLevel,
    players: [{
      id: clientId,
      name,
      isNPC: false,
      connected: true,
      hand: [],
      hasShuffleUsed: false,
      isFinished: false,
      finishOrder: null,
      seatIndex: 0,
      memory: []
    }],
    currentTurnIndex: 0,
    turnPhase: "draw",
    finishCounter: 0,
    lastAction: { title: "待機中", text: "ルームを作成しました。", detail: "URLを共有して参加できます。" }
  };
}

function startGame(game) {
  while (game.players.length < game.playerCount) {
    game.players.push({
      id: randomId("npc"),
      name: `NPC ${game.players.length + 1}`,
      isNPC: true,
      connected: true,
      hand: [],
      hasShuffleUsed: false,
      isFinished: false,
      finishOrder: null,
      seatIndex: game.players.length,
      memory: []
    });
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
    discardPairs(player, game);
  });
  const maxCards = Math.max(...game.players.map((player) => player.hand.length));
  const maxPlayer = game.players.find((player) => player.hand.length === maxCards);
  game.currentTurnIndex = nextSeat(maxPlayer.seatIndex, game, 1);
  game.status = "playing";
  game.finishCounter = 0;
  game.lastAction = {
    title: "ゲーム開始",
    text: `${game.players.find((p) => p.seatIndex === game.currentTurnIndex).name} から開始`,
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
  if (!target || target.hand.length === 0) return;
  const safeIndex = Math.max(0, Math.min(index, target.hand.length - 1));
  const [card] = target.hand.splice(safeIndex, 1);
  player.hand.push(card);
  player.memory.push({ from: target.id, rank: card.rank });
  const discardCount = discardPairs(player, game);
  arrangeNpcJoker(player, game.npcLevel);
  game.lastAction = {
    title: `${player.name} がカードを引いた`,
    text: `${target.name} から1枚引きました。`,
    detail: discardCount ? `${discardCount / 2} 組のペアを捨てました。` : "ペアはできませんでした。"
  };
  checkFinished(game);
  if (game.status === "playing") advanceTurn(game);
}

function runShuffleTime(game, playerId) {
  const player = game.players.find((item) => item.id === playerId);
  if (!canShuffleFor(player, game)) return;
  player.hasShuffleUsed = true;
  const roll = Math.floor(Math.random() * 6) + 1;
  const active = activePlayers(game);
  const right = playerBySeat(nextSeat(player.seatIndex, game, -1), game);
  const left = playerBySeat(nextSeat(player.seatIndex, game, 1), game);
  let success = true;
  if (roll === 1) swapHands(player, left);
  if (roll === 2) swapHands(player, right);
  if (roll === 3) {
    if (active.length < 4) success = false;
    else swapHands(player, playerBySeat(nextSeat(player.seatIndex, game, -2), game));
  }
  if (roll === 4) rotateHands(game, 1);
  if (roll === 5) rotateHands(game, -1);
  if (roll === 6) success = false;
  game.players.forEach((item) => {
    if (!item.isFinished) discardPairs(item, game);
    arrangeNpcJoker(item, game.npcLevel);
  });
  game.lastAction = {
    title: `出目: ${roll}`,
    text: SHUFFLE_TEXT[roll],
    detail: success ? "シャッフルタイムが成立しました。" : "対象不在またはドクロのため、何も起きませんでした。"
  };
  checkFinished(game);
  if (game.status === "playing" && player.isFinished) advanceTurn(game);
}

function discardPairs(player, game) {
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
    if (pairCount > 0) player.memory.push({ discarded: rank });
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

function advanceTurn(game) {
  game.currentTurnIndex = nextSeat(game.currentTurnIndex, game, -1);
}

function nextSeat(seatIndex, game, direction) {
  const active = activePlayers(game);
  if (!active.length) return seatIndex;
  const seats = active.map((player) => player.seatIndex);
  const currentPos = seats.indexOf(seatIndex);
  const base = currentPos >= 0 ? currentPos : 0;
  const next = (base + direction + seats.length) % seats.length;
  return seats[next];
}

function playerBySeat(seatIndex, game) {
  return game.players.find((player) => player.seatIndex === seatIndex);
}

function drawTargetFor(player, game) {
  if (!player) return null;
  return playerBySeat(nextSeat(player.seatIndex, game, -1), game);
}

function canShuffleFor(player, game) {
  return player && player.hand.some((card) => card.suit === "joker") && !player.hasShuffleUsed && activePlayers(game).length >= 3;
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
    for (let rank = 1; rank <= 13; rank += 1) {
      deck.push({ id: randomId("card"), suit, rank });
    }
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
  if (!player.isNPC || !hasJoker(player)) return;
  const jokerIndex = player.hand.findIndex((card) => card.suit === "joker");
  const [joker] = player.hand.splice(jokerIndex, 1);
  if (level === 1) {
    player.hand.splice(Math.floor(Math.random() * (player.hand.length + 1)), 0, joker);
    return;
  }
  if (level === 2) {
    player.hand.splice(Math.floor(player.hand.length / 2), 0, joker);
    return;
  }
  player.hand.push(joker);
}

async function performNpcTurn() {
  const npc = currentPlayer();
  if (!npc?.isNPC || state.status !== "playing") return;
  await wait(500 + Math.random() * 1000);
  if (state.status !== "playing" || currentPlayer()?.id !== npc.id) return;
  if (npcShouldShuffle(npc, state)) {
    runShuffleTime(state, npc.id);
    saveLocal();
    render();
    await wait(700);
  }
  if (state.status === "playing" && currentPlayer()?.id === npc.id) {
    const target = drawTargetFor(npc, state);
    const index = npcPickIndex(npc, target, state.npcLevel);
    drawCard(state, npc.id, index);
    saveLocal();
    render();
  }
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

function selectOwnCard(cardId) {
  const me = state.players.find((player) => player.id === clientId);
  if (!me) return;
  if (!selectedCardId) {
    selectedCardId = cardId;
    render();
    return;
  }
  const first = me.hand.findIndex((card) => card.id === selectedCardId);
  const second = me.hand.findIndex((card) => card.id === cardId);
  if (first >= 0 && second >= 0) {
    [me.hand[first], me.hand[second]] = [me.hand[second], me.hand[first]];
    sendAction("reorder", { handIds: me.hand.map((card) => card.id) });
  }
  selectedCardId = null;
  render();
}

function sendAction(type, payload = {}) {
  if (!localMode && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, playerId: clientId, ...payload }));
    return;
  }
  applyLocalAction(type, payload);
}

function applyLocalAction(type, payload) {
  if (!state) return;
  if (type === "join" && state.status === "waiting") {
    const existing = state.players.find((player) => player.id === clientId);
    if (!existing && state.players.filter((player) => !player.isNPC).length < state.playerCount) {
      state.players.push({
        id: clientId,
        name: payload.name || "ゲスト",
        isNPC: false,
        connected: true,
        hand: [],
        hasShuffleUsed: false,
        isFinished: false,
        finishOrder: null,
        seatIndex: state.players.length,
        memory: []
      });
    }
  }
  if (type === "start" && state.hostId === clientId && state.status === "waiting") startGame(state);
  if (type === "draw") drawCard(state, clientId, payload.index);
  if (type === "shuffle") runShuffleTime(state, clientId);
  if (type === "reorder") reorderHand(clientId, payload.handIds);
  if (type === "rematch" && state.hostId === clientId) {
    state.status = "waiting";
    state.players = state.players.filter((player) => !player.isNPC).map((player, index) => ({
      ...player,
      hand: [],
      hasShuffleUsed: false,
      isFinished: false,
      finishOrder: null,
      seatIndex: index,
      memory: []
    }));
    state.lastAction = { title: "再戦待機", text: "同じ人間プレイヤーで再戦できます。", detail: "開始するとNPCを補填します。" };
  }
  saveLocal();
  render();
}

function reorderHand(playerId, handIds) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player || !Array.isArray(handIds)) return;
  const byId = new Map(player.hand.map((card) => [card.id, card]));
  const nextHand = handIds.map((id) => byId.get(id)).filter(Boolean);
  if (nextHand.length === player.hand.length) player.hand = nextHand;
}

function connectRoom(id) {
  closeSocket();
  if (localMode) {
    state = loadLocal(id);
    if (!state) {
      state = null;
      missingRoomId = id;
      renderMissingRoom(id);
      return false;
    }
    missingRoomId = "";
    broadcast = new BroadcastChannel(`baba_${id}`);
    broadcast.onmessage = (event) => {
      state = event.data;
      render();
    };
    return true;
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${configuredHost}/party/${id}`);
  socket.addEventListener("open", () => {
    if (pendingCreate) {
      socket.send(JSON.stringify({
        type: "create",
        playerId: clientId,
        ...pendingCreate
      }));
      pendingCreate = null;
      return;
    }
    socket.send(JSON.stringify({
      type: "hello",
      playerId: clientId,
      name: localStorage.getItem("baba_player_name") || "ゲスト"
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      state = message.state;
      render();
    }
  });
  return true;
}

function renderMissingRoom(id) {
  shell(`
    <main class="screen panel room-panel">
      <h2>ルームが見つかりません</h2>
      <p class="muted">${escapeHtml(id)} はこのブラウザのローカル保存に存在しません。オンライン対戦にはPartyKit hostを設定してください。</p>
      <button id="home">トップへ</button>
    </main>
  `);
  document.querySelector("#home").addEventListener("click", () => navigate("/"));
}

function closeSocket() {
  if (socket) socket.close();
  if (broadcast) broadcast.close();
  socket = null;
  broadcast = null;
}

function saveLocal() {
  if (!localMode || !state) return;
  localStorage.setItem(`baba_room_${state.roomId}`, JSON.stringify(state));
  broadcast?.postMessage(clone(state));
}

function loadLocal(id) {
  const raw = localStorage.getItem(`baba_room_${id}`);
  return raw ? JSON.parse(raw) : null;
}

function scheduleNpc() {
  clearTimeout(npcTimer);
  if (!localMode) return;
  const turn = currentPlayer();
  if (turn?.isNPC && state.status === "playing") {
    npcTimer = setTimeout(performNpcTurn, 250);
  }
}

function playerHandHtml(player, myTurn, target) {
  return `
    <div class="hand-header">
      <span>${escapeHtml(player.name)} の手札 (${player.hand.length}枚)</span>
      <span class="badges">${player.hasShuffleUsed ? `<span class="badge used">シャッフル済</span>` : ""}</span>
    </div>
    <div class="hand-scroll">
      ${player.hand.map((card) => cardHtml(card)).join("") || `<span class="muted">上がり</span>`}
    </div>
    <div class="draw-panel">
      ${myTurn && target ? `
        <strong>${escapeHtml(target.name)} から1枚引く</strong>
        <div class="target-hand">
          ${target.hand.map((_, index) => `<button class="pick-card" data-pick-index="${index}" aria-label="${index + 1}枚目を引く"></button>`).join("")}
        </div>
      ` : `<span class="muted">${currentPlayer()?.isNPC ? "NPCが考え中です。" : "自分のターンを待っています。"}</span>`}
    </div>
  `;
}

function spectateHtml() {
  return `<div class="hand-header"><span>観戦中</span></div><p class="muted">ゲーム開始後の途中参加はできません。</p>`;
}

function opponentHtml(player, index, isTarget) {
  const classes = ["opponent", `pos-${index}`, player.seatIndex === state.currentTurnIndex ? "turn" : "", player.isFinished ? "finished" : ""].join(" ");
  return `
    <article class="${classes}">
      <header>
        <span>${escapeHtml(player.name)}</span>
        <span class="badges">
          ${player.isNPC ? `<span class="badge">NPC</span>` : ""}
          ${player.hasShuffleUsed ? `<span class="badge used">済</span>` : ""}
          ${isTarget ? `<span class="badge">引く相手</span>` : ""}
        </span>
      </header>
      <div class="mini-hand">
        ${Array.from({ length: player.hand.length }, () => `<span class="card-back"></span>`).join("") || `<span>上がり</span>`}
      </div>
    </article>
  `;
}

function cardHtml(card) {
  const red = card.suit === "heart" || card.suit === "diamond" || card.suit === "joker";
  return `
    <button class="card ${red ? "red" : ""} ${selectedCardId === card.id ? "selected" : ""}" data-card-id="${card.id}" aria-label="${cardLabel(card)}">
      <span class="rank">${card.suit === "joker" ? "JK" : (RANK_LABELS[card.rank] || card.rank)}</span>
      <span class="suit">${SUIT_LABELS[card.suit]}</span>
    </button>
  `;
}

function playerLineHtml(player) {
  return `
    <div class="player-line">
      <span class="seat-dot">${player.seatIndex + 1}</span>
      <span>${escapeHtml(player.name)}</span>
      <span class="muted">${player.isNPC ? "NPC" : player.id === state.hostId ? "ホスト" : "参加者"}</span>
    </div>
  `;
}

function joinFormHtml() {
  return `
    <div class="field">
      <label for="joinName">プレイヤー名</label>
      <input id="joinName" maxlength="16" value="${escapeHtml(localStorage.getItem("baba_player_name") || "")}" placeholder="花子">
    </div>
    <button id="joinButton">参加</button>
  `;
}

function navigate(path) {
  if (path === "/") location.hash = "";
  else location.hash = path;
}

function parseRoomId(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const hashMatch = url.hash.match(/\/room\/([^/]+)/);
    if (hashMatch) return hashMatch[1];
    const pathMatch = url.pathname.match(/\/room\/([^/]+)/);
    if (pathMatch) return pathMatch[1];
  } catch {
    return raw.replace(/^#?\/?room\//, "");
  }
  return raw.replace(/^#?\/?room\//, "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

window.addEventListener("hashchange", render);
render();
