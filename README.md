# dsh-diary · 长期记忆插件

让 dsh 的所有会话都能「记得长时间记忆」：零压缩保留原始对话，并能在任意会话想起以前的所有消息。

## 它做什么

1. **每轮原始对话落盘（所有会话）**：大肥鱼每回复完一轮，就把这一轮你和「大肥鱼」的原始文字追加进当天的一个 JSONL 文件。
   - 只记聊天文本，**不记工具调用过程**（生图/查资料等的内部步骤不存）。
   - 每条带 `sessionId` 与本地时区时间戳；每轮异步落盘，崩了最多丢正在飞的一两条。

2. **今日实时分块摘要**：每凑够 N 条有文本的消息（默认 5 条）就把这一段压成一份分块摘要，追加进当天的 digest 文件。
   - 还没凑够的那几条只躺在 JSONL 里，**换会话时会一并带上**（只补当天，不回溯昨天——否则第二天早上开的新会话会莫名其妙带上昨晚睡前的话）。

3. **每天 00:10 封章（或启动补偿）**：把**过去那一天**的原始对话生成一份当日 md（确定性原文 + AI 标注的「你 / 大肥鱼」双方情绪变化），同时生成「30 天表」的**关键词列**。
   - 时点放在 00:10 而不是 23:00：23 点封章等于亲手扔掉 23:00–24:00 那一小时，而且此后补偿看到「已封」会直接跳过，永远补不上。

4. **开场注入「记忆索引」**（四块，都是纯读文件、不调模型）：
   - **最近 30 天的日期表**：一行一天，格式 `MM-DD 周X  起–止  关键词串`；没有记录的日子不占行。用来回答「这事我们是不是聊过、是哪天」。
   - **今天的摘要全文**：今天到目前为止的分块摘要，不截断、不压缩。
   - **今天还没进摘要的尾巴**：分块摘要每凑够 N 条才压一块，剩下那几条只躺在 JSONL 里，换会话时按**原话**一并带上。
     注意**只补当天、不回溯昨天**——否则第二天早上开的每个新会话都会莫名带上昨晚睡前那几句。
   - **命中的旧对话**：被动召回命中时才出现（见下面第 5 条）。
   > 早先那版「最近 7 天轻压缩」**已废弃**——它把摘要压了第二遍，还会砍掉早上的内容
   > （实测某天 9800 字只留了末尾 6000 字，上午到下午整段没进模型眼睛）。

5. **双路召回 + 按日期开门**：
   - **被动**——用户发消息时自动拿关键词匹配索引/日记，命中旧片段即补入上下文，并展开同义词（「下水」→「走出去 / 试水 / 水温」）。
   - **主动 `diary`**——传关键词，在最近 30 天的分块摘要里找命中的块。
   - **主动 `diary_open`**——按日期开门；用户说得出具体哪天（「昨天」「11月1号」「上周六」）时它比关键词更准。

## 环境要求

