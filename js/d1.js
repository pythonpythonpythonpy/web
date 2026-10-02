/**
 * js/d1.js —— Cloudflare Worker（D1 中转 API）访问封装
 *
 * 零依赖 / Node 与浏览器通用（ES Module）
 * 内置：超时、重试、分页、批量事务、字段校验、友好报错
 *
 * 令牌不写死在源码里，按下面的顺序读取（后者覆盖前者）：
 *   1. Node 环境变量 D1_BASE / D1_TOKEN
 *   2. createD1({ base, token }) 或 d1.setBase() / d1.setToken()
 *   3. 浏览器端由 js/main.js 从 config.json 注入（见 README.md）
 */

/* ============================== 配置 ============================== */

const DEFAULT_BASE = "https://d1.api.shenxv.dpdns.org";

// 浏览器里没有 process，globalThis.process 是 undefined，可选链会安全地返回 undefined
const ENV_BASE = globalThis.process?.env?.D1_BASE || "";
const ENV_TOKEN = globalThis.process?.env?.D1_TOKEN || "";

const DEFAULTS = {
  timeout: 10000,  // 单次请求超时(ms)
  retries: 2,      // 失败重试次数（0 = 不重试）
  pageSize: 100,   // iterate() 每页条数（Worker 上限 500）
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ============================== 错误 ============================== */

export class D1Error extends Error {
  constructor(message, { status = 0, route = "", body = null, attempts = 1 } = {}) {
    super(message);
    this.name = "D1Error";
    this.status = status;   // HTTP 状态码；网络层错误为 0
    this.route = route;
    this.body = body;       // Worker 返回的原始 JSON
    this.attempts = attempts;
  }

  /** 是否属于可安全重试的错误 */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** 中文排查提示 */
  get hint() {
    if (String(this.message).includes("未配置 D1 令牌")) {
      return "复制 config.example.json 为 config.json 并填写 d1.token，或设置环境变量 D1_TOKEN";
    }
    const d = String(this.message).toLowerCase();
    if (this.status === 401) return "令牌不对：客户端 D1_TOKEN ≠ Worker 变量 API_TOKEN";
    if (this.status === 403) return "权限不足：/sql 需要 admin 令牌且 Worker 里 SQL_PROXY=1";
    if (this.status === 404) return "路由或表名不存在：检查路径拼写、表名是否在 TABLE_WHITELIST 里";
    if (this.status === 429) return "D1 过载或超出额度：稍后重试，并检查索引以减少扫描行数";
    if (this.status >= 500) return "Worker 内部异常：去 设置→Observability 看实时日志";
    if (this.status === 0 || d.includes("timeout")) return "网络不通：域名未解析 / Worker 未部署 / 本机网络问题";
    return "看 body.error 字段";
  }
}

/* =========================== 内部工具 =========================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SQL 标识符校验 + 转义（防注入） */
function quoteIdent(name, what = "标识符") {
  if (typeof name !== "string" || !IDENT.test(name)) {
    throw new D1Error(`非法的${what}: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** 绑定值归一化：undefined→null，布尔→0/1，对象→JSON 字符串 */
function toBind(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

/* =========================== 工厂函数 =========================== */

/**
 * 创建一个访问实例。通常直接用下面的默认实例 `d1` 即可；
 * 需要连多个 Worker / 多套令牌时再自己调用。
 */
export function createD1(options = {}) {
  const cfg = {
    base: (options.base || ENV_BASE || DEFAULT_BASE).replace(/\/+$/, ""),
    token: options.token ?? ENV_TOKEN,
    timeout: options.timeout ?? DEFAULTS.timeout,
    retries: options.retries ?? DEFAULTS.retries,
    // bind 到 globalThis：直接把 fetch 当对象方法调用会因 this 不对而抛 Illegal invocation
    fetch: (options.fetch ?? globalThis.fetch).bind(globalThis),
  };

  /* ---------------- 底层请求：超时 + 重试 + 统一错误 ---------------- */

  function buildUrl(path, params) {
    const u = new URL(cfg.base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async function request(path, { method = "GET", body, params, retries, timeout } = {}) {
    if (!cfg.token) {
      throw new D1Error(
        "未配置 D1 令牌：请复制 config.example.json 为 config.json 并填写 d1.token（Node 下也可用环境变量 D1_TOKEN）",
        { route: path },
      );
    }

    const url = buildUrl(path, params);
    const maxAttempts = (retries ?? cfg.retries) + 1;
    const ms = timeout ?? cfg.timeout;
    const idempotent = method === "GET"; // 只有 GET 才放心自动重试

    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let err;

      try {
        const headers = {};
        if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = await cfg.fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(ms),
        });

        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* 非 JSON：多为代理层错误页 */
        }

        if (res.ok && json?.ok !== false) return json ?? { ok: true };

        err = new D1Error(json?.error || `HTTP ${res.status} ${text.slice(0, 120)}`, {
          status: res.status,
          route: path,
          body: json,
          attempts: attempt,
        });
      } catch (e) {
        err =
          e instanceof D1Error
            ? e
            : new D1Error(
                e?.name === "TimeoutError" ? `请求超时（>${ms}ms）` : String(e?.message || e),
                { status: 0, route: path, attempts: attempt },
              );
      }

      lastErr = err;

      // 429 一定没被执行；5xx / 网络错误只对幂等请求重试
      const canRetry =
        attempt < maxAttempts && (err.status === 429 || (idempotent && err.retryable));
      if (!canRetry) throw err;

      await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200); // 指数退避 + 抖动
    }

    throw lastErr;
  }

  /* -------------------------- 健康 / 元信息 -------------------------- */

  /** 健康检查 */
  const health = () => request("/", { retries: 1 });

  /** 列出所有表名 */
  const tables = async () => (await request("/tables")).tables ?? [];

  /** 读取全部表结构：{ 表名: [{cid,name,type,notnull,dflt_value,pk}, ...] } */
  const schema = async () => (await request("/schema")).schema ?? {};

  /* ----------------------------- 查询 ----------------------------- */

  function whereParams(where) {
    const out = {};
    if (!where) return out;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      quoteIdent(k, "字段名");
      out[`where[${k}]`] = v;
    }
    return out;
  }

  /** 分页查询，返回完整信息：{ data, limit, offset, meta } */
  async function selectPage(table, { where, order, limit = 20, offset = 0, fields } = {}) {
    quoteIdent(table, "表名");
    const params = { limit, offset, ...whereParams(where) };
    if (order) params.order = order; // 例："-id" 表示按 id 倒序
    if (fields) params.fields = Array.isArray(fields) ? fields.join(",") : fields;

    const body = await request(`/data/${encodeURIComponent(table)}`, { params });
    return {
      data: body.data ?? [],
      limit: body.limit ?? limit,
      offset: body.offset ?? offset,
      meta: body.meta ?? null, // { rows_read, duration_ms, served_by_region }
    };
  }

  /** 查询多行，只返回数组（最常用） */
  const select = async (table, opts) => (await selectPage(table, opts)).data;

  /** 按主键取一行；不存在返回 null */
  async function getOne(table, id) {
    quoteIdent(table, "表名");
    try {
      return (await request(`/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}`)).data ?? null;
    } catch (e) {
      if (e instanceof D1Error && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * 流式遍历全表（异步生成器）
   * for await (const row of d1.iterate("raw_data", { order: "-id" })) { ... }
   */
  async function* iterate(table, { pageSize = DEFAULTS.pageSize, offset = 0, ...opts } = {}) {
    let cursor = offset;
    for (;;) {
      const page = await selectPage(table, { ...opts, limit: pageSize, offset: cursor });
      for (const row of page.data) yield row;
      if (page.data.length < pageSize) return;
      cursor += page.data.length;
    }
  }

  /* ----------------------------- 写入 ----------------------------- */

  /** 插入一行；返回 { lastRowId, changes } */
  async function insert(table, row) {
    quoteIdent(table, "表名");
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new D1Error("insert(table, row) 的 row 必须是普通对象");
    }
    const body = await request(`/data/${encodeURIComponent(table)}`, {
      method: "POST",
      body: row,
      retries: 0, // 不做自动重试，避免重复插入
    });
    return { lastRowId: body.last_row_id ?? null, changes: body.changes ?? 1 };
  }

  /** 更新一行；返回 { changes, row } */
  async function update(table, id, patch) {
    quoteIdent(table, "表名");
    const body = await request(`/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
      retries: 0,
    });
    return { changes: body.changes ?? 0, row: body.data ?? null };
  }

  /** 删除一行；返回 { changes } */
  async function remove(table, id) {
    quoteIdent(table, "表名");
    const body = await request(`/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      retries: 0,
    });
    return { changes: body.changes ?? 0 };
  }

  /* -------------------------- 批量 / 事务 -------------------------- */

  /** 事务批处理：任一失败全部回滚；最多 50 条 */
  async function batch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new D1Error("batch() 需要非空的语句数组");
    }
    if (statements.length > 50) {
      throw new D1Error("单个 batch 最多 50 条语句，请自行分片");
    }
    const body = await request("/batch", { method: "POST", body: { statements }, retries: 0 });
    return body.data ?? [];
  }

  /** 批量插入：自动按 50 条分片、走事务 */
  async function insertMany(table, rows, { chunkSize = 50, onConflict = "" } = {}) {
    quoteIdent(table, "表名");
    if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, results: [] };

    const results = [];
    let inserted = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const stmts = rows.slice(i, i + chunkSize).map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new D1Error("insertMany 的元素必须是普通对象");
        }
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        if (keys.length === 0) throw new D1Error("insertMany 中存在空对象");
        keys.forEach((k) => quoteIdent(k, "字段名"));
        return {
          sql:
            `INSERT INTO ${quoteIdent(table)} (${keys.map((k) => quoteIdent(k)).join(", ")}) ` +
            `VALUES (${keys.map(() => "?").join(", ")}) ${onConflict}`.trim(),
          params: keys.map((k) => toBind(row[k])),
        };
      });
      const res = await batch(stmts);
      results.push(...res);
      inserted += res.filter((r) => r?.success !== false).length;
    }
    return { inserted, results };
  }

  /* ------------- 任意 SQL（需 Worker 开 SQL_PROXY=1 + admin 令牌） ------------- */

  async function sql(statement, params = []) {
    const body = await request("/sql", {
      method: "POST",
      body: { sql: statement, params },
      retries: 0,
    });
    return { rows: body.data ?? [], meta: body.meta ?? null };
  }

  /** 统计行数（依赖 sql()） */
  async function count(table, where) {
    quoteIdent(table, "表名");
    const keys = where ? Object.keys(where).filter((k) => where[k] !== undefined) : [];
    keys.forEach((k) => quoteIdent(k, "字段名"));
    const clause = keys.length
      ? ` WHERE ${keys.map((k) => `${quoteIdent(k)} = ?`).join(" AND ")}`
      : "";
    const { rows } = await sql(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${clause}`,
      keys.map((k) => toBind(where[k])),
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  return {
    config: cfg,
    /** 运行期设置连接地址 / 令牌（浏览器端由 main.js 从 config.json 注入） */
    setBase(base) {
      if (base) cfg.base = String(base).replace(/\/+$/, "");
    },
    setToken(token) {
      cfg.token = token ? String(token) : "";
    },
    request,      // 逃生舱：直接打任意路径
    health,
    tables,
    schema,
    select,
    selectPage,
    getOne,
    iterate,
    insert,
    update,
    remove,
    batch,
    insertMany,
    sql,
    count,
  };
}

/* ======================= 默认实例 & raw_data 封装 ======================= */

export const d1 = createD1();

const TABLE = "raw_data";
const STR_FIELD = ["status"];
const NUM_FIELD = [
  ["longitude", -180, 180],
  ["latitude", -90, 90],
];

/**
 * 规格化一条记录（对齐表结构 id/status/longitude/latitude/created_at）
 * - id、created_at 由数据库自动生成，客户端默认不传
 * - 经纬度强转数字并做范围校验，且必须成对出现
 * @param {object} input
 * @param {boolean} partial 为 true 时允许只给部分字段（更新场景）
 */
function normalize(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new D1Error("记录必须是普通对象，例如 { status, longitude, latitude }");
  }

  const row = {};

  for (const key of STR_FIELD) {
    const v = input[key];
    if (v === undefined || v === null || v === "") continue;
    row[key] = String(v);
  }

  for (const [key, min, max] of NUM_FIELD) {
    const v = input[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new D1Error(`${key} 不是合法数字: ${JSON.stringify(v)}`);
    if (n < min || n > max) throw new D1Error(`${key} 超出 [${min}, ${max}]: ${n}`);
    row[key] = n;
  }

  const hasLng = row.longitude !== undefined;
  const hasLat = row.latitude !== undefined;
  if (hasLng !== hasLat) throw new D1Error("longitude 与 latitude 必须成对提供");

  // 仅补录历史数据时才显式指定 created_at
  if (input.created_at !== undefined && input.created_at !== null && input.created_at !== "") {
    row.created_at = String(input.created_at);
  }

  if (!partial && Object.keys(row).length === 0) {
    throw new D1Error("至少要提供 status / longitude / latitude 之一");
  }
  return row;
}

export const rawData = {
  name: TABLE,

  /* ---------------------------- 写入 ---------------------------- */

  /** 写入一条：{ status?, longitude?, latitude? }；返回 { lastRowId, changes } */
  async add(record = {}) {
    const row = normalize(record);
    return d1.insert(TABLE, row);
  },

  /** 插入一条"纯心跳"（所有业务字段留空，靠数据库默认值） */
  async heartbeat() {
    const res = await d1.batch([{ sql: `INSERT INTO ${quoteIdent(TABLE)} DEFAULT VALUES` }]);
    return { lastRowId: res[0]?.meta?.last_row_id ?? null, changes: 1 };
  },

  /** 批量写入：自动 50 条一片、走事务；返回 { inserted, results } */
  addMany(records) {
    if (!Array.isArray(records)) throw new D1Error("addMany(records) 需要数组");
    return d1.insertMany(TABLE, records.map((r) => normalize(r)));
  },

  /** CSV 导入：每行 "latitude,longitude,status" */
  addCSV(text) {
    const records = String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((line) => {
        const [latitude, longitude, status] = line.split(",").map((s) => s.trim());
        return { latitude, longitude, status };
      });
    return rawData.addMany(records);
  },

  /* ---------------------------- 查询 ---------------------------- */

  /** 最新 n 条（按 id 倒序，走主键索引，扫描行数最少） */
  latest: (n = 20) => d1.select(TABLE, { order: "-id", limit: n }),

  /** 按 id 取一条；不存在返回 null */
  get: (id) => d1.getOne(TABLE, id),

  /** 按 status 筛选最新 n 条 */
  byStatus: (status, n = 100) => d1.select(TABLE, { where: { status }, order: "-id", limit: n }),

  /** 地图 / 轨迹用：只取必要字段，返回时间正序 */
  coords: async (n = 500) => {
    const rows = await d1.select(TABLE, {
      order: "-id",
      limit: n,
      fields: ["id", "status", "latitude", "longitude", "created_at"],
    });
    return rows.reverse();
  },

  /** 全表流式遍历（不一次性载入内存） */
  iterate: (opts) => d1.iterate(TABLE, opts),

  /* ------------------- 以下三个需要 SQL_PROXY=1 ------------------- */

  /** 时间区间查询（ISO 字符串，如 "2026-10-02T00:00:00Z"） */
  async range(from, to, limit = 1000) {
    const { rows } = await d1.sql(
      `SELECT * FROM ${quoteIdent(TABLE)}
        WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
        ORDER BY created_at DESC LIMIT ?`,
      [from, to, limit],
    );
    return rows;
  },

  /** 最近 N 分钟的记录 */
  async since(minutes = 60, limit = 1000) {
    const { rows } = await d1.sql(
      `SELECT * FROM ${quoteIdent(TABLE)}
        WHERE datetime(created_at) >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT ?`,
      [`-${Number(minutes)} minutes`, limit],
    );
    return rows;
  },

  /** 总数，或按 status 计数 */
  count: (status) => (status === undefined ? d1.count(TABLE) : d1.count(TABLE, { status })),

  /* ---------------------------- 维护 ---------------------------- */

  /** 更新一条（一般只改 status）；返回 { changes, row } */
  set(id, patch) {
    const row = normalize(patch, { partial: true });
    if (Object.keys(row).length === 0) throw new D1Error("set(id, patch) 没有可更新字段");
    return d1.update(TABLE, id, row);
  },

  /** 删除一条；返回 { changes } */
  del: (id) => d1.remove(TABLE, id),

  /** 清理超过 N 天的旧数据（需 SQL_PROXY，且 Worker 要允许写 SQL） */
  purge(days = 30) {
    return d1.sql(
      `DELETE FROM ${quoteIdent(TABLE)} WHERE datetime(created_at) < datetime('now', ?)`,
      [`-${Number(days)} days`],
    );
  },
};

/* ============================== 自检 ============================== */

/** 手动调用：await selfTest({ write: true }) */
export async function selfTest({ write = false } = {}) {
  const line = "─".repeat(56);
  console.log(`\n🔎 d1.js 自检  ${d1.config.base}\n${line}`);

  let failed = 0;
  const step = async (label, fn) => {
    try {
      console.log(`✅ ${label}  ${await fn()}`);
    } catch (e) {
      failed++;
      console.log(`❌ ${label}  ${e.message}${e.hint ? `\n   → ${e.hint}` : ""}`);
    }
  };

  await step("health", async () => {
    const r = await d1.health();
    return `service=${r.service} role=${r.role}`;
  });

  await step("tables", async () => (await d1.tables()).join(", ") || "(空库)");

  await step("schema.raw_data", async () => {
    const s = await d1.schema();
    const cols = (s[TABLE] ?? []).map((c) => `${c.name}:${c.type || "?"}`);
    if (cols.length === 0) throw new D1Error("raw_data 表不存在，或不在 TABLE_WHITELIST 中");
    return cols.join(", ");
  });

  await step("最新 3 条", async () => {
    const rows = await rawData.latest(3);
    if (rows.length === 0) return "表存在但暂无数据";
    return rows.map((r) => `#${r.id} ${r.status ?? "-"}`).join(" | ");
  });

  if (write) {
    let probeId = null;

    await step("写入探针", async () => {
      const { lastRowId } = await rawData.add({
        status: "selftest",
        longitude: 116.397,
        latitude: 39.908,
      });
      probeId = lastRowId;
      return `id=${lastRowId}（created_at 由数据库生成）`;
    });

    await step("读回探针", async () => {
      if (probeId == null) return "上一步失败，跳过";
      const row = await rawData.get(probeId);
      if (!row) throw new D1Error(`取不到 id=${probeId}`);
      return `created_at=${row.created_at} status=${row.status}`;
    });

    await step("更新探针", async () => {
      if (probeId == null) return "上一步失败，跳过";
      const { changes } = await rawData.set(probeId, { status: "selftest-updated" });
      return `改动 ${changes} 行`;
    });

    await step("删除探针", async () => {
      if (probeId == null) return "上一步失败，跳过";
      const { changes } = await rawData.del(probeId);
      return `已删除 ${changes} 行`;
    });
  } else {
    console.log("⚪ 写入 / 读回 / 更新 / 删除 已跳过（加 --write 开启）");
  }

  console.log(`${line}\n${failed === 0 ? "🎉 全部通过" : `💥 ${failed} 项失败`}\n`);
  return failed;
}

/* ------------------- 直接运行本文件时自动自检 ------------------- */
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  !!process.argv[1] &&
  /[\\/]d1\.js$/.test(process.argv[1]);

if (isDirectRun) {
  // 先读项目根目录的 config.json，再用环境变量覆盖
  try {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
    if (raw?.d1?.base) d1.setBase(raw.d1.base);
    if (raw?.d1?.token) d1.setToken(raw.d1.token);
  } catch {
    // 没有 config.json 就只用环境变量
  }
  if (process.env.D1_BASE) d1.setBase(process.env.D1_BASE);
  if (process.env.D1_TOKEN) d1.setToken(process.env.D1_TOKEN);

  const failed = await selfTest({ write: process.argv.includes("--write") });
  process.exit(failed ? 1 : 0); // 顺手消掉 Node 24 on Windows 的断言噪音
}