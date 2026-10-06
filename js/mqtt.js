/**
 * js/mqtt.js —— 通过 WebSocket 连接 MQTT 服务器
 *
 * 把订阅到的消息显示在「原始数据」卡片里，并把符合 raw_data 结构的消息写入数据库。
 * 写库前会先查数据库：这一秒已经有记录了就跳过，避免设备重复上报写入重复数据。
 * status 为 dangerous（危险）的消息例外，直接入库，不受「同一秒只写一条」限制。
 *
 * 注意：网页里只能用 WebSocket 接入 MQTT，所以要使用 EMQX 的
 *       “WebSocket over TLS/SSL 端口 8084”，地址形如 wss://xxx:8084/mqtt。
 *
 * 账号密码来自 config.json（见 README.md），不再写死在源码里。
 */

import { rawData } from './d1.js';
import { parseDbTime } from './time.js';

const rawDataEl = document.getElementById('raw-data');
const statusEl = document.getElementById('mqtt-status');
const connectBtn = document.getElementById('mqtt-connect');

// 只有带这些业务字段的消息才入库，避免把无关主题的垃圾数据写进数据库
const RAW_FIELDS = ['status', 'longitude', 'latitude'];

// 紧急状态：这些消息不受「同一秒只写一条」限制，直接入库
const URGENT_STATUS = ['dangerous'];

let client = null; // 当前的 MQTT 客户端，未连接时为 null
let config = null; // 由 main.js 传入的连接配置
let hasConnected = false; // 是否成功连接过（用来区分“连不上”和“连上后掉线”）

// 写入限流：滑动窗口，防止消息风暴刷爆 Worker / D1 额度
let windowStartedAt = 0;
let windowWrites = 0;
let droppedWrites = 0;

// 同一秒只入库一次：把「查库 → 写库」串行排队，避免并发时各自都查到"这一秒还没有记录"
let lastQueuedSecond = -1;
let insertQueue = Promise.resolve();
let dbTimeZone = 'utc'; // created_at 的存储时区，由 main.js 通过 connect() 传入

/* ==================== 状态提示 ==================== */

function setStatus(text, type) {
	if (!statusEl) return;
	statusEl.textContent = text;
	statusEl.className = 'mqtt-status' + (type ? ' ' + type : '');
}

// 把英文报错翻译成好懂的中文提示
function translateError(message) {
	const text = String(message || '');

	if (/bad username or password|not authorized|authentication/i.test(text)) {
		return '账号或密码不正确，请检查 config.json 里 mqtt 的账号密码。';
	}
	if (/acl|denied|forbidden|subscribe/i.test(text)) {
		return '账号没有订阅权限。请在 EMQX 控制台的「访问控制 → 授权(ACL)」里允许该用户订阅目标主题。';
	}
	if (/websocket|network|timeout|failed to fetch|xhr/i.test(text)) {
		return '连不上服务器，请检查网络，或确认地址端口是 wss://xxx:8084/mqtt。';
	}
	return text;
}

/* ==================== 解析与渲染 ==================== */

function decodePayload(payload) {
	// payload 是 Uint8Array，先按 UTF-8 解码成字符串
	try {
		return new TextDecoder('utf-8').decode(payload);
	} catch {
		return String(payload);
	}
}

// 时间：年月日时分秒
function formatTime(date) {
	const pad = (n) => String(n).padStart(2, '0');
	return (
		date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
		' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
	);
}

// 追加一条消息到「原始数据」框
function appendMessage(text) {
	if (!rawDataEl) return;

	const line = document.createElement('div');

	const timeEl = document.createElement('span');
	timeEl.className = 'line-time';
	timeEl.textContent = '[' + formatTime(new Date()) + '] ';

	const bodyEl = document.createElement('span');
	bodyEl.textContent = text; // 用 textContent，消息里带 HTML 也不会被执行

	line.append(timeEl, bodyEl);
	rawDataEl.appendChild(line);

	// 超出上限就删掉最早的一条
	const maxLines = config?.maxLines ?? 500;
	while (rawDataEl.childElementCount > maxLines) {
		rawDataEl.removeChild(rawDataEl.firstElementChild);
	}

	rawDataEl.scrollTop = rawDataEl.scrollHeight; // 自动滚到最新一条
}

/* ==================== 入库 ==================== */

/** 只接受「JSON 对象 + 至少一个业务字段」的消息，其余只显示不入库 */
function pickRawRecord(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return null; // 不是 JSON
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

	const hasField = RAW_FIELDS.some(
		(key) => data[key] !== undefined && data[key] !== null && data[key] !== '',
	);
	return hasField ? data : null;
}

/** 每秒最多写入 maxWritesPerSecond 条；数值和范围校验由 d1.js 的 normalize 负责 */
function writeAllowed() {
	const limit = config?.maxWritesPerSecond ?? 5;
	const now = Date.now();

	if (now - windowStartedAt >= 1000) {
		windowStartedAt = now;
		windowWrites = 0;
	}
	if (windowWrites >= limit) {
		droppedWrites++;
		return false;
	}
	windowWrites++;
	return true;
}

/**
 * 数据库里最新一条记录落在哪一秒；查不到时间时返回 NaN。
 * 走 /data 的 order=-id 主键倒序查询，只读 1 行。
 */
