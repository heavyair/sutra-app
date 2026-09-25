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
  tradition   TEXT NOT NULL,      -- buddhist | taoist | custom（用户上传）
  intro       TEXT,
  full_text   TEXT,               -- 金刚经等长经暂为 NULL，待补充
  music_config TEXT,              -- JSON：{root_midi, tempo_bpm, timbre, mood}
  like_count  INTEGER DEFAULT 0,
  user_id     INTEGER,            -- 上传者（种子经文为 NULL）
  visibility  TEXT DEFAULT 'public', -- public | private（仅上传者可见）
  source      TEXT DEFAULT 'seed',   -- seed | upload
  created_at  TEXT DEFAULT (datetime('now')),
  size_bytes  INTEGER DEFAULT 0,  -- full_text 字节数（配额用）
  deleted     INTEGER DEFAULT 0  -- 软删除：从经文库隐藏，已有抄经作品不受影响
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

-- works: 抄经作品（一部作品 = 一次抄经）
--   匿名作品公开，任何人可看可续写可改；注册用户作品默认私有，可分享
CREATE TABLE IF NOT EXISTS works (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sutra_id    TEXT NOT NULL,
  title       TEXT,
  font_id     TEXT,
  owner_type  TEXT NOT NULL DEFAULT 'anon',  -- 'anon' | 'user'
  owner_id    INTEGER,
  anon_key    TEXT,                          -- 匿名作者的认领 key（存浏览器 localStorage）
  is_public   INTEGER NOT NULL DEFAULT 1,
  share_token TEXT,                          -- 注册用户分享链接 token
  audio_path  TEXT,                          -- 写字时录制的音乐文件
  chars_total INTEGER DEFAULT 0,
  chars_done  INTEGER DEFAULT 0,
  completed_at TEXT,                          -- 完成时间
  farewell_at   TEXT,                          -- 焚化时刻（NULL=不焚化）；清理脚本只看此列
  farewell_mode TEXT,                          -- 去向：keep=私藏 | public=陈列 | cremate=焚化
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_works_owner ON works(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_works_public ON works(is_public, updated_at);

-- work_chars: 每个字最小存储单位，保留落笔记录，可回放
CREATE TABLE IF NOT EXISTS work_chars (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id    INTEGER NOT NULL,
  pos        INTEGER NOT NULL,
  ch         TEXT NOT NULL,
  pen        TEXT,
  strokes    TEXT NOT NULL,   -- JSON：{pen, strokes:[[[x,y,t,w]...]]} 或 {auto:'punct'}
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (work_id, pos)
);
CREATE INDEX IF NOT EXISTS idx_work_chars_work ON work_chars(work_id);
