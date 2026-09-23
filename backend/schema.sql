-- 抄经应用数据库结构（SQLite）
-- users: 注册用户（推荐码准入后创建）
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname    TEXT,
  invite_code TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- invite_codes: 推荐码池（code 唯一）
CREATE TABLE IF NOT EXISTS invite_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  created_by  TEXT,
  used_count  INTEGER DEFAULT 0,
  max_uses    INTEGER DEFAULT 0,  -- 0 表示不限次数
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- sutras: 经文库（id 为种子数据中的字符串 id）
CREATE TABLE IF NOT EXISTS sutras (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  tradition   TEXT NOT NULL,      -- buddhist | taoist
  intro       TEXT,
  full_text   TEXT,               -- 金刚经等长经暂为 NULL，待补充
  music_config TEXT,              -- JSON：{root_midi, tempo_bpm, timbre, mood}
  like_count  INTEGER DEFAULT 0
);

-- likes: 点赞记录（同一用户对同一经文只记一次）
CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sutra_id    TEXT NOT NULL,
  user_id     INTEGER,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (sutra_id, user_id)
);

-- comments: 留言（kind: text | audio | image | video）
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sutra_id    TEXT NOT NULL,
  user_id     INTEGER,
  kind        TEXT NOT NULL DEFAULT 'text',
  body        TEXT,               -- 文字留言内容
  file_url    TEXT,               -- 音/图/视频文件地址
  created_at  TEXT DEFAULT (datetime('now'))
);

-- copy_progress: 抄写进度（0~1）
CREATE TABLE IF NOT EXISTS copy_progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sutra_id    TEXT NOT NULL,
  user_id     INTEGER,
  progress    REAL DEFAULT 0,
  chars_done  INTEGER DEFAULT 0,
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (sutra_id, user_id)
);
