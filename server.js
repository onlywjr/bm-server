const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ============================================================
// 基本設定
// ============================================================

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 99;

// 至少 2 人才開始
const MIN_PLAYERS_TO_START = 2;

// Ready 後倒數秒數
const COUNTDOWN_SECONDS = 10;

// 玩家狀態廣播最短間隔
// 防止前端傳太快把 Server 塞爆
const STATE_INTERVAL_MS = 80;

// ============================================================
// 房間資料
// ============================================================

const rooms = {};

// ============================================================
// 工具
// ============================================================

function generateRoomCode() {
  let code;

  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms[code]);

  return code;
}

function getRoomPlayers(room) {
  if (!room) return [];

  return Object.values(room.players || {});
}

function getReadyCount(room) {
  return getRoomPlayers(room).filter((player) => player.ready).length;
}

function getAlivePlayers(room) {
  return getRoomPlayers(room).filter((player) => player.alive);
}

function getHostId(room) {
  return room?.hostId || null;
}

// ============================================================
// 玩家公開資料
// ============================================================

function getPublicPlayer(player, room) {
  if (!player) return null;

  return {
    id: player.id,
    name: player.name,

    ready: !!player.ready,

    host: player.id === room.hostId,

    alive: !!player.alive,

    score: Number(player.score) || 0,

    rank: typeof player.rank === "number" ? player.rank : null,

    energy: typeof player.energy === "number" ? player.energy : 0,

    level: typeof player.level === "number" ? player.level : 1,
  };
}

// ============================================================
// Lobby State
// ============================================================

function getLobbyState(roomCode) {
  const room = rooms[roomCode];

  if (!room) {
    return null;
  }

  const players = getRoomPlayers(room);

  return {
    code: roomCode,
    dlc: room.dlc, // ★ 新增這行：廣播房間的 DLC 狀態
    status: room.status,

    maxPlayers: MAX_PLAYERS,

    minPlayersToStart: MIN_PLAYERS_TO_START,

    playerCount: players.length,

    readyCount: getReadyCount(room),

    countdown: room.countdownValue !== null ? room.countdownValue : null,

    hostId: getHostId(room),

    players: players.map((player) => getPublicPlayer(player, room)),
  };
}

// ============================================================
// 廣播 Lobby
// ============================================================

function broadcastLobby(roomCode) {
  const state = getLobbyState(roomCode);

  if (!state) return;

  console.log(
    `[Lobby] ${roomCode} → `
      + `${state.playerCount}/${MAX_PLAYERS} 玩家，`
      + `${state.readyCount}/${state.playerCount} Ready`,
  );

  // 新版
  io.to(roomCode).emit("lobbyState", state);

  // 舊版相容
  io.to(roomCode).emit(
    "roomUpdate",
    Object.fromEntries(
      state.players.map((player) => [
        player.id,
        {
          id: player.id,
          name: player.name,
          ready: player.ready,
          host: player.host,
        },
      ]),
    ),
  );
}

// ============================================================
// 建立玩家物件
// ============================================================

function createPlayer(socket, playerName) {
  const name =
    String(playerName || "")
      .trim()
      .substring(0, 16) || `玩家 ${socket.id.substring(0, 4)}`;

  return {
    id: socket.id,

    name,

    ready: false,

    alive: true,

    score: 0,

    rank: null,

    energy: 0,

    level: 1,

    state: null,

    lastStateAt: 0,

    eliminatedAt: null,
  };
}

// ============================================================
// 倒數取消
// ============================================================

function cancelRoomCountdown(roomCode, reason = "cancelled") {
  const room = rooms[roomCode];

  if (!room) return;

  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }

  room.countdownValue = null;

  if (room.status === "countdown") {
    room.status = "waiting";
  }

  console.log(`[Lobby] ${roomCode} 倒數取消：${reason}`);

  io.to(roomCode).emit("cancelCountdown", reason);

  broadcastLobby(roomCode);
}

