import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

public class Server {

    static final int PORT = 8080;
    static final String ADMIN_PASSWORD = "admin123";   // 👈 管理员密码，可修改

    // 在线玩家：名字 → 处理线程
    static final Map<String, ClientHandler> clients = new ConcurrentHashMap<>();

    public static void main(String[] args) throws IOException {
        ServerSocket serverSocket = new ServerSocket(PORT);

        System.out.println("====================================================");
        System.out.println("🚀 Java 聊天服务器已启动");
        System.out.println("   端口：       " + PORT);
        System.out.println("   管理员密码： " + ADMIN_PASSWORD);
        System.out.println("====================================================");
        System.out.println("等待客户端连接...");
        System.out.println();

        int counter = 0;
        while (true) {
            Socket socket = serverSocket.accept();
            counter++;
            new Thread(new ClientHandler(socket, counter)).start();
        }
    }

    // ==================== 单个客户端处理 ====================
    static class ClientHandler implements Runnable {

        Socket socket;
        BufferedReader in;
        PrintWriter out;
        String name;
        boolean admin = false;
        boolean muted = false;

        ClientHandler(Socket socket, int id) {
            this.socket = socket;
            this.name = "玩家_" + id;    // 临时名字，等客户端发来真名再改
        }

        @Override
        public void run() {
            try {
                in = new BufferedReader(
                        new InputStreamReader(socket.getInputStream(), "UTF-8"));
                out = new PrintWriter(
                        new OutputStreamWriter(socket.getOutputStream(), "UTF-8"), true);

                // ---------- 第一条消息 = 昵称 ----------
                String firstLine = in.readLine();
                if (firstLine != null) {
                    String want = firstLine.trim();
                    if (want.startsWith("/name "))
                        want = want.substring(6).trim();
                    if (!want.isEmpty() && want.length() <= 20)
                        this.name = want;
                }

                // ---------- 处理重名 ----------
                synchronized (clients) {
                    String base = this.name;
                    int i = 2;
                    while (clients.containsKey(this.name)) {
                        this.name = base + "(" + i + ")";
                        i++;
                    }
                    // 第一个进房间的人 = 房主
                    if (clients.isEmpty()) this.admin = true;
                    clients.put(this.name, this);
                }

                // ---------- 欢迎语 ----------
                send("====================================================");
                send("   欢迎来到 Java 聊天室！");
                send("   你的名字：" + name + (admin ? "   [管理员]" : ""));
                send("   输入 /help 查看命令");
                send("====================================================");

                broadcast("【系统】✨ " + name + " 加入了聊天室", this);
                System.out.println("✅ " + name + " 已连接  (IP: "
                        + socket.getInetAddress().getHostAddress()
                        + ")  当前在线 " + clients.size() + " 人");

                // ---------- 消息循环 ----------
                String line;
                while ((line = in.readLine()) != null) {
                    handleMessage(line);
                }

            } catch (IOException e) {
                // 客户端断开
            } finally {
                synchronized (clients) {
                    clients.remove(name);
                }
                broadcast("【系统】🚪 " + name + " 离开了聊天室", this);
                System.out.println("❌ " + name + " 已断开  当前在线 "
                        + clients.size() + " 人");
                try { socket.close(); } catch (IOException ignored) {}
            }
        }

