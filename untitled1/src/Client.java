import java.io.*;
import java.net.*;

public class Client {

    public static void main(String[] args) throws IOException {
        BufferedReader console = new BufferedReader(new InputStreamReader(System.in));

        System.out.println("============ Java 聊天室客户端 ============");

        System.out.print("服务器地址（回车默认 localhost）：");
        String host = console.readLine();
        if (host == null) return;
        host = host.trim();
        if (host.isEmpty()) host = "localhost";

        System.out.print("端口（回车默认 8080）：");
        String portStr = console.readLine();
        if (portStr == null) return;
        portStr = portStr.trim();
        int port = portStr.isEmpty() ? 8080 : Integer.parseInt(portStr);

        System.out.print("你的昵称：");
        String name = console.readLine();
        if (name == null) return;
        name = name.trim();
        if (name.isEmpty()) name = "游客" + (int)(Math.random() * 9000 + 1000);

        System.out.println("正在连接 " + host + ":" + port + " ...");

        Socket socket;
        try {
            socket = new Socket(host, port);
        } catch (IOException e) {
            System.out.println("❌ 连接失败：" + e.getMessage());
            System.out.println("   请确认服务器已启动、地址和端口正确、防火墙放行");
            return;
        }

        final BufferedReader in = new BufferedReader(
                new InputStreamReader(socket.getInputStream(), "UTF-8"));
        final PrintWriter out = new PrintWriter(
                new OutputStreamWriter(socket.getOutputStream(), "UTF-8"), true);

        // 第一条消息 = 昵称
        out.println(name);

        // ---------- 接收线程 ----------
        Thread reader = new Thread(() -> {
            try {
                String line;
                while ((line = in.readLine()) != null) {
                    System.out.println(line);
                }
            } catch (IOException ignored) {
                // 连接断开
            }
            System.out.println("\n【连接已关闭，请重新启动客户端】");
            System.exit(0);
        });
        reader.setDaemon(true);
        reader.start();

        System.out.println("✅ 已连接！直接打字 = 群聊，/help 查看命令，/quit 退出");
        System.out.println("--------------------------------------------------");

        // ---------- 主线程：读键盘输入并发送 ----------
        String line;
        while ((line = console.readLine()) != null) {
            out.println(line);
            if (line.trim().equalsIgnoreCase("/quit")) break;
        }

        socket.close();
    }
}