// ============================================================
// 開始倒數
// ============================================================

function startRoomCountdown(roomCode) {
  const room = rooms[roomCode];

  if (!room) return;

  // 已經倒數就不要重複
  if (room.countdownTimer) return;

  const players = getRoomPlayers(room);

  if (players.length < MIN_PLAYERS_TO_START) {
    return;
  }

  const allReady = players.every((player) => player.ready);

  if (!allReady) {
    return;
  }

  room.status = "countdown";

  room.countdownValue = COUNTDOWN_SECONDS;

  console.log(
    `[Lobby] ${roomCode} 全員 Ready，開始 ${COUNTDOWN_SECONDS} 秒倒數`,
  );

  io.to(roomCode).emit("countdown", room.countdownValue);

  broadcastLobby(roomCode);

  room.countdownTimer = setInterval(() => {
    if (!rooms[roomCode]) {
      clearInterval(room.countdownTimer);
      return;
    }

    const currentRoom = rooms[roomCode];

    const currentPlayers = getRoomPlayers(currentRoom);

    // 人數不足
    if (currentPlayers.length < MIN_PLAYERS_TO_START) {
      cancelRoomCountdown(roomCode, "玩家人數不足");

      return;
    }

    // 有玩家取消 Ready
    const allReadyNow = currentPlayers.every((player) => player.ready);

    if (!allReadyNow) {
      cancelRoomCountdown(roomCode, "有人取消準備");

      return;
    }

    currentRoom.countdownValue--;

    if (currentRoom.countdownValue > 0) {
      io.to(roomCode).emit("countdown", currentRoom.countdownValue);

      broadcastLobby(roomCode);

      return;
    }

    // ========================================================
    // 正式開始遊戲
    // ========================================================

    clearInterval(currentRoom.countdownTimer);

    currentRoom.countdownTimer = null;

    currentRoom.countdownValue = null;

    currentRoom.status = "playing";

    currentRoom.game.startedAt = Date.now();

    // 重置玩家
    getRoomPlayers(currentRoom).forEach((player) => {
      player.alive = true;
      player.score = 0;
      player.rank = null;
      player.energy = 0;
      player.level = 1;
      player.state = null;
      player.lastStateAt = 0;
      player.eliminatedAt = null;
    });

    console.log(`[Game] ${roomCode} 多人遊戲開始`);

    const gamePlayers = getRoomPlayers(currentRoom).map((player) => ({
      id: player.id,

      name: player.name,

      host: player.id === currentRoom.hostId,
    }));

    broadcastLobby(roomCode);

    io.to(roomCode).emit("gameStart", {
      roomCode,

      players: gamePlayers,

      seed: currentRoom.game.seed,

      startedAt: currentRoom.game.startedAt,
    });
  }, 1000);
}

// ============================================================
// Ready 狀態檢查
// ============================================================

function checkRoomReady(roomCode) {
  const room = rooms[roomCode];

  if (!room) return;

  if (room.status === "playing") {
    return;
  }

  const players = getRoomPlayers(room);

  const enoughPlayers = players.length >= MIN_PLAYERS_TO_START;

  const allReady =
    enoughPlayers
    && players.length > 0
    && players.every((player) => player.ready);

  if (room.status === "waiting" && allReady) {
    startRoomCountdown(roomCode);

    return;
  }

  if (room.status === "countdown" && !allReady) {
    cancelRoomCountdown(roomCode, "Ready 狀態改變");
  }
}

