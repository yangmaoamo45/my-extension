(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('“我的联机扩展”需要在非沙箱模式下运行');
  }

  const runtime = Scratch.vm.runtime;
  const Cast = Scratch.Cast;

  const MAX_HISTORY = 50;
  const MAX_PENDING = 100;
  const PING_INTERVAL = 3000;

  class GameSyncExtension {
    constructor() {
      this.socket = null;
      this._connected = false;
      this.nickname = '游客';
      this.room = 'default';
      this.chatHistory = [];
      this.pendingMessages = [];

      // 玩家
      this.players = {};        // { name: {x,y,data,admin,muted} }
      this.playerOrder = [];

      // 事件缓存
      this.lastJoined = '';
      this.lastLeft = '';
      this.lastGameSender = '';
      this.lastGameData = null;
      this.lastPrivateFrom = '';
      this.lastPrivateText = '';
      this.lastMessageType = '';

      // 权限 / 禁言
      this.isAdmin = false;
      this.amMuted = false;

      // 被踢
      this.kickBy = '';
      this.kickReason = '';
      this.wasKicked = false;
      this._kickedFlag = false;

      // Ping
      this.ping = -1;
      this._pingSentAt = 0;
      this._pingTimer = null;

      // 服务器信息
      this.serverInfo = '';

      // 自动重连
      this.autoReconnect = true;
      this._reconnectAttempts = 0;
      this._reconnectTimer = null;
      this._lastUrl = '';
      this._manualDisconnect = false;
    }

    // ==================== 积木定义 ====================
    getInfo() {
      return {
        id: 'gamesync',
        name: '我的联机扩展',
        color1: '#FF9800',
        color2: '#F57C00',
        blocks: [
          { blockType: 'label', text: '🔗 连接' },
          { opcode: 'connect', blockType: 'command', text: '连接到服务器 [URL]',
            arguments: { URL: { type: 'string', defaultValue: 'ws://localhost:8080' } } },
          { opcode: 'disconnect', blockType: 'command', text: '断开连接' },
          { opcode: 'isConnected', blockType: 'Boolean', text: '已连接？' },
          { opcode: 'setNickname', blockType: 'command', text: '设置昵称为 [NAME]',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'getMyName', blockType: 'reporter', text: '我的昵称' },
          { opcode: 'setAutoReconnect', blockType: 'command', text: '自动重连 [ON]',
            arguments: { ON: { type: 'string', menu: 'onOff', defaultValue: '开启' } } },
          { opcode: 'getPing', blockType: 'reporter', text: '当前延迟(毫秒)' },
          { opcode: 'pingNow', blockType: 'command', text: '立即测一次延迟' },

          { blockType: 'label', text: '🏠 房间' },
          { opcode: 'joinRoom', blockType: 'command', text: '加入房间 [ROOM]',
            arguments: { ROOM: { type: 'string', defaultValue: 'room1' } } },
          { opcode: 'leaveRoom', blockType: 'command', text: '返回默认房间' },
          { opcode: 'getCurrentRoom', blockType: 'reporter', text: '当前房间名' },
          { opcode: 'getRoomCount', blockType: 'reporter', text: '房间内玩家数量' },

          { blockType: 'label', text: '💬 聊天' },
          { opcode: 'sendChat', blockType: 'command', text: '发送聊天消息 [TEXT]',
            arguments: { TEXT: { type: 'string', defaultValue: '你好！' } } },
          { opcode: 'sendPrivate', blockType: 'command', text: '私聊 [TO] 说 [TEXT]',
            arguments: {
              TO: { type: 'string', defaultValue: '小明' },
              TEXT: { type: 'string', defaultValue: '悄悄话' }
            } },
          { opcode: 'whenMessageReceived', blockType: 'hat',
            text: '当收到消息', isEdgeActivated: false },
          { opcode: 'whenPrivateReceived', blockType: 'hat',
            text: '当收到私聊', isEdgeActivated: false },
          { opcode: 'getLastMessage', blockType: 'reporter', text: '最新一条消息' },
          { opcode: 'getLastMessageType', blockType: 'reporter', text: '最新消息类型' },
          { opcode: 'getLastPrivateFrom', blockType: 'reporter', text: '私聊来自' },
          { opcode: 'getLastPrivateText', blockType: 'reporter', text: '私聊内容' },
          { opcode: 'getChatLog', blockType: 'reporter', text: '完整聊天记录' },
          { opcode: 'clearChatLog', blockType: 'command', text: '清空聊天记录' },

          { blockType: 'label', text: '🎮 游戏同步' },
          { opcode: 'sendPosition', blockType: 'command',
            text: '发送我的坐标 x:[X] y:[Y]',
            arguments: {
              X: { type: 'number', defaultValue: 0 },
              Y: { type: 'number', defaultValue: 0 }
            } },
          { opcode: 'sendGameData', blockType: 'command',
            text: '发送游戏数据 [DATA]',
            arguments: { DATA: { type: 'string',
              defaultValue: '{"hp":100,"skin":"cat"}' } } },
          { opcode: 'whenGameDataReceived', blockType: 'hat',
            text: '当收到游戏数据', isEdgeActivated: false },
          { opcode: 'getPlayerX', blockType: 'reporter',
            text: '玩家 [NAME] 的 X',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'getPlayerY', blockType: 'reporter',
            text: '玩家 [NAME] 的 Y',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'getPlayerData', blockType: 'reporter',
            text: '玩家 [NAME] 的数据',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'getPlayerField', blockType: 'reporter',
            text: '玩家 [NAME] 的字段 [KEY]',
            arguments: {
              NAME: { type: 'string', defaultValue: '小明' },
              KEY: { type: 'string', defaultValue: 'hp' }
            } },
          { opcode: 'hasPlayer', blockType: 'Boolean',
            text: '玩家 [NAME] 在线？',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },

          { blockType: 'label', text: '📋 玩家列表' },
          { opcode: 'getAllPlayers', blockType: 'reporter',
            text: '所有玩家名字（换行分隔）' },
          { opcode: 'getPlayerCount', blockType: 'reporter',
            text: '在线玩家数量' },
          { opcode: 'getPlayerByIndex', blockType: 'reporter',
            text: '第 [N] 个玩家名字',
            arguments: { N: { type: 'number', defaultValue: 1 } } },
          { opcode: 'getPlayerXByIndex', blockType: 'reporter',
            text: '第 [N] 个玩家的 X',
            arguments: { N: { type: 'number', defaultValue: 1 } } },
          { opcode: 'getPlayerYByIndex', blockType: 'reporter',
            text: '第 [N] 个玩家的 Y',
            arguments: { N: { type: 'number', defaultValue: 1 } } },
          { opcode: 'getPlayerDataByIndex', blockType: 'reporter',
            text: '第 [N] 个玩家的数据',
            arguments: { N: { type: 'number', defaultValue: 1 } } },
          { opcode: 'clearPlayers', blockType: 'command',
            text: '清空玩家列表' },

          { blockType: 'label', text: '👥 玩家事件' },
          { opcode: 'whenPlayerJoin', blockType: 'hat',
            text: '当玩家加入', isEdgeActivated: false },
          { opcode: 'whenPlayerLeave', blockType: 'hat',
            text: '当玩家离开', isEdgeActivated: false },
          { opcode: 'getLastJoined', blockType: 'reporter',
            text: '最后加入的玩家' },
          { opcode: 'getLastLeft', blockType: 'reporter',
            text: '最后离开的玩家' },

          { blockType: 'label', text: '👑 管理员' },
          { opcode: 'claimAdmin', blockType: 'command',
            text: '用密码 [PWD] 成为管理员',
            arguments: { PWD: { type: 'string', defaultValue: 'admin123' } } },
          { opcode: 'amIAdmin', blockType: 'Boolean', text: '我是管理员？' },
          { opcode: 'isPlayerAdmin', blockType: 'Boolean',
            text: '玩家 [NAME] 是管理员？',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'getAdminList', blockType: 'reporter',
            text: '所有管理员（换行分隔）' },

          { blockType: 'label', text: '🚫 管理操作' },
          { opcode: 'kickPlayer', blockType: 'command',
            text: '踢出玩家 [NAME] 原因 [REASON]',
            arguments: {
              NAME:   { type: 'string', defaultValue: '小明' },
              REASON: { type: 'string', defaultValue: '违反规则' }
            } },
          { opcode: 'mutePlayer', blockType: 'command',
            text: '禁言玩家 [NAME]',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'unmutePlayer', blockType: 'command',
            text: '解除禁言 [NAME]',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'isPlayerMuted', blockType: 'Boolean',
            text: '玩家 [NAME] 被禁言？',
            arguments: { NAME: { type: 'string', defaultValue: '小明' } } },
          { opcode: 'amIMuted', blockType: 'Boolean', text: '我被禁言了？' },

          { blockType: 'label', text: '📢 被踢提示' },
          { opcode: 'whenKicked', blockType: 'hat',
            text: '当我被踢出', isEdgeActivated: false },
          { opcode: 'getKickBy', blockType: 'reporter', text: '踢我的人' },
          { opcode: 'getKickReason', blockType: 'reporter', text: '踢出原因' },

          { blockType: 'label', text: '🖥️ 服务器' },
          { opcode: 'requestServerInfo', blockType: 'command',
            text: '查询服务器信息' },
          { opcode: 'getServerInfo', blockType: 'reporter',
            text: '服务器信息（JSON）' },
          { opcode: 'getLastGameSender', blockType: 'reporter',
            text: '最后一条游戏数据来自' },
          { opcode: 'getLastGameData', blockType: 'reporter',
            text: '最后一条游戏数据（JSON）' }
        ],
        menus: {
          onOff: { items: ['开启', '关闭'] }
        }
      };
    }

    // ==================== 内部工具 ====================
    fireHat(opcode) {
      try { runtime.startHats(opcode, {}); }
      catch (e) { console.error('[GameSync] 触发帽子块失败:', e); }
    }

    sendRaw(data) {
      if (this._connected && this.socket &&
          this.socket.readyState === WebSocket.OPEN) {
        try { this.socket.send(JSON.stringify(data)); }
        catch (e) { console.error('[GameSync] 发送失败:', e); }
      } else if (this.pendingMessages.length < MAX_PENDING) {
        this.pendingMessages.push(data);
      }
    }

    pushChat(line) {
      this.chatHistory.push(line);
      while (this.chatHistory.length > MAX_HISTORY) this.chatHistory.shift();
    }

    addPlayer(name, initial) {
      if (!name) return;
      if (!this.players[name]) {
        this.players[name] = {
          x: 0, y: 0, data: {}, admin: false, muted: false
        };
        this.playerOrder.push(name);
      }
      const p = this.players[name];
      if (initial && typeof initial === 'object') {
        if (initial.x !== undefined)     p.x     = Cast.toNumber(initial.x);
        if (initial.y !== undefined)     p.y     = Cast.toNumber(initial.y);
        if (initial.data !== undefined)  p.data  = initial.data;
        if (initial.admin !== undefined) p.admin = !!initial.admin;
        if (initial.muted !== undefined) p.muted = !!initial.muted;
      }
    }

    removePlayer(name) {
      delete this.players[name];
      const i = this.playerOrder.indexOf(name);
      if (i >= 0) this.playerOrder.splice(i, 1);
    }

    renamePlayer(oldN, newN) {
      if (!this.players[oldN]) return;
      this.players[newN] = this.players[oldN];
      delete this.players[oldN];
      const i = this.playerOrder.indexOf(oldN);
      if (i >= 0) this.playerOrder[i] = newN;
    }

    // ==================== 连接管理 ====================
    connect(args) {
      const url = Cast.toString(args.URL).trim();
      if (!url) return;

      this._manualDisconnect = false;
      this._lastUrl = url;
      this._reconnectAttempts = 0;
      this.wasKicked = false;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      this._closeSocket();

      try {
        this.socket = new WebSocket(url);
      } catch (e) {
        console.error('[GameSync] 创建 WebSocket 失败:', e);
        return;
      }

      this.socket.onopen = () => {
        this._connected = true;
        this._reconnectAttempts = 0;
        console.log('[GameSync] ✅ 已连接:', url);

        const queue = this.pendingMessages;
        this.pendingMessages = [];
        for (const msg of queue) this.sendRaw(msg);

        this.sendRaw({ type: 'set_name', name: this.nickname });
        if (this.room && this.room !== 'default') {
          this.sendRaw({ type: 'join_room', room: this.room });
        }
        this._startPingLoop();
      };

      this.socket.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); }
        catch { data = { type: 'chat', name: '服务器',
                         text: String(event.data) }; }
        this.handleIncoming(data);
      };

      this.socket.onerror = (e) =>
        console.error('[GameSync] ❌ WebSocket 错误:', e);

      this.socket.onclose = (ev) => {
        const wasConnected = this._connected;
        this._connected = false;
        this.socket = null;
        this._stopPingLoop();
        this.players = {};
        this.playerOrder = [];
        console.log('[GameSync] 🔌 连接关闭 code=', ev && ev.code);

        // 被踢：服务器用 4001 关闭
        if (ev && ev.code === 4001) {
          this._manualDisconnect = true;
        }

        if (wasConnected && !this._manualDisconnect && !this._kickedFlag) {
          this._scheduleReconnect();
        }
        this._kickedFlag = false;
      };
    }

    _closeSocket() {
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
      }
      this.socket = null;
      this._connected = false;
      this._stopPingLoop();
    }

    disconnect() {
      this._manualDisconnect = true;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._closeSocket();
    }

    _scheduleReconnect() {
      if (!this.autoReconnect || !this._lastUrl) return;
      if (this._reconnectAttempts >= 8) {
        console.warn('[GameSync] 重连次数已达上限');
        return;
      }
      this._reconnectAttempts++;
      const delay = Math.min(30000,
        1000 * Math.pow(1.5, this._reconnectAttempts - 1));
      console.log(`[GameSync] ${Math.round(delay)}ms 后重连`
                  + `（第 ${this._reconnectAttempts} 次）`);
      this._reconnectTimer = setTimeout(() => {
        this.connect({ URL: this._lastUrl });
      }, delay);
    }

    _startPingLoop() {
      this._stopPingLoop();
      this.pingNow();
      this._pingTimer = setInterval(() => this.pingNow(), PING_INTERVAL);
    }

    _stopPingLoop() {
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
    }

    isConnected() { return this._connected; }

    setNickname(args) {
      const name = Cast.toString(args.NAME).trim() || '游客';
      this.nickname = name;
      if (this._connected) this.sendRaw({ type: 'set_name', name });
    }

    getMyName() { return this.nickname; }

    setAutoReconnect(args) {
      this.autoReconnect = args.ON === '开启';
    }

    getPing() { return this.ping; }

    pingNow() {
      if (!this._connected) return;
      this._pingSentAt = performance.now();
      this.sendRaw({ type: 'ping', t: Date.now() });
    }

    // ==================== 房间 ====================
    joinRoom(args) {
      const r = Cast.toString(args.ROOM).trim() || 'default';
      this.room = r;
      if (this._connected) this.sendRaw({ type: 'join_room', room: r });
    }

    leaveRoom() { this.joinRoom({ ROOM: 'default' }); }
    getCurrentRoom() { return this.room; }
    getRoomCount() { return this.playerOrder.length; }

    // ==================== 消息分发 ====================
    handleIncoming(data) {
      switch (data.type) {
        case 'welcome': {
          if (data.self) this.nickname = data.self;
          if (data.room) this.room = data.room;
          if (data.admin !== undefined) this.isAdmin = !!data.admin;
          this.players = {};
          this.playerOrder = [];
          const list = data.players || {};
          for (const [n, d] of Object.entries(list)) {
            if (n === this.nickname) continue;
            this.addPlayer(n, d);
          }
          break;
        }

        case 'player_join': {
          const n = data.name;
          if (n && n !== this.nickname) {
            this.addPlayer(n, {});
            this.lastJoined = n;
            this.pushChat(`【系统】✨ ${n} 加入了房间`);
            this.lastMessageType = 'system';
            this.fireHat('gamesync_whenPlayerJoin');
            this.fireHat('gamesync_whenMessageReceived');
          }
          break;
        }

        case 'player_leave': {
          const n = data.name;
          if (n && n !== this.nickname) {
            this.removePlayer(n);
            this.lastLeft = n;
            this.pushChat(`【系统】🚪 ${n} 离开了房间`);
            this.lastMessageType = 'system';
            this.fireHat('gamesync_whenPlayerLeave');
            this.fireHat('gamesync_whenMessageReceived');
          }
          break;
        }

        case 'rename': {
          const { old: o, new: n } = data;
          if (o && n) this.renamePlayer(o, n);
          this.pushChat(`【系统】📝 ${o} 改名为 ${n}`);
          this.lastMessageType = 'system';
          this.fireHat('gamesync_whenMessageReceived');
          break;
        }

        case 'self_rename': {
          if (data.name) this.nickname = data.name;
          break;
        }

        case 'status': {
          const n = data.name;
          if (n && this.players[n]) {
            if (data.admin !== undefined)
              this.players[n].admin = !!data.admin;
            if (data.muted !== undefined)
              this.players[n].muted = !!data.muted;
          }
          if (n === this.nickname) {
            if (data.admin !== undefined) this.isAdmin = !!data.admin;
            if (data.muted !== undefined) this.amMuted = !!data.muted;
          }
          break;
        }

        case 'kicked': {
          this.wasKicked = true;
          this.kickBy = data.by || '管理员';
          this.kickReason = data.reason || '被踢出';
          this._kickedFlag = true;
          this._manualDisconnect = true;
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
          }
          this.pushChat(`【系统】🚫 你被 ${this.kickBy} 踢出：`
                        + this.kickReason);
          this.lastMessageType = 'system';
          this.fireHat('gamesync_whenKicked');
          break;
        }

        case 'game': {
          const s = data.sender;
          if (!s || s === this.nickname) return;
          this.addPlayer(s, {});
          const p = this.players[s];
          const d = data.data || {};
          if (d.x !== undefined) p.x = Cast.toNumber(d.x);
          if (d.y !== undefined) p.y = Cast.toNumber(d.y);
          p.data = d;
          this.lastGameSender = s;
          this.lastGameData = d;
          this.fireHat('gamesync_whenGameDataReceived');
          break;
        }

        case 'chat': {
          this.pushChat(`${data.name ?? '未知'}: ${data.text ?? ''}`);
          this.lastMessageType = 'chat';
          this.fireHat('gamesync_whenMessageReceived');
          break;
        }

        case 'private': {
          this.lastPrivateFrom = data.echo ? `→${data.to}` : data.from;
          this.lastPrivateText = data.text ?? '';
          const prefix = data.echo ? `[我→${data.to}]`
                                   : `[私聊·${data.from}]`;
          this.pushChat(`${prefix} ${data.text ?? ''}`);
          this.lastMessageType = 'private';
          this.fireHat('gamesync_whenPrivateReceived');
          this.fireHat('gamesync_whenMessageReceived');
          break;
        }

        case 'system': {
          this.pushChat(`【系统】${data.text ?? ''}`);
          this.lastMessageType = 'system';
          this.fireHat('gamesync_whenMessageReceived');
          break;
        }

        case 'pong': {
          if (this._pingSentAt) {
            this.ping = Math.round(performance.now() - this._pingSentAt);
            this._pingSentAt = 0;
          }
          break;
        }

        case 'server_info': {
          this.serverInfo = JSON.stringify({
            uptime: Math.round(data.uptime || 0),
            totalRooms: data.total_rooms || 0,
            rooms: data.rooms || {}
          });
          break;
        }

        default: {
          this.pushChat(`[未知] ${JSON.stringify(data)}`);
          this.lastMessageType = 'unknown';
        }
      }
    }

    // ==================== 聊天 ====================
    sendChat(args) {
      const t = Cast.toString(args.TEXT).trim();
      if (!t) return;
      this.sendRaw({ type: 'chat', text: t });
    }

    sendPrivate(args) {
      const to = Cast.toString(args.TO).trim();
      const t = Cast.toString(args.TEXT).trim();
      if (!to || !t) return;
      this.sendRaw({ type: 'private', to, text: t });
    }

    whenMessageReceived() {}
    whenPrivateReceived() {}

    getLastMessage() {
      return this.chatHistory.length
        ? this.chatHistory[this.chatHistory.length - 1]
        : '(无消息)';
    }

    getLastMessageType() { return this.lastMessageType; }
    getLastPrivateFrom() { return this.lastPrivateFrom; }
    getLastPrivateText() { return this.lastPrivateText; }
    getChatLog() { return this.chatHistory.join('\n'); }
    clearChatLog() { this.chatHistory = []; }

    // ==================== 游戏同步 ====================
    sendPosition(args) {
      const x = Cast.toNumber(args.X);
      const y = Cast.toNumber(args.Y);
      this.sendRaw({ type: 'game', data: { x, y } });
    }

    sendGameData(args) {
      const raw = Cast.toString(args.DATA);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
      this.sendRaw({ type: 'game', data: parsed });
    }

    whenGameDataReceived() {}

    getPlayerX(args) {
      const p = this.players[Cast.toString(args.NAME)];
      return p ? p.x : 0;
    }

    getPlayerY(args) {
      const p = this.players[Cast.toString(args.NAME)];
      return p ? p.y : 0;
    }

    getPlayerData(args) {
      const p = this.players[Cast.toString(args.NAME)];
      return p ? JSON.stringify(p.data || {}) : '';
    }

    getPlayerField(args) {
      const p = this.players[Cast.toString(args.NAME)];
      if (!p) return '';
      const key = Cast.toString(args.KEY);
      const v = (p.data || {})[key];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    }

    hasPlayer(args) {
      return !!this.players[Cast.toString(args.NAME)];
    }

    // ==================== 玩家列表 ====================
    getAllPlayers() { return this.playerOrder.join('\n'); }
    getPlayerCount() { return this.playerOrder.length; }

    getPlayerByIndex(args) {
      const i = Math.floor(Cast.toNumber(args.N)) - 1;
      return this.playerOrder[i] ?? '';
    }

    getPlayerXByIndex(args) {
      const i = Math.floor(Cast.toNumber(args.N)) - 1;
      const n = this.playerOrder[i];
      return n ? this.players[n].x : 0;
    }

    getPlayerYByIndex(args) {
      const i = Math.floor(Cast.toNumber(args.N)) - 1;
      const n = this.playerOrder[i];
      return n ? this.players[n].y : 0;
    }

    getPlayerDataByIndex(args) {
      const i = Math.floor(Cast.toNumber(args.N)) - 1;
      const n = this.playerOrder[i];
      return n ? JSON.stringify(this.players[n].data || {}) : '';
    }

    clearPlayers() {
      this.players = {};
      this.playerOrder = [];
    }

    // ==================== 玩家事件 ====================
    whenPlayerJoin() {}
    whenPlayerLeave() {}
    getLastJoined() { return this.lastJoined; }
    getLastLeft() { return this.lastLeft; }

    // ==================== 管理员 ====================
    claimAdmin(args) {
      const pwd = Cast.toString(args.PWD);
      if (this._connected) {
        this.sendRaw({ type: 'claim_admin', password: pwd });
      }
    }

    amIAdmin() { return this.isAdmin; }

    isPlayerAdmin(args) {
      const p = this.players[Cast.toString(args.NAME)];
      return p ? !!p.admin : false;
    }

    getAdminList() {
      return this.playerOrder.filter(n => this.players[n].admin).join('\n');
    }

    // ==================== 管理操作 ====================
    kickPlayer(args) {
      if (!this.isAdmin) return;
      const target = Cast.toString(args.NAME).trim();
      const reason = Cast.toString(args.REASON).trim() || '被管理员踢出';
      if (!target) return;
      this.sendRaw({ type: 'kick', target, reason });
    }

    mutePlayer(args) {
      if (!this.isAdmin) return;
      const target = Cast.toString(args.NAME).trim();
      if (!target) return;
      this.sendRaw({ type: 'mute', target });
    }

    unmutePlayer(args) {
      if (!this.isAdmin) return;
      const target = Cast.toString(args.NAME).trim();
      if (!target) return;
      this.sendRaw({ type: 'unmute', target });
    }

    isPlayerMuted(args) {
      const p = this.players[Cast.toString(args.NAME)];
      return p ? !!p.muted : false;
    }

    amIMuted() { return this.amMuted; }

    // ==================== 被踢事件 ====================
    whenKicked() {}
    getKickBy() { return this.kickBy; }
    getKickReason() { return this.kickReason; }

    // ==================== 服务器 ====================
    requestServerInfo() {
      if (this._connected) this.sendRaw({ type: 'server_info' });
    }

    getServerInfo() { return this.serverInfo; }
    getLastGameSender() { return this.lastGameSender; }
    getLastGameData() {
      return this.lastGameData ? JSON.stringify(this.lastGameData) : '';
    }
  }

  Scratch.extensions.register(new GameSyncExtension());
})(Scratch);