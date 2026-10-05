import asyncio
import websockets
import json

clients = {}  # {websocket: nickname}

async def broadcast(data):
    """广播 JSON 消息给所有客户端"""
    if not clients:
        return
    message = json.dumps(data)
    for client in list(clients.keys()):
        try:
            await client.send(message)
        except:
            pass

async def handler(websocket):
    name = f"玩家_{len(clients)+1}"
    clients[websocket] = name
    print(f"🎮 {name} 加入")
    await broadcast({"type": "system", "text": f"✨ {name} 加入了游戏"})

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "set_name":
                    new_name = data.get("name", name)
                    old_name = clients[websocket]
                    if old_name != new_name:
                        clients[websocket] = new_name
                        await broadcast({"type": "system", "text": f"📝 {old_name} 改名为 {new_name}"})
                        name = new_name

                elif msg_type == "chat":
                    sender = clients.get(websocket, "未知")
                    text = data.get("text", "")
                    if text:
                        print(f"💬 {sender}: {text}")
                        await broadcast({"type": "chat", "name": sender, "text": text})

                elif msg_type == "game":
                    # 游戏数据：直接转发给所有其他客户端，附加上发送者昵称
                    sender = clients.get(websocket, "未知")
                    game_data = data.get("data", {})
                    await broadcast({
                        "type": "game",
                        "sender": sender,
                        "data": game_data
                    })
                    print(f"🎮 游戏数据来自 {sender}: {game_data}")

                else:
                    # 未知类型，当作游戏数据转发（兼容旧版）
                    sender = clients.get(websocket, "未知")
                    await broadcast({
                        "type": "game",
                        "sender": sender,
                        "data": {"raw": message}
                    })

            except json.JSONDecodeError:
                # 非 JSON 视为聊天
                sender = clients.get(websocket, "未知")
                await broadcast({"type": "chat", "name": sender, "text": message})

    except websockets.ConnectionClosed:
        pass
    finally:
        if websocket in clients:
            leave_name = clients[websocket]
            print(f"👋 {leave_name} 离开")
            await broadcast({"type": "system", "text": f"🚪 {leave_name} 离开了游戏"})
            del clients[websocket]

async def main():
    async with websockets.serve(handler, "localhost", 8080):
        print("🚀 游戏服务器运行在 ws://localhost:8080")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