// ============================================================
// 建立房間
// ============================================================
function createRoom(socket, playerName, dlc) {
  const roomCode = generateRoomCode();
  const player = createPlayer(socket, playerName);

  rooms[roomCode] = {
    code: roomCode,
    dlc: !!dlc, // ★ 儲存房間 DLC 狀態
    hostId: socket.id,
    players: { [socket.id]: player },
    status: "waiting",
    countdownTimer: null,
    countdownValue: null,
    game: { startedAt: null, seed: Math.floor(Math.random() * 1000000000) },
  };

  socket.join(roomCode);
  socket.currentRoom = roomCode;
  socket.playerName = player.name;

  console.log(
    `[Lobby] 建立房間 ${roomCode}，房主 ${player.name} (${socket.id}) DLC: ${!!dlc}`,
  );

  socket.emit("roomCreated", { code: roomCode, room: getLobbyState(roomCode) });

  // 舊版相容
  socket.emit("roomCreatedLegacy", roomCode);
  broadcastLobby(roomCode);

  return roomCode;
}
// ============================================================
// 加入房間
// ============================================================

function joinRoom(socket, roomCode, playerName) {
  roomCode = String(roomCode || "")
    .trim()
    .toUpperCase();

  if (!roomCode) {
    socket.emit("roomError", "請輸入房間代碼");

    return;
  }

  const room = rooms[roomCode];

  if (!room) {
    socket.emit("roomError", `找不到房間「${roomCode}」`);

    return;
  }

  if (room.status !== "waiting") {
    socket.emit("roomError", "這個房間已經開始倒數或正在遊戲中");

    return;
  }

  const playerCount = Object.keys(room.players).length;

  if (playerCount >= MAX_PLAYERS) {
    socket.emit("roomError", `房間已滿，最多 ${MAX_PLAYERS} 人`);

    return;
  }

  // 如果玩家已經在其他房間
  if (socket.currentRoom) {
    leaveCurrentRoom(socket);
  }

  const player = createPlayer(socket, playerName);

  room.players[socket.id] = player;

  socket.join(roomCode);

  socket.currentRoom = roomCode;

  socket.playerName = player.name;

  console.log(`[Lobby] ${player.name} 加入房間 ${roomCode}`);

  socket.emit("roomJoined", {
    code: roomCode,

    room: getLobbyState(roomCode),
  });

  socket.to(roomCode).emit("playerJoined", {
    player: {
      id: player.id,

      name: player.name,

      ready: player.ready,

      host: false,
    },
  });

  broadcastLobby(roomCode);

  return roomCode;
}

// ============================================================
// 玩家離開房間
// ============================================================

function leaveCurrentRoom(socket) {
  const roomCode = socket.currentRoom;

  if (!roomCode) return;

  const room = rooms[roomCode];

  if (!room) {
    socket.currentRoom = null;

    return;
  }

  const leavingPlayer = room.players[socket.id];

  if (leavingPlayer) {
    console.log(`[Lobby] ${leavingPlayer.name} 離開 ${roomCode}`);
  }

  delete room.players[socket.id];

  socket.leave(roomCode);

  socket.currentRoom = null;

  // ==========================================================
  // 房間沒人 → 刪除
  // ==========================================================

  if (Object.keys(room.players).length === 0) {
    if (room.countdownTimer) {
      clearInterval(room.countdownTimer);
    }

    delete rooms[roomCode];

    console.log(`[Lobby] 房間 ${roomCode} 已刪除`);

    return;
  }

  // ==========================================================
  // 房主離開 → 換房主
  // ==========================================================

  if (room.hostId === socket.id) {
    const remainingPlayers = getRoomPlayers(room);

    const newHost = remainingPlayers[0];

    if (newHost) {
      room.hostId = newHost.id;

      console.log(`[Lobby] ${roomCode} 新房主：${newHost.name}`);

      io.to(roomCode).emit("hostChanged", { hostId: newHost.id });
    }
  }

  // ==========================================================
  // 遊戲中有人離開
  // ==========================================================

  if (room.status === "playing") {
    const alivePlayers = getAlivePlayers(room);

    if (alivePlayers.length <= 1) {
      finishOnlineMatch(roomCode);
    }
  }

  // ==========================================================
  // 倒數中有人離開
  // ==========================================================

  if (room.status === "countdown") {
    checkRoomReady(roomCode);
  }

  broadcastLobby(roomCode);

  io.to(roomCode).emit("playerLeft", { playerId: socket.id });
}