| 项 | 要求 |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=20` |
| 可选 | Python + Pillow（仅用于图片压缩；缺了不影响其余功能） |

`@deepseek-ai/*` 全部由 dsh 宿主提供，**不要自行安装**。

## 安装

### 方式一：本地包安装（拿到 `.tgz` 时用这个）

1. 解压到插件目录（路径随意，这里以 `D:\DDSH_Plugins\dsh-diary` 为例）：

   ```powershell
   mkdir D:\DDSH_Plugins\dsh-diary
   tar -xzf dsh-diary-1.0.0.tgz -C D:\DDSH_Plugins\dsh-diary --strip-components=1
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，加两处：

   ```json
   "dependencies": {
     "dsh-diary": "link:D:/DDSH_Plugins/dsh-diary"
   },
   "dsh": {
     "profile": {
       "bundles": [
         "dsh-diary"
       ]
     }
   }
   ```

   - `dependencies` 里的 `link:` 指向第 1 步解压出来的目录。
   - `bundles` 数组把 `"dsh-diary"` 加进去（放在列表里靠前位置即可）。

3. 重启 dsh。启动日志出现下面这行就算接上了：

   ```
   dsh-diary: applied, watching all sessions.
   ```

### 方式二：从 npm 装（该包已发布时）

在 dsh 的插件管理里搜索 `dsh-diary` 添加即可。

### Python（可选）

图片压缩由 `lib/compress_image.py`（Pillow）完成。解释器按以下顺序定位：

1. 环境变量 `DSH_PYTHON`
2. dsh 自带运行时 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`
3. 系统 `python3` / `python`

全都找不到时，图片不压缩、**原始文本照常记录**，其余功能不受影响。

## 防崩设计（来自对崩溃插件的复盘）

- `inject` 只写真实存在的服务 `'llm'`，**绝不写顶层不存在的 `systemPrompt`**（那会让 dsh 加载失败）。
- 注入走 `agent.ctx.systemPrompt.section(...)`，不是 `ctx.systemPrompt`。
- **注入文本必须是同步字符串**：`PromptSection.text` 不接受 Promise，返回 Promise 会被当成空、注入永远失效。所以摘要在后台异步算好、同步读出（这是踩过的历史 bug）。
- 所有监听器全异步 + `try/catch`，异常一律吞掉，**绝不冒泡**（防「家打不开」类崩溃）。
- 日期一律本地时区，**不用 `toISOString()` 切片**（避免 +8 区跨日错位）。
- 存储独立 `~/.dsh/diary/`，**不碰 `.memory`**（不会污染 dsh-plugin-memory）。
- 00:10 用 `setTimeout` 自调度，**不引入 node-cron**。
- 转换健康检查：jsonl→md 若失败，源文件保留不删、写 `health.json` 告警、下次自动重试——**不会出现「一直出错但记忆全白存」**。

## 目录结构（默认 `~/.dsh/diary`）

```
~/.dsh/diary/
├── tmp/
│   ├── {YYYYMMDD}.jsonl          当天每轮原始对话，一行一条
│   ├── {YYYYMMDD}.digest.md      今日实时分块摘要
│   └── .digest-state.json        分块摘要的续跑状态
├── {YYYY}/{MM}/
│   └── {YYYYMMDD}.md             当日日报（原文 + 情绪变化）
├── keywords.json                 30 天表的关键词列（一天一行，封章时写）
├── state.json                    已封章日期 + 各天状态（补偿标记）
└── health.json                   转换/封章健康告警
```

图片另存（默认 `D:/DDSH_Diary/media/{YYYYMMDD}/`，按日期分目录，保留 `mediaKeepDays` 天，超期自动清）。

> **已废弃的旧路径**：`daily-diary{YYYYMM}.md` 与 `index{YYYYMM}.md` 这两个月度汇总文件自 2026-11-02 定稿起不再写入
> （检索改走分块摘要 + `diary_open`）；`cache/7day-*.md` 也不再产生。旧文件留着只为兼容读取。

## 配置项（写入插件配置）

| 项 | 默认 | 说明 |
|---|---|---|
| `diaryDir` | `~/.dsh/diary` | 存储根目录 |
| `mediaDir` | `D:/DDSH_Diary/media` | 图片存放根目录（与文本日记分开，便于单独搬迁） |
| `mediaKeepDays` | `90` | 图片保留天数 |
| `incomingMediaDirs` | `~/.dsh-qqbot/media` | 待压缩的图片来路目录（可多个） |
| `enableMood` | `true` | 封章时 AI 情绪标注 |
| `enableKeywords` | `true` | 封章时生成 30 天表的关键词列 |
| `injectTable` | `true` | 开场注入「最近 30 天表」 |
| `injectToday` | `true` | 开场注入「今天的摘要全文」 |
| `injectTail` | `true` | 开场注入「今天还没进摘要的尾巴」（原话） |
| `injectSubagents` | `false` | 是否给工具型子代理也注入索引、并注册检索工具（默认关，避免一回合几十次 LLM） |
| `tableDays` | `30` | 表覆盖多少天 |
| `enableDigest` | `true` | 今日实时分块摘要 |
| `digestChunk` | `5` | 每 N 条有文本的消息做一次分块摘要 |
| `reviewHour` | `0` | 封章时点·时（本地时区） |
| `reviewMinute` | `10` | 封章时点·分（本地时区） |
| `fallbackTarget` | `null` | 取不到 provider/model 时的兜底 `{provider,model}` |

## 工具

- **`diary`** —— 关键词检索：想不起是哪天时用，在最近 30 天的分块摘要里找命中的块。
- **`diary_open`** —— 按日期开门：说得清具体哪天（昨天 / 前天 / 11月1号 / 上周六）时用它，比关键词搜更准。

## License

MIT
