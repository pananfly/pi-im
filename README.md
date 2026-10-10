# pi-im
Pi 双通道 IM 插件:飞书 + Telegram,共享主会话,pi-web holder 常驻。
- 安装: `pi install npm:pi-im`
- 配置: `~/.pi/agent/pi-im/{feishu.json,telegram.json}`
- 预热: `node scripts/pi-web-warmup.mjs --cwd <holder目录> --port 30141`
- Windows 无需 Git Bash,任务计划程序开机跑 pi-web + warmup。