// ============================================================
// 排名
// ============================================================

function updateRanks(room) {
  const players = getRoomPlayers(room);

  const alive = players
    .filter((p) => p.alive)
    .sort((a, b) => b.score - a.score);

  const dead = players
    .filter((p) => !p.alive)
    .sort((a, b) => (a.eliminatedAt || 0) - (b.eliminatedAt || 0));

  let rank = 1;

  alive.forEach((player) => {
    player.rank = rank++;
  });

  dead.reverse().forEach((player) => {
    player.rank = rank++;
  });
}

// ============================================================
// 玩家淘汰
// ============================================================

function eliminatePlayer(roomCode, playerId) {
  const room = rooms[roomCode];

  if (!room) return;

  const player = room.players[playerId];

  if (!player) return;

  if (!player.alive) return;

  player.alive = false;

  player.energy = 0;

  player.eliminatedAt = Date.now();

  updateRanks(room);

  console.log(`[Game] ${roomCode} → ${player.name} 被淘汰`);

  io.to(roomCode).emit("playerEliminated", {
    id: player.id,

    name: player.name,

    score: player.score,

    rank: player.rank,
  });

  const alive = getAlivePlayers(room);

  // ========================================================
  // 重要：
  // 0 人或 1 人都必須結算
  //
  // 這可以避免三個玩家幾乎同時死亡時，
  // Server 卡在「等待對戰結果」。
  // ========================================================

  if (alive.length <= 1) {
    finishOnlineMatch(roomCode);
  } else {
    broadcastLobby(roomCode);
  }
}

// ============================================================
// 多人遊戲結束
// ============================================================

function finishOnlineMatch(roomCode) {
  const room = rooms[roomCode];

  if (!room) return;

  if (room.status === "finished") {
    return;
  }

  room.status = "finished";

  const players = getRoomPlayers(room);

  const alive = players.filter((player) => player.alive);

  let winner = null;

  if (alive.length === 1) {
    winner = alive[0];

    winner.rank = 1;
  }

  // 沒有人存活
  // 以分數最高者作為最後勝者
  if (!winner && players.length) {
    winner = players.slice().sort((a, b) => b.score - a.score)[0];

    if (winner) {
      winner.rank = 1;
    }
  }

  updateRanks(room);

  if (winner) {
    winner.rank = 1;
  }

  const ranking = players
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((player) => ({
      id: player.id,

      name: player.name,

      score: player.score,

      alive: player.alive,

      rank: player.rank,
    }));

  console.log(
    `[Game] ${roomCode} 比賽結束，` + `Winner: ${winner?.name || "無"}`,
  );

  io.to(roomCode).emit("onlineMatchOver", {
    winner:
      winner ?
        {
          id: winner.id,

          name: winner.name,

          score: winner.score,
        }
      : null,

    players: ranking,
  });

  broadcastLobby(roomCode);
}

// ============================================================
// 選擇攻擊目標
// ============================================================

function selectAttackTarget(room, attacker) {
  const candidates = getAlivePlayers(room).filter(
    (player) => player.id !== attacker.id,
  );

  if (!candidates.length) {
    return null;
  }

  // ----------------------------------------------------------
  // 1v1
  // ----------------------------------------------------------

  if (candidates.length === 1) {
    return candidates[0];
  }

  // ----------------------------------------------------------
  // 3 人以上
  //
  // 優先攻擊目前分數最高者
  //
  // 如果分數相同 → 隨機
  // ----------------------------------------------------------

  const highestScore = Math.max(...candidates.map((player) => player.score));

  const topPlayers = candidates.filter(
    (player) => player.score === highestScore,
  );

  return topPlayers[Math.floor(Math.random() * topPlayers.length)];
}

