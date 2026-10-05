import asyncio
import itertools
import json
import socket
import time

import websockets

# ================== 配置 ==================
ADMIN_PASSWORD = "admin123"        # 👈 管理员密码，可自行修改
HOST = "0.0.0.0"                   # 监听所有网卡（不要改）
PORT = 8080

# ================== 全局状态 ==================
# rooms = { 房间名: { ws: {name, data, last_seen, admin, muted} } }
rooms = {}
ws_room = {}                       # { ws: 房间名 }
_counter = itertools.count(1)
start_time = time.time()


# ---------- 工具函数 ----------
def room(r):
    return rooms.setdefault(r, {})


def is_admin(ws, room_name):
    return rooms.get(room_name, {}).get(ws, {}).get("admin", False)


def is_muted(ws, room_name):
    return rooms.get(room_name, {}).get(ws, {}).get("muted", False)


def snapshot(room_name, exclude_ws=None):
    """新玩家加入时下发的全场状态"""
    out = {}
    for ws, info in rooms.get(room_name, {}).items():
        if ws is exclude_ws:
            continue
        d = info.get("data", {}) or {}
        out[info["name"]] = {
            "x": d.get("x", 0) if isinstance(d, dict) else 0,
            "y": d.get("y", 0) if isinstance(d, dict) else 0,
            "data": d,
            "admin": info.get("admin", False),
            "muted": info.get("muted", False),
        }
    return out


def unique_name(room_name, base):
    existing = {i["name"] for i in rooms.get(room_name, {}).values()}
    if base not in existing:
        return base
    i = 2
    while f"{base}({i})" in existing:
        i += 1
    return f"{base}({i})"


