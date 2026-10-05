(function(Scratch) {
  'use strict';

  class GameSyncExtension {
    constructor() {
      this.socket = null;
      this.isConnected = false;
      this.nickname = '游客';
      this.chatHistory = [];
      this.pendingMessages = [];
      this.otherX = 0;
      this.otherY = 0;
      this.lastGameData = {};
    }

    getInfo() {
      return {
        id: 'gamesync',
        name: '我的联机扩展',
        color1: '#FF9800',
        color2: '#F57C00',
        blocks: [
          // ---- 基础连接 ----
          {
            opcode: 'connect',
            blockType: Scratch.BlockType.COMMAND,
            text: '连接到服务器 [URL]',
            arguments: {
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'ws://localhost:8080' }
            }
          },
          {
            opcode: 'setNickname',
            blockType: Scratch.BlockType.COMMAND,
            text: '设置昵称为 [NAME]',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: '小明' }
            }
          },

          // ---- 聊天 ----
          {
            opcode: 'sendChat',
            blockType: Scratch.BlockType.COMMAND,
            text: '发送聊天消息 [TEXT]',
            arguments: {
              TEXT: { type: Scratch.ArgumentType.STRING, defaultValue: '你好！' }
            }
          },
          {
            opcode: 'whenMessageReceived',
            blockType: Scratch.BlockType.HAT,
            text: '当收到消息',
            isEdgeActivated: false
          },
          {
            opcode: 'getLastMessage',
            blockType: Scratch.BlockType.REPORTER,
            text: '最新一条消息'
          },
          {
            opcode: 'getChatLog',
            blockType: Scratch.BlockType.REPORTER,
            text: '完整聊天记录'
          },
          {
            opcode: 'clearChatLog',
            blockType: Scratch.BlockType.COMMAND,
            text: '清空聊天记录'
          },

          // ---- 游戏同步 ----
          {
            opcode: 'sendMyPosition',
            blockType: Scratch.BlockType.COMMAND,
            text: '发送我的位置'
          },
          {
            opcode: 'sendGameData',
            blockType: Scratch.BlockType.COMMAND,
            text: '发送游戏数据 [DATA]',
            arguments: {
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '{"x":100,"y":200}' }
            }
          },
          {
            opcode: 'whenGameDataReceived',
            blockType: Scratch.BlockType.HAT,
            text: '当收到游戏数据',
            isEdgeActivated: false
          },
          {
            opcode: 'getOtherX',
            blockType: Scratch.BlockType.REPORTER,
            text: '其他玩家的 X'
          },
          {
            opcode: 'getOtherY',
            blockType: Scratch.BlockType.REPORTER,
            text: '其他玩家的 Y'
          }
        ]
      };
    }

    // ---------- 内部工具 ----------
    sendRaw(data) {
      if (this.isConnected && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(data));
      } else {
        this.pendingMessages.push(data);
      }
    }

    // ---------- 连接 ----------
    connect(args) {
      const url = args.URL;
      console.log('🔗 连接到:', url);
      if (this.socket) { this.socket.close(); this.socket = null; }
      this.isConnected = false;

      try {
        this.socket = new WebSocket(url);
        this.socket.onopen = () => {
          console.log('✅ 连接成功');
          this.isConnected = true;
          while (this.pendingMessages.length > 0) {
            this.sendRaw(this.pendingMessages.shift());
          }
          this.sendRaw({ type: 'set_name', name: this.nickname });
        };

        this.socket.onmessage = (event) => {
          let data;
          try { data = JSON.parse(event.data); } catch { data = { type: 'chat', name: '服务器', text: event.data }; }
          this.handleIncoming(data);
        };

        this.socket.onerror = (e) => console.error('❌ 错误:', e);
        this.socket.onclose = () => {
          console.log('🔌 断开');
          this.socket = null;
          this.isConnected = false;
        };
      } catch (e) {
        console.error('❌ 创建失败:', e.message);
      }
    }

    handleIncoming(data) {
      const type = data.type;
      if (type === 'system') {
        this.chatHistory.push(`【系统】${data.text}`);
        Scratch.vm.runtime.startHats('gamesync_whenMessageReceived', {});
      } else if (type === 'chat') {
        this.chatHistory.push(`${data.name}: ${data.text}`);
        Scratch.vm.runtime.startHats('gamesync_whenMessageReceived', {});
      } else if (type === 'game') {
        const sender = data.sender || '未知';
        const gameData = data.data || {};
        this.lastGameData = { sender, data: gameData };
        if (gameData.x !== undefined && gameData.y !== undefined) {
          this.otherX = gameData.x;
          this.otherY = gameData.y;
          console.log(`📍 收到 ${sender} 的位置: (${this.otherX}, ${this.otherY})`);
        }
        Scratch.vm.runtime.startHats('gamesync_whenGameDataReceived', {});
      } else {
        this.chatHistory.push(`[未知] ${JSON.stringify(data)}`);
      }
      if (this.chatHistory.length > 50) this.chatHistory.shift();
    }

    // ---------- 积木实现 ----------
    setNickname(args) {
      this.nickname = args.NAME;
      if (this.isConnected) this.sendRaw({ type: 'set_name', name: this.nickname });
    }

    sendChat(args) {
      const text = args.TEXT.trim();
      if (!text) return;
      this.sendRaw({ type: 'chat', name: this.nickname, text });
    }

    whenMessageReceived() {}
    getLastMessage() { return this.chatHistory.length ? this.chatHistory[this.chatHistory.length-1] : '(无消息)'; }
    getChatLog() { return this.chatHistory.join('\n'); }
    clearChatLog() { this.chatHistory = []; }

    // ---- 游戏同步积木 ----
    sendMyPosition() {
      try {
        // 方法1：获取当前角色（编辑目标）
        let currentSprite = Scratch.vm.runtime.editingTarget;
        if (currentSprite) {
          const x = currentSprite.x;
          const y = currentSprite.y;
          this.sendRaw({ type: 'game', data: { x, y } });
          console.log(`📤 发送我的位置(角色): (${x}, ${y})`);
          return;
        }

        // 方法2：从舞台变量中读取（变量名：我的X, 我的Y）
        const stage = Scratch.vm.runtime.getTargetForStage();
        if (stage && stage.variables) {
          // 遍历变量列表，查找名为 '我的X' 和 '我的Y' 的变量
          let varX = null, varY = null;
          // 注意：stage.variables 是一个对象，键是变量ID，值是 { name, value }
          const varList = Object.values(stage.variables);
          for (const v of varList) {
            if (v.name === '我的X') varX = v;
            if (v.name === '我的Y') varY = v;
          }
          if (varX && varY) {
            const x = varX.value;
            const y = varY.value;
            this.sendRaw({ type: 'game', data: { x, y } });
            console.log(`📤 发送我的位置(变量): (${x}, ${y})`);
            return;
          } else {
            console.warn('⚠️ 未找到变量 "我的X" 或 "我的Y"，请确保它们是舞台变量');
          }
        } else {
          console.warn('⚠️ 无法获取舞台变量');
        }
      } catch (e) {
        console.error('❌ 发送位置失败:', e);
      }
    }

    sendGameData(args) {
      const dataStr = args.DATA;
      try {
        const parsed = JSON.parse(dataStr);
        this.sendRaw({ type: 'game', data: parsed });
      } catch (e) {
        this.sendRaw({ type: 'game', data: { raw: dataStr } });
      }
    }

    whenGameDataReceived() {}

    getOtherX() {
      return this.otherX;
    }

    getOtherY() {
      return this.otherY;
    }
  }

  Scratch.extensions.register(new GameSyncExtension());
})(Scratch);