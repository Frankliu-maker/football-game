# ⚽ 2D 俯视角足球小游戏（5v5）

课程作业项目：Canvas 前端游戏 + Node.js 零依赖后端。

## 项目结构

```
FootballGame/
├── server.js          # 后端服务器（Node.js 原生 http，无需安装依赖）
├── package.json       # 项目信息与启动脚本
├── data/
│   └── matches.json   # 比赛记录存储（首次保存比分时自动生成）
└── public/            # 前端静态页面
    ├── index.html     # 页面骨架 + 计分板 + 历史战绩面板
    ├── style.css      # 样式
    └── game.js        # 游戏核心逻辑（Canvas 渲染、物理、AI、计分）
```

## 运行方式

```bash
node server.js
# 打开浏览器访问 http://localhost:3000
```

## 玩法

- **5v5** 对抗，每队 1 名守门员（GK）+ 4 名场上球员
- 你控制**蓝队 10 号**（双层黄色呼吸光圈 + 头顶箭头标记）
- **W/A/S/D** 移动，**空格** 射门，**E / Shift** 传球给最靠前的队友
- 球权机制：碰到球即可粘性带球（球吸附在身前）；贴身对方持球队员即完成抢断；
  对方球员贴身也能捅走你的球
- 其余 9 名球员由简单 AI 驱动：每队离球最近的一名球员追球/带球/射门，
  守门员守门并在球进入禁区时出击解围，其余球员随球保持阵型
- 每局 **5 分钟**，进球后自动重置开球，结束后弹出结果并**自动把比分上报后端**

## 后端 API

| 方法 | 路径            | 说明                                   |
| ---- | --------------- | -------------------------------------- |
| GET  | `/api/matches`  | 查询全部历史比分（最多保留 100 条）    |
| POST | `/api/matches`  | 保存一条比分 `{ "blue": 2, "red": 1 }` |
| GET  | `/api/stats`    | 统计：总场次 / 胜 / 负 / 平 / 总进球   |

数据以 JSON 文件形式持久化在 `data/matches.json`。

## 部署到 Render

服务器端口已自适应环境变量（`process.env.PORT || 3000`），可直接部署：

1. 把项目推送到 GitHub 仓库
2. 在 Render 控制台 **New → Web Service**，选择该仓库
3. 配置：
   - **Runtime**: Node
   - **Build Command**: 留空（零依赖，无需安装）
   - **Start Command**: `node server.js`
4. 创建后 Render 会自动注入 `PORT` 环境变量，访问分配的公网地址即可

> 注意：Render 免费版使用临时文件系统，`data/matches.json` 在重新部署后会重置；
> 如需持久化战绩可挂载 Render 磁盘（Persistent Disk）或改用数据库。
