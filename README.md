# WorkBoard · 个人工作台

蓝白商业风格的个人工作安排 + GitHub 热力图 + 项目目标/进度/成果 Web 应用。

## 功能

| 模块 | 说明 |
|------|------|
| 📊 **统计概览** | 工作安排、项目、成果文件、今日待办 四维卡片 |
| 🔥 **活跃热力图** | 365 天 GitHub 贡献 + 本地活跃度双源聚合，蓝色系色阶 |
| 📋 **工作安排** | 每日待办/已完成，支持标记完成、编辑、删除 |
| 🎯 **项目进度** | 目标管理、进度百分比、进展日志，拖拽式进度条 |
| 📎 **成果文件** | 文件上传（最大 50MB）、关联项目、下载 |
| 🐙 **GitHub 卡片** | 仓库卡片展示，自动识别语言/Star/描述，支持封面上传 |
| 🔒 **管理后台** | 密码登录，`/manage` 路径，所有操作实时写入 |

## 技术栈

- **后端**：Node.js + Express
- **前端**：原生 HTML/CSS/JS（零框架依赖）
- **数据**：JSON 文件存储（`data/db.json`）
- **部署**：systemd + Python paramiko 自动部署脚本
- **集成**：GitHub REST API（仓库元信息 + 贡献日历）

## 快速开始

```bash
# 安装依赖
npm install

# 启动（默认端口 80）
npm start

# 或指定端口
PORT=3000 npm start
```

- 展示页：`http://localhost/`
- 管理页：`http://localhost/manage`
- 默认管理密码：环境变量 `ADMIN_PASSWORD` 或 `Ifiwant0`

## 项目结构

```
workboard/
├── server.js          # Express 后端（API + 静态文件）
├── package.json
├── public/
│   ├── index.html     # 展示页
│   ├── manage.html    # 管理后台
│   ├── css/main.css   # 蓝白商业风格样式
│   └── js/app.js      # 前端渲染逻辑
├── deploy/
│   └── deploy.py      # SSH 自动部署脚本
├── data/              # 运行时数据（gitignore）
│   ├── db.json
│   └── uploads/
└── DEPLOY.md          # 部署教程（AI 版）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `80` | 服务端口 |
| `ADMIN_PASSWORD` | `Ifiwant0` | 管理后台登录密码 |
| `GITHUB_USER` | `shjk0817` | 热力图聚合的 GitHub 用户名 |

## License

MIT