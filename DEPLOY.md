# WorkBoard 部署教程（AI 版本）

> 本文档为 AI Agent 自动部署 WorkBoard 的完整操作指南。每步均可独立执行，出错有明确回退路径。

## 前置条件

| 条件 | 检查命令 |
|------|----------|
| 目标服务器可 SSH 访问 | `ssh root@<IP> "echo ok"` |
| 服务器已安装 Node.js ≥ 18 | `ssh root@<IP> "node -v"` |
| 服务器已安装 npm | `ssh root@<IP> "npm -v"` |
| 服务器已安装 systemd（Linux） | `ssh root@<IP> "systemctl --version"` |
| 本地已安装 Python 3 + paramiko | `pip install paramiko` |

## 方案 A：一键部署（推荐）

使用项目自带的 `deploy/deploy.py`，自动完成代码同步、依赖安装、systemd 配置、启动校验。

```bash
# 1. 安装本地依赖
pip install paramiko

# 2. 修改 deploy/deploy.py 中的连接信息（如需要）
#    HOST = "你的服务器 IP"
#    USER = "root"
#    PASSWORD = "你的密码"

# 3. 执行部署
python deploy/deploy.py

# 或指定目标服务器
python deploy/deploy.py --host 192.168.1.100
```

部署脚本会自动：
1. SSH 连接目标服务器
2. 创建 `/opt/workboard` 目录结构
3. 上传所有代码和静态资源
4. 执行 `npm install --omit=dev`
5. 写入 systemd 单元文件
6. 启动服务并设置开机自启
7. 校验 HTTP 200 响应

## 方案 B：手动部署

### Step 1：上传代码

```bash
# 在服务器上创建目录
ssh root@<IP> "mkdir -p /opt/workboard/public/css /opt/workboard/public/js /opt/workboard/data/uploads /opt/workboard/deploy"

# 上传文件
scp server.js package.json package-lock.json root@<IP>:/opt/workboard/
scp -r public/* root@<IP>:/opt/workboard/public/
```

### Step 2：安装依赖

```bash
ssh root@<IP> "cd /opt/workboard && npm install --omit=dev"
```

### Step 3：配置 systemd

```bash
ssh root@<IP> "cat > /etc/systemd/system/workboard.service << 'EOF'
[Unit]
Description=WorkBoard - personal work dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/workboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=80
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF"
```

### Step 4：启动服务

```bash
ssh root@<IP> "systemctl daemon-reload && systemctl enable --now workboard.service"
```

### Step 5：验证

```bash
# 检查服务状态
ssh root@<IP> "systemctl status workboard.service"

# 验证 HTTP 响应
curl -s -o /dev/null -w '%{http_code}' http://<IP>/

# 验证 API
curl -s http://<IP>/api/stats
```

## 环境变量配置

如需修改默认配置，编辑 `/etc/systemd/system/workboard.service` 中的 `Environment` 行：

```ini
Environment=PORT=80
Environment=NODE_ENV=production
Environment=ADMIN_PASSWORD=你的密码
Environment=GITHUB_USER=shjk0817
```

修改后重载：

```bash
ssh root@<IP> "systemctl daemon-reload && systemctl restart workboard.service"
```

## 更新部署

后续代码更新只需：

```bash
# 方案 A：重新运行部署脚本
python deploy/deploy.py

# 方案 B：手动同步 + 重启
scp server.js root@<IP>:/opt/workboard/
scp -r public/* root@<IP>:/opt/workboard/public/
ssh root@<IP> "systemctl restart workboard.service"
```

## 故障排查

| 问题 | 排查命令 |
|------|----------|
| 服务无法启动 | `ssh root@<IP> "journalctl -u workboard.service -n 50"` |
| 端口被占用 | `ssh root@<IP> "ss -tlnp \| grep :80"` |
| 权限不足 | 确保以 root 或 sudo 执行，`/opt/workboard` 属主正确 |
| Node.js 版本过低 | `ssh root@<IP> "node -v"`，需 ≥ 18 |
| 防火墙拦截 | `ssh root@<IP> "ufw allow 80/tcp"` 或对应云服务商安全组放行 |

## 安全建议

1. **修改默认密码**：通过 `ADMIN_PASSWORD` 环境变量设置强密码
2. **HTTPS**：建议前置 Nginx/Caddy 反向代理并配置 SSL
3. **防火墙**：仅开放 80/443 端口
4. **数据备份**：定期备份 `/opt/workboard/data/` 目录