# -*- coding: utf-8 -*-
"""WorkBoard 部署脚本：通过 paramiko 同步代码 / 安装依赖 / 配置 systemd / 校验。
用法：python deploy.py [--host HOST] [--user root] [--port 80]
建议端口：80（网页）"""
import io
import os
import sys

import paramiko

HOST = "117.72.107.186"
USER = "root"
PASSWORD = "Ifiwant0"
APP_DIR = "/opt/workboard"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UNIT = """[Unit]
Description=WorkBoard - personal work dashboard (ByteDance style)
After=network.target

[Service]
Type=simple
WorkingDirectory={app}
ExecStart={node} server.js
Restart=always
RestartSec=3
Environment=PORT=80
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""


def run(client, cmd, timeout=240):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    return out, err


def collect_files(root):
    """返回 相对路径 -> 本地绝对路径 的代码文件列表（排除 data / node_modules）。"""
    files = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("data", "node_modules", ".git", "_tmp")]
        for n in names:
            if n.endswith(".pyc") or n.startswith("."):
                continue
            p = os.path.join(base, n)
            rel = os.path.relpath(p, root).replace("\\", "/")
            files[rel] = p
    return files


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else HOST
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[deploy] 连接 {USER}@{host} ...")
    ssh.connect(host, port=22, username=USER, password=PASSWORD,
                timeout=30, allow_agent=False, look_for_keys=False)
    sftp = ssh.open_sftp()

    print("[deploy] 创建远程目录 ...")
    # 按父->子顺序创建；SFTP mkdir 不递归，祖先必须已存在
    dirs = [APP_DIR, APP_DIR + "/public", APP_DIR + "/public/css",
            APP_DIR + "/public/js", APP_DIR + "/data", APP_DIR + "/data/uploads",
            APP_DIR + "/deploy", APP_DIR + "/lib"]
    for d in dirs:
        try:
            sftp.mkdir(d)
        except IOError:
            pass  # 已存在则忽略

    print("[deploy] 上传代码（data/、node_modules 除外） ...")
    code_map = {"server.js": "server.js", "package.json": "package.json",
                "package-lock.json": "package-lock.json"}

    def up(local, remote):
        sftp.put(local, remote)
        print("    ->", remote)

    for name, target in code_map.items():
        lp = os.path.join(LOCAL_ROOT, name)
        if os.path.exists(lp):
            up(lp, APP_DIR + "/" + target)

    # 上传整个 public/ 静态资源树（含 manage.html、css、js、favicon 等）
    def ensure_remote(rel_dir):
        sftp.mkdir(rel_dir)

    public_root = os.path.join(LOCAL_ROOT, "public")
    stack = [(public_root, APP_DIR + "/public")]
    while stack:
        local_dir, remote_dir = stack.pop()
        need = [d for d in os.listdir(local_dir) if os.path.isdir(os.path.join(local_dir, d))]
        for d in need:
            rd = remote_dir + "/" + d
            try:
                sftp.mkdir(rd)
            except IOError:
                pass
            stack.append((os.path.join(local_dir, d), rd))
        for f in os.listdir(local_dir):
            lp = os.path.join(local_dir, f)
            if os.path.isdir(lp):
                continue
            up(lp, remote_dir + "/" + f)

    # 上传 lib/ 模块
    lib_root = os.path.join(LOCAL_ROOT, "lib")
    if os.path.isdir(lib_root):
        for f in os.listdir(lib_root):
            lp = os.path.join(lib_root, f)
            if os.path.isfile(lp):
                up(lp, APP_DIR + "/lib/" + f)

    sftp.close()

    print("[deploy] node 路径检测 ...")
    node_bin, _ = run(ssh, "command -v node")
    node_bin = node_bin.strip() or "/usr/bin/node"
    print("    node:", node_bin)

    print("[deploy] npm install（仅生产依赖） ...")
    out, err = run(ssh, f"cd {APP_DIR} && npm install --omit=dev --no-audit --no-fund", timeout=600)
    print(out[-1500:])
    if err.strip():
        print("[stderr]", err[-1500:])

    print("[deploy] 写入 systemd 单元 ...")
    unit = UNIT.format(app=APP_DIR, node=node_bin)
    tmp = "/tmp/workboard.service"
    sio = io.StringIO()
    # 用 base64 传避免引号/换行转义问题
    b64 = __import__("base64").b64encode(unit.encode("utf-8")).decode()
    cmd = f"echo {b64} | base64 -d > {tmp} && cp {tmp} /etc/systemd/system/workboard.service && rm -f {tmp}"
    out, err = run(ssh, cmd)
    if err.strip():
        print("[stderr]", err.strip())

    print("[deploy] 启动并设置开机自启 ...")
    out, err = run(ssh, "systemctl enable --now workboard.service && systemctl restart workboard.service", timeout=120)
    if err.strip():
        print("  (enable/restart) stderr:", err.strip())

    import time
    time.sleep(3)

    print("[deploy] 校验：服务状态")
    out, _ = run(ssh, "systemctl is-active workboard.service; systemctl is-enabled workboard.service")
    print(out.strip())

    out, _ = run(ssh, "curl -s -o /dev/null -w 'HTTP:%{http_code}' --max-time 8 http://127.0.0.1:80/ ")
    print("[deploy] 本地 127.0.0.1:80 ->", out.strip())

    print("[deploy] 校验：页面内容")
    out, _ = run(ssh, "curl -s --max-time 8 http://127.0.0.1:80/ | grep -o 'shjk0817' | head -1")
    print("    contains shjk0817:", bool(out.strip()))
    out, _ = run(ssh, "curl -s --max-time 8 http://127.0.0.1:80/api/stats")
    print("    /api/stats ->", out.strip())

    ssh.close()
    print("\n[deploy] 完成。公网访问：http://" + host + "/")


if __name__ == "__main__":
    main()