        // ==================== 处理每条消息 ====================
        void handleMessage(String raw) {
            String line = raw.trim();
            if (line.isEmpty()) return;

            // -------- 命令 --------
            if (line.startsWith("/")) {
                String[] parts = line.substring(1).split("\\s+", 3);
                String cmd = parts[0].toLowerCase();

                switch (cmd) {

                    case "name": {
                        if (parts.length < 2) { send("用法：/name 新名字"); return; }
                        String nn = parts[1].trim();
                        if (nn.isEmpty() || nn.length() > 20) {
                            send("⚠️ 名字长度需为 1~20"); return;
                        }
                        String old = name;
                        synchronized (clients) {
                            if (clients.containsKey(nn)) {
                                send("⚠️ 名字已被占用"); return;
                            }
                            clients.remove(old);
                            name = nn;
                            clients.put(name, this);
                        }
                        broadcast("【系统】📝 " + old + " 改名为 " + nn, null);
                        break;
                    }

                    case "msg": {
                        if (parts.length < 3) { send("用法：/msg 名字 消息"); return; }
                        ClientHandler target = clients.get(parts[1]);
                        if (target == null) {
                            send("⚠️ 玩家 " + parts[1] + " 不在线"); return;
                        }
                        String text = "【私聊】" + name + " → " + parts[1] + "：" + parts[2];
                        target.send(text);
                        send(text);          // 自己也看到一份
                        break;
                    }

                    case "list": {
                        send("在线玩家（" + clients.size() + " 人）：");
                        for (Map.Entry<String, ClientHandler> e : clients.entrySet()) {
                            ClientHandler c = e.getValue();
                            send("  · " + e.getKey()
                                    + (c.admin ? "   [管理员]" : "")
                                    + (c.muted ? "   [已禁言]" : ""));
                        }
                        break;
                    }

                    case "admin": {
                        if (parts.length < 2) { send("用法：/admin 密码"); return; }
                        if (parts[1].equals(ADMIN_PASSWORD)) {
                            admin = true;
                            broadcast("【系统】👑 " + name + " 成为了管理员", null);
                        } else {
                            send("❌ 密码错误");
                        }
                        break;
                    }

                    case "kick": {
                        if (!admin) { send("⚠️ 需要管理员权限"); return; }
                        if (parts.length < 2) { send("用法：/kick 名字"); return; }
                        ClientHandler victim = clients.get(parts[1]);
                        if (victim == null) { send("⚠️ 玩家不在线"); return; }
                        victim.send("【系统】🚫 你被 " + name + " 踢出了聊天室");
                        try { Thread.sleep(200); } catch (InterruptedException ignored) {}
                        try { victim.socket.close(); } catch (IOException ignored) {}
                        break;
                    }

                    case "mute": {
                        if (!admin) { send("⚠️ 需要管理员权限"); return; }
                        if (parts.length < 2) { send("用法：/mute 名字"); return; }
                        ClientHandler m = clients.get(parts[1]);
                        if (m == null) { send("⚠️ 玩家不在线"); return; }
                        m.muted = true;
                        broadcast("【系统】🔇 " + parts[1] + " 被 " + name + " 禁言", null);
                        break;
                    }

                    case "unmute": {
                        if (!admin) { send("⚠️ 需要管理员权限"); return; }
                        if (parts.length < 2) { send("用法：/unmute 名字"); return; }
                        ClientHandler um = clients.get(parts[1]);
                        if (um == null) { send("⚠️ 玩家不在线"); return; }
                        um.muted = false;
                        broadcast("【系统】🔊 " + parts[1] + " 被 " + name + " 解除禁言", null);
                        break;
                    }

                    case "help": {
                        send("===== 可用命令 =====");
                        send("  /name 新名字        改昵称");
                        send("  /msg 名字 消息      私聊");
                        send("  /list               查看在线玩家");
                        send("  /quit               退出");
                        if (admin) {
                            send("  /kick 名字          踢人");
                            send("  /mute 名字          禁言");
                            send("  /unmute 名字        解除禁言");
                        } else {
                            send("  /admin 密码         成为管理员（知道密码的人）");
                        }
                        break;
                    }

                    case "quit": {
                        try { socket.close(); } catch (IOException ignored) {}
                        break;
                    }

                    default:
                        send("⚠️ 未知命令：" + cmd + "，输入 /help 查看帮助");
                }
                return;
            }

            // -------- 普通聊天 --------
            if (muted) {
                send("⚠️ 你已被禁言，无法发言");
                return;
            }
            broadcast("[" + name + "] " + line, this);
        }

        // ==================== 发送 ====================
        void send(String msg) {
            out.println(msg);
        }
    }

    // ==================== 广播 ====================
    static void broadcast(String msg, ClientHandler exclude) {
        for (ClientHandler c : clients.values()) {
            if (c != exclude) c.send(msg);
        }
    }
}