// ============================================================
// Socket.IO
// ============================================================

io.on("connection", (socket) => {
  console.log(`[Socket] 玩家連線：${socket.id}`);

  socket.currentRoom = null;

  socket.playerName = null;

  // ==========================================================
  // 設定玩家名稱
  // ==========================================================

  socket.on("setPlayerName", (name) => {
    name = String(name || "")
      .trim()
      .substring(0, 16);

    if (!name) {
      return;
    }

    socket.playerName = name;

    const roomCode = socket.currentRoom;

    if (roomCode && rooms[roomCode]) {
      const player = rooms[roomCode].players[socket.id];

      if (player) {
        player.name = name;

        broadcastLobby(roomCode);
      }
    }

    socket.emit("playerNameSet", name);
  });

  // ==========================================================
  // 建立房間
  // ==========================================================
  socket.on("createRoom", (data) => {
    let playerName = socket.playerName;
    let dlc = false;

    if (typeof data === "string") {
      playerName = data;
    }

    if (data && typeof data === "object") {
      playerName = data.name || data.playerName || playerName;
      dlc = !!data.dlc; // ★ 接收 DLC 參數
    }

    if (socket.currentRoom) {
      leaveCurrentRoom(socket);
    }

    createRoom(socket, playerName, dlc); // ★ 將參數傳入核心函式
  });

  // ==========================================================
  // 加入房間
  // ==========================================================
  socket.on("joinRoom", (data) => {
    let roomCode = "";
    let playerName = socket.playerName;
    let clientDlc = false;

    if (typeof data === "string") {
      roomCode = data;
    }

    if (data && typeof data === "object") {
      roomCode = data.code || data.roomCode || "";
      playerName = data.name || data.playerName || playerName;
      clientDlc = !!data.dlc; // ★ 接收加入者的 DLC 設定
    }

    // ★ 伺服器端無情防呆攔截
    const room = rooms[roomCode.toUpperCase()];
    if (room && room.dlc !== clientDlc) {
      socket.emit(
        "roomError",
        `⛔ 加入失敗！請設為：${room.dlc ? "🧪 化學 DLC 模式" : "🎮 一般對戰"}，再加入。`,
      );
      return;
    }

    joinRoom(socket, roomCode, playerName);
  });

  // ==========================================================
  // 取得 Lobby
  // ==========================================================

  socket.on("getLobbyState", () => {
    const roomCode = socket.currentRoom;

    if (!roomCode || !rooms[roomCode]) {
      socket.emit("roomError", "目前沒有加入任何房間");

      return;
    }

    socket.emit("lobbyState", getLobbyState(roomCode));
  });

  // ==========================================================
  // Ready
  // ==========================================================

  socket.on("toggleReady", () => {
    const roomCode = socket.currentRoom;

    if (!roomCode) {
      socket.emit("roomError", "你目前不在任何房間");

      return;
    }

    const room = rooms[roomCode];

    if (!room) {
      socket.emit("roomError", "房間不存在");

      return;
    }

    if (room.status === "playing") {
      return;
    }

    const player = room.players[socket.id];

    if (!player) {
      return;
    }

    player.ready = !player.ready;

    console.log(
      `[Lobby] ${player.name} → ` + `${player.ready ? "READY" : "取消 READY"}`,
    );

    broadcastLobby(roomCode);

    socket.emit("readyChanged", { ready: player.ready });

    checkRoomReady(roomCode);
  });

  // ==========================================================
  // 離開房間
  // ==========================================================

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  // ==========================================================
  // ==========================================================
  // 多人遊戲：playerState
  // ==========================================================
  // ==========================================================

  socket.on("playerState", (state) => {
    const roomCode = socket.currentRoom;

    if (!roomCode) {
      return;
    }

    const room = rooms[roomCode];

    if (!room) {
      return;
    }

    if (room.status !== "playing") {
      return;
    }

    const player = room.players[socket.id];

    if (!player) {
      return;
    }

    // --------------------------------------------------------
    // 限制更新頻率
    // --------------------------------------------------------

    const now = Date.now();

    if (now - player.lastStateAt < STATE_INTERVAL_MS) {
      return;
    }

    player.lastStateAt = now;

    // --------------------------------------------------------
    // 基本資料
    // --------------------------------------------------------

    if (typeof state?.score === "number") {
      player.score = Math.max(0, Math.floor(state.score));
    }

    if (typeof state?.alive === "boolean") {
      if (player.alive && !state.alive) {
        eliminatePlayer(roomCode, player.id);

        return;
      }

      player.alive = state.alive;
    }

    if (typeof state?.energy === "number") {
      player.energy = Math.max(0, Math.min(10, state.energy));
    }

    if (typeof state?.level === "number") {
      player.level = Math.max(1, Math.floor(state.level));
    }

    // --------------------------------------------------------
    // 保存自己的遊戲狀態
    // --------------------------------------------------------

    player.state = {
      id: player.id,

      name: player.name,

      score: player.score,

      alive: player.alive,

      rank: player.rank,

      energy: player.energy,

      level: player.level,

      paddle: state?.paddle || null,

      ball: state?.ball || null,

      // 限制最多 180 塊
      bricks:
        Array.isArray(state?.bricks) ?
          state.bricks.slice(0, 180).map((brick) => ({
            x: Number(brick.x) || 0,

            y: Number(brick.y) || 0,

            w: Number(brick.w) || 0,

            h: Number(brick.h) || 0,

            hp: Number(brick.hp) || 0,

            ci: Number(brick.ci) || 0,
          }))
        : [],
    };

    // --------------------------------------------------------
    // 更新排名
    // --------------------------------------------------------

    updateRanks(room);

    // --------------------------------------------------------
    // 傳給其他玩家
    // --------------------------------------------------------

    socket.to(roomCode).emit("onlineState", player.state);

    // --------------------------------------------------------
    // 如果玩家死亡
    // --------------------------------------------------------

    if (!player.alive) {
      eliminatePlayer(roomCode, player.id);

      return;
    }
  });

  // ==========================================================
  // ==========================================================
  // 玩家攻擊
  // ==========================================================
  // ==========================================================

  socket.on("attackPlayer", (data) => {
    const roomCode = socket.currentRoom;

    const room = roomCode && rooms[roomCode];

    if (!room) {
      return;
    }

    if (room.status !== "playing") {
      return;
    }

    const attacker = room.players[socket.id];

    if (!attacker) {
      return;
    }

    if (!attacker.alive) {
      return;
    }

    // ======================================================
    // 防止同一個攻擊封包重複處理
    // ======================================================

    const attackId = data?.attackId;

    if (attackId && attacker.lastAttackId === attackId) {
      return;
    }

    if (attackId) {
      attacker.lastAttackId = attackId;
    }

    // ======================================================
    // Energy 驗證
    // ======================================================

    const clientEnergy = Number(data?.energy);

    if (attacker.energy < 10 && clientEnergy < 10) {
      socket.emit("onlineAttackRejected", {
        reason: "ENERGY_NOT_READY",

        energy: attacker.energy,
      });

      console.log(`[Attack] ${attacker.name} 攻擊失敗：Energy 不足`);

      return;
    }

    // 前端確認已經滿能量
    // 同步 Server 狀態
    if (attacker.energy < 10 && clientEnergy >= 10) {
      attacker.energy = 10;
    }

    // ======================================================
    // 找攻擊目標
    // ======================================================

    const target = selectAttackTarget(room, attacker);

    if (!target) {
      socket.emit("onlineAttackRejected", {
        reason: "NO_TARGET",

        energy: attacker.energy,
      });

      return;
    }

    // ======================================================
    // 技能種類
    // ======================================================

    const allowedTypes = ["reverse", "shrink", "garbage", "blind", "speed"];

    let type = data?.type;

    if (!allowedTypes.includes(type)) {
      type = "reverse";
    }

    // ======================================================
    // 強度
    // ======================================================

    let power = Number(data?.power) || 1;

    power = Math.max(1, Math.min(2, power));

    // ======================================================
    // 消耗 Energy
    // ======================================================

    attacker.energy = 0;

    // ======================================================
    // 傳送攻擊
    // ======================================================

    io.to(target.id).emit("playerAttacked", {
      attackerId: attacker.id,

      attackerName: attacker.name,

      targetId: target.id,

      targetName: target.name,

      power,

      type,

      attackId,

      timestamp: Date.now(),
    });

    // ======================================================
    // 回覆攻擊者
    // ======================================================

    socket.emit("onlineAttackAccepted", {
      targetId: target.id,

      targetName: target.name,

      type,

      power,

      attackId,
    });

    console.log(
      `[Attack] ${attacker.name} → `
        + `${target.name} : `
        + `${type} x${power}`,
    );
  });

  // ==========================================================
  // Client 主動宣告死亡
  // ==========================================================

  socket.on("playerEliminated", (data) => {
    const roomCode = socket.currentRoom;

    if (!roomCode) return;

    const room = rooms[roomCode];

    if (!room) return;

    if (room.status !== "playing") {
      return;
    }

    const player = room.players[socket.id];

    if (!player) return;

    // 如果玩家已經死亡，不要重複處理
    if (!player.alive) return;

    // 接收死亡前最後分數
    if (typeof data?.score === "number") {
      player.score = Math.max(0, Math.floor(data.score));
    }

    player.energy = 0;

    console.log(`[Game] ${roomCode} → ${player.name} 主動宣告淘汰`);

    eliminatePlayer(roomCode, socket.id);
  });

  // ==========================================================
  // 重新開始
  // ==========================================================

  socket.on("restartOnlineGame", () => {
    const roomCode = socket.currentRoom;

    if (!roomCode) {
      return;
    }

    const room = rooms[roomCode];

    if (!room) {
      return;
    }

    if (room.status !== "finished") {
      return;
    }

    // 全部玩家重新 Ready
    getRoomPlayers(room).forEach((player) => {
      player.ready = false;
      player.alive = true;
      player.score = 0;
      player.rank = null;
      player.energy = 0;
      player.level = 1;
      player.state = null;
      player.lastStateAt = 0;
    });

    room.status = "waiting";

    room.game.startedAt = null;

    room.game.seed = Math.floor(Math.random() * 1000000000);

    broadcastLobby(roomCode);
  });

  // ==========================================================
  // 斷線
  // ==========================================================

  socket.on("disconnect", (reason) => {
    console.log(`[Socket] 玩家斷線：${socket.id} (${reason})`);

    leaveCurrentRoom(socket);
  });
});

// ============================================================
// HTTP 測試
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,

    service: "Brick Breaker Multiplayer Lobby Server",

    port: PORT,

    rooms: Object.keys(rooms).length,

    maxPlayers: MAX_PLAYERS,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,

    timestamp: Date.now(),

    rooms: Object.keys(rooms).length,
  });
});

// ============================================================
// Server 啟動
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("");

  console.log("========================================");

  console.log("  打磚塊多人遊戲 Server");

  console.log("========================================");

  console.log(`  Port: ${PORT}`);

  console.log(`  Max players: ${MAX_PLAYERS}`);

  console.log(`  Min players: ${MIN_PLAYERS_TO_START}`);

  console.log(`  Countdown: ${COUNTDOWN_SECONDS}s`);

  console.log(`  State interval: ${STATE_INTERVAL_MS}ms`);

  console.log("========================================");

  console.log("");

  console.log(`  Local:  http://localhost:${PORT}`);

  console.log(`  Health: http://localhost:${PORT}/health`);

  console.log("");
});