async def safe_send(ws, payload):
    try:
        await ws.send(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


async def broadcast(room_name, payload, exclude=None):
    conns = [w for w in list(rooms.get(room_name, {}).keys()) if w is not exclude]
    if not conns:
        return
    msg = json.dumps(payload, ensure_ascii=False)
    await asyncio.gather(*(c.send(msg) for c in conns), return_exceptions=True)


# ---------- 主处理 ----------
async def handler(websocket, *_args):
    room_name = "default"
    ws_room[websocket] = room_name

    idx = next(_counter)
    name = unique_name(room_name, f"玩家_{idx}")
    is_first = len(room(room_name)) == 0

    room(room_name)[websocket] = {
        "name": name,
        "data": {},
        "last_seen": time.time(),
        "admin": is_first,
        "muted": False,
    }
    print(f"🎮 {name} 加入房间 [{room_name}]  (在线 {len(rooms[room_name])})"
          f"{'  👑 房主' if is_first else ''}")

    # 欢迎包
    await safe_send(websocket, {
        "type": "welcome",
        "self": name,
        "room": room_name,
        "admin": is_first,
        "server_time": time.time(),
        "players": snapshot(room_name, exclude_ws=websocket),
    })
    await broadcast(room_name, {"type": "player_join", "name": name},
                    exclude=websocket)
    if is_first:
        await broadcast(room_name,
                        {"type": "system",
                         "text": f"👑 {name} 是房主（管理员）"})

    try:
        async for message in websocket:
            info = rooms.get(room_name, {}).get(websocket)
            if info:
                info["last_seen"] = time.time()

            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                data = {"type": "chat", "text": message}

            mtype = data.get("type")

            # ============ Ping ============
            if mtype == "ping":
                await safe_send(websocket, {"type": "pong", "t": data.get("t")})

            # ============ 改名 ============
            elif mtype == "set_name":
                new_name = str(data.get("name", "")).strip()[:32] or name
                if new_name != name:
                    new_name = unique_name(room_name, new_name)
                    old = name
                    rooms[room_name][websocket]["name"] = new_name
                    name = new_name
                    await safe_send(websocket,
                                    {"type": "self_rename", "name": new_name})
                    await broadcast(room_name,
                                    {"type": "rename",
                                     "old": old, "new": new_name},
                                    exclude=websocket)
                    await broadcast(room_name,
                                    {"type": "system",
                                     "text": f"📝 {old} 改名为 {new_name}"})

            # ============ 切换房间 ============
            elif mtype == "join_room":
                target = str(data.get("room", "")).strip()[:32] or "default"
                if target == room_name:
                    continue

                # 离开旧房间
                old_room = room_name
                old_dict = rooms.get(old_room, {})
                was_admin = old_dict.get(websocket, {}).get("admin", False)
                if websocket in old_dict:
                    del old_dict[websocket]
                    if not old_dict:
                        rooms.pop(old_room, None)
                    await broadcast(old_room,
                                    {"type": "player_leave", "name": name})
                    await broadcast(old_room,
                                    {"type": "system",
                                     "text": f"🚪 {name} 离开了房间"})

                # 进入新房间
                room_name = target
                ws_room[websocket] = room_name
                name = unique_name(room_name, name)
                first_here = len(room(room_name)) == 0
                new_admin = was_admin or first_here
                room(room_name)[websocket] = {
                    "name": name,
                    "data": {},
                    "last_seen": time.time(),
                    "admin": new_admin,
                    "muted": False,
                }
                print(f"🔀 {name} → 房间 [{room_name}]"
                      f"{'  👑 管理员' if new_admin else ''}")

                await safe_send(websocket, {
                    "type": "welcome",
                    "self": name,
                    "room": room_name,
                    "admin": new_admin,
                    "server_time": time.time(),
                    "players": snapshot(room_name, exclude_ws=websocket),
                })
                await broadcast(room_name,
                                {"type": "player_join", "name": name},
                                exclude=websocket)
                await broadcast(room_name,
                                {"type": "system",
                                 "text": f"✨ {name} 加入了房间"})

            # ============ 认领管理员 ============
            elif mtype == "claim_admin":
                pwd = str(data.get("password", ""))
                if pwd == ADMIN_PASSWORD:
                    rooms[room_name][websocket]["admin"] = True
                    await broadcast(room_name, {
                        "type": "status",
                        "name": name,
                        "admin": True,
                        "muted": rooms[room_name][websocket].get("muted", False),
                    })
                    await broadcast(room_name,
                                    {"type": "system",
                                     "text": f"👑 {name} 成为了管理员"})
                    print(f"👑 {name} 通过密码成为管理员")
                else:
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "❌ 管理员密码错误"})

            # ============ 踢人 ============
            elif mtype == "kick":
                if not is_admin(websocket, room_name):
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "⚠️ 只有管理员能踢人"})
                    continue
                target = str(data.get("target", "")).strip()
                reason = str(data.get("reason", "被管理员踢出"))[:200]
                if target == name:
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "⚠️ 你不能踢自己"})
                    continue
                found = False
                for w, i in list(rooms.get(room_name, {}).items()):
                    if i["name"] == target:
                        await safe_send(w, {"type": "kicked",
                                            "by": name, "reason": reason})
                        await asyncio.sleep(0.15)
                        try:
                            await w.close(code=4001, reason="kicked")
                        except Exception:
                            pass
                        print(f"🚫 {name} 踢出了 {target}：{reason}")
                        found = True
                        break
                if not found:
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": f"⚠️ 玩家 {target} 不在线"})

            # ============ 禁言 / 解禁 ============
            elif mtype in ("mute", "unmute"):
                if not is_admin(websocket, room_name):
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "⚠️ 只有管理员能操作禁言"})
                    continue
                target = str(data.get("target", "")).strip()
                value = (mtype == "mute")
                found = False
                for w, i in rooms.get(room_name, {}).items():
                    if i["name"] == target:
                        i["muted"] = value
                        await broadcast(room_name, {
                            "type": "status",
                            "name": target,
                            "admin": i.get("admin", False),
                            "muted": value,
                        })
                        await broadcast(room_name, {
                            "type": "system",
                            "text": (f"🔇 {target} 被 {name} 禁言"
                                     if value else
                                     f"🔊 {target} 被 {name} 解除禁言"),
                        })
                        print(f"{'🔇' if value else '🔊'} {name} → {target}")
                        found = True
                        break
                if not found:
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": f"⚠️ 玩家 {target} 不在线"})

            # ============ 聊天 ============
            elif mtype == "chat":
                if is_muted(websocket, room_name):
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "⚠️ 你已被禁言，无法发言"})
                else:
                    text = str(data.get("text", ""))[:500]
                    if text:
                        await broadcast(room_name,
                                        {"type": "chat",
                                         "name": name, "text": text})

            # ============ 私聊 ============
            elif mtype == "private":
                if is_muted(websocket, room_name):
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": "⚠️ 你已被禁言，无法发言"})
                    continue
                target = str(data.get("to", "")).strip()
                text = str(data.get("text", ""))[:500]
                if not target or not text:
                    continue
                found = False
                for w, i in rooms.get(room_name, {}).items():
                    if i["name"] == target:
                        await safe_send(w, {"type": "private",
                                            "from": name,
                                            "to": target,
                                            "text": text})
                        await safe_send(websocket, {"type": "private",
                                                    "from": name,
                                                    "to": target,
                                                    "text": text,
                                                    "echo": True})
                        found = True
                        break
                if not found:
                    await safe_send(websocket,
                                    {"type": "system",
                                     "text": f"⚠️ 玩家 {target} 不在线"})

            # ============ 游戏数据 ============
            elif mtype == "game":
                gd = data.get("data", {})
                if not isinstance(gd, dict):
                    gd = {"raw": gd}
                rooms[room_name][websocket]["data"] = gd
                await broadcast(room_name,
                                {"type": "game", "sender": name, "data": gd},
                                exclude=websocket)

            # ============ 服务器信息 ============
            elif mtype == "server_info":
                await safe_send(websocket, {
                    "type": "server_info",
                    "uptime": time.time() - start_time,
                    "total_rooms": len(rooms),
                    "rooms": {r: len(m) for r, m in rooms.items()},
                })

    except websockets.ConnectionClosed:
        pass
    finally:
        info = rooms.get(room_name, {}).pop(websocket, None)
        if info:
            print(f"👋 {info['name']} 离开房间 [{room_name}]")
            await broadcast(room_name,
                            {"type": "player_leave", "name": info["name"]})
            await broadcast(room_name,
                            {"type": "system",
                             "text": f"🚪 {info['name']} 离开了房间"})
            if not rooms.get(room_name):
                rooms.pop(room_name, None)
        ws_room.pop(websocket, None)


# ---------- 获取本机可用 IPv4 ----------
def get_local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))     # 不会真的发包
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    ips.discard("127.0.0.1")
    ips.discard("0.0.0.0")
    return sorted(ips)


# ---------- 启动 ----------
async def main():
    async with websockets.serve(handler, HOST, PORT):
        print("=" * 60)
        print("🚀 联机服务器已启动")
        print("=" * 60)
        print()
        print(f"  监听端口：   {PORT}")
        print(f"  管理员密码： {ADMIN_PASSWORD}")
        print()
        print("  📋 在 Scratch 积木【连接到服务器】里填下面任意一个：")
        print()
        print(f"     ws://localhost:{PORT}              ← 只有本机能连")
        print(f"     ws://127.0.0.1:{PORT}              ← 同上")
        for ip in get_local_ips():
            print(f"     ws://{ip}:{PORT}     ← 局域网/其他电脑用这个")
        print()
        print("  ❌ 不要填 ws://0.0.0.0:8080 —— 那是绑定地址，连不上")
        print("=" * 60)
        print()
        print("  ⏳ 按 Ctrl+C 停止服务器")
        print()
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 服务器已停止")