async function latestDbSecond() {
	const [latest] = await rawData.latest(1);
	return latest ? Math.floor(parseDbTime(latest.created_at, dbTimeZone === 'utc') / 1000) : NaN;
}

/**
 * 这一秒是否已经入库过了？是就跳过（重复提交 / 刚刷新过页面 / 多标签页都不会重复写）。
 * 判断依据是数据库里最新一条记录的 created_at，而不是本地计时。
 */
async function isSecondTaken() {
	return (await latestDbSecond()) === Math.floor(Date.now() / 1000);
}

/** 危险状态（status=dangerous）直接通过，不参与「同一秒只写一条」判重 */
function isUrgent(record) {
	const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
	return URGENT_STATUS.includes(status);
}

/** 同一秒只写一条（危险状态除外） */
async function insertOncePerSecond(record) {
	if (!isUrgent(record) && (await isSecondTaken())) return false;
	await rawData.add(record);
	return true;
}

function saveToDb(text) {
	const record = pickRawRecord(text);
	if (!record) return;

	const urgent = isUrgent(record);

	// 同一秒只排一次队，避免整秒的消息风暴反复查库；危险状态例外，直接放行
	const second = Math.floor(Date.now() / 1000);
	if (second === lastQueuedSecond && !urgent) return;

	if (!writeAllowed()) {
		console.warn(`[MQTT] 写入超过 ${config.maxWritesPerSecond} 条/秒，已累计丢弃 ${droppedWrites} 条`);
		return;
	}
	lastQueuedSecond = second;

	// 串行执行，让后一条「查库」看到前一条写入后的结果
	insertQueue = insertQueue.then(() => insertOncePerSecond(record)).catch((err) => {
		if (lastQueuedSecond === second) lastQueuedSecond = -1; // 查库/写入失败后允许这一秒重试
		console.warn('写入数据库失败：', err.message);
	});
}

/* ==================== 连接 ==================== */

export function connect(mqttConfig, options = {}) {
	config = mqttConfig;
	if (options.dbTimeZone) dbTimeZone = options.dbTimeZone;

	if (typeof mqtt === 'undefined') {
		setStatus('MQTT 库加载失败（CDN 不可用），请检查网络后刷新页面。', 'error');
		return;
	}
	if (!config?.url) {
		setStatus('未配置 MQTT 地址（config.json → mqtt.url），无法连接。', 'error');
		return;
	}

	closeClient();
	setStatus('正在连接…');
	if (connectBtn) connectBtn.disabled = true;

	const clientId = 'helmet-web-' + Math.random().toString(16).slice(2, 10);

	client = mqtt.connect(config.url, {
		clientId,
		username: config.username,
		password: config.password,
		clean: true,
		keepalive: 60,
		connectTimeout: config.connectTimeout ?? 10000,
		reconnectPeriod: config.reconnectPeriod ?? 3000, // 断线后自动重连
	});

	// 连接成功 -> 订阅目标主题
	client.on('connect', () => {
		hasConnected = true;
		if (connectBtn) {
			connectBtn.disabled = false;
			connectBtn.textContent = '断开';
		}

		client.subscribe(config.topic, { qos: 0 }, (err) => {
			if (!err) {
				setStatus('已连接，正在监听 ' + config.topic + ' 的所有消息…', 'connected');
				return;
			}
			// 恰好订阅 '#' 会被 EMQX 默认 ACL 拒绝，退一步用 '+/#'（效果相同，只是不含 $SYS 系统主题）
			client.subscribe(config.fallbackTopic, { qos: 0 }, (err2) => {
				if (err2) {
					setStatus('订阅失败：' + translateError(err2.message), 'error');
				} else {
					setStatus('已连接，正在监听所有主题（' + config.fallbackTopic + '）…', 'connected');
				}
			});
		});
	});

	// 收到消息 -> 显示到框里，同时写入数据库
	client.on('message', (topic, payload) => {
		const text = decodePayload(payload);
		appendMessage(text);
		saveToDb(text);
	});

	client.on('reconnect', () => setStatus('连接断开，正在重连…'));

	client.on('close', () => {
		if (hasConnected) setStatus('连接已断开，正在重连…');
	});

	client.on('error', (err) => {
		if (hasConnected) {
			// 已经连上过，掉线交给自动重连即可
			setStatus('连接出错：' + err.message, 'error');
			return;
		}
		// 从来没连上就报错（比如账号密码错），停下来让用户可以改配置重试
		closeClient();
		setStatus('连接失败：' + translateError(err.message), 'error');
	});
}

// 关闭客户端（不更新提示文字）
function closeClient() {
	if (client) {
		client.removeAllListeners(); // 先摘掉监听，避免关闭时又触发 error
		client.end(true);
		client = null;
	}
	hasConnected = false;
	if (connectBtn) {
		connectBtn.disabled = false;
		connectBtn.textContent = '连接';
	}
}

// 断开
function disconnect() {
	closeClient();
	setStatus('已断开连接');
}

/* ==================== 绑定交互 ==================== */

if (connectBtn) {
	connectBtn.addEventListener('click', () => {
		if (client) {
			disconnect();
		} else {
			connect(config);
		}
	});
}
