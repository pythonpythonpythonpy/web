/**
 * 监听 MQTT 服务器上 '#'（所有主题）的消息，并显示在「原始数据」卡片里。
 *
 * 注意：网页里只能用 WebSocket 接入 MQTT，所以要使用 EMQX 的
 *       “WebSocket over TLS/SSL 端口 8084”，地址形如 wss://xxx:8084/mqtt
 */

import { rawData } from './d1.js';

// ==================== 配置 ====================
const MQTT_CONFIG = {
	// EMQX 部署的连接地址（部署概览里可以复制到）
	url: 'wss://nb8cea59.ala.cn-shenzhen.emqxsl.cn:8084/mqtt',
	// 'topic/#' 是通配符，表示订阅所有主题
	topic: 'topic/#',
	// EMQX 的默认 ACL 规则会拒绝订阅恰好等于 '#' 的主题，
	// 如果 # 订阅被拒绝，就自动改用 '+/#'（效果同样是监听所有主题，只是不含 $SYS 开头的系统主题）
	fallbackTopic: '+/#',
	// 账号密码已写死在代码里（EMQX 控制台「访问控制 → 认证」里创建的这个用户）
	username: 'web',
	password: '123',
	// 页面最多保留多少条消息，防止长时间运行后卡顿
	maxLines: 500
};

// ==================== 页面元素 ====================
const rawDataEl = document.getElementById('raw-data');
const statusEl = document.getElementById('mqtt-status');
const connectBtn = document.getElementById('mqtt-connect');

let client = null; // 当前的 MQTT 客户端，未连接时为 null
let hasConnected = false; // 是否成功连接过（用来区分“连不上”和“连上后掉线”）

// ==================== 状态提示 ====================
function setStatus(text, type) {
	statusEl.textContent = text;
	statusEl.className = 'mqtt-status' + (type ? ' ' + type : '');
}

// 把英文报错翻译成好懂的中文提示
function translateError(message) {
	const text = String(message || '');

	if (/bad username or password|not authorized|authentication/i.test(text)) {
		return '账号或密码不正确，请检查 main.js 里 MQTT_CONFIG 配置的账号密码。';
	}
	if (/acl|denied|forbidden|subscribe/i.test(text)) {
		return '账号没有订阅权限。请在 EMQX 控制台的「访问控制 → 授权(ACL)」里允许该用户订阅 # 主题。';
	}
	if (/websocket|network|timeout|failed to fetch|xhr/i.test(text)) {
		return '连不上服务器，请检查网络，或确认地址端口是 wss://xxx:8084/mqtt。';
	}
	return text;
}

// ==================== 解析消息内容 ====================
function decodePayload(payload) {
	// payload 是 Uint8Array，先按 UTF-8 解码成字符串
	let text;
	try {
		text = new TextDecoder('utf-8').decode(payload);
	} catch (err) {
		text = String(payload);
	}

	/*// 如果是 JSON 对象，就去掉最外层的大括号，把每个字段单独显示成一行
	try {
		const data = JSON.parse(text);
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			return Object.entries(data)
				.map(([key, value]) => key + ': ' + formatValue(value))
				.join('\n');
		}
	} catch (err) {
		// 不是 JSON，按原文显示
	}*/

	return text;
}

// 字段值：嵌套的对象 / 数组压成一行显示，其余直接转字符串
function formatValue(value) {
	if (value === null || value === undefined) return String(value);
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

// ==================== 时间：年月日时分秒 ====================
function formatTime(date) {
	const pad = (n) => String(n).padStart(2, '0');
	return (
		date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
		' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
	);
}

// ==================== 追加一条消息到“原始数据”框 ====================
function appendMessage(payload) {
	const line = document.createElement('div');

	const timeEl = document.createElement('span');
	timeEl.className = 'line-time';
	timeEl.textContent = '[' + formatTime(new Date()) + '] ';

	const bodyEl = document.createElement('span');
	bodyEl.textContent = decodePayload(payload);

	line.append(timeEl, bodyEl);
	rawDataEl.appendChild(line);

	// 超出上限就删掉最早的一条
	while (rawDataEl.childElementCount > MQTT_CONFIG.maxLines) {
		rawDataEl.removeChild(rawDataEl.firstElementChild);
	}

	// 自动滚到最新一条
	rawDataEl.scrollTop = rawDataEl.scrollHeight;
}

async function checkData(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(input));
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

async function saveToDb(payload) {
    let data;
	let row;
    try {
        data = JSON.parse(decodePayload(payload));
		sha256Data = await checkData(data);
		row = (await rawData.latest(1))[0];
		sha256Row = await checkData(row);
		if (sha256Data !== sha256Row) {
			rawData.add(data).catch((err) => console.warn('写入数据库失败：', err.message));
		}
    } catch {
        return; // 不是 JSON，只显示不入库
    }
}

// ==================== 连接 ====================
export function connect() {
	const clientId = 'helmet-web-' + Math.random().toString(16).slice(2, 10);

	setStatus('正在连接…');
	connectBtn.disabled = true;
	hasConnected = false;

	client = mqtt.connect(MQTT_CONFIG.url, {
		clientId: clientId,
		username: MQTT_CONFIG.username,
		password: MQTT_CONFIG.password,
		clean: true,
		keepalive: 60,
		connectTimeout: 10000,
		reconnectPeriod: 3000 // 断线后 3 秒自动重连
	});

	// 连接成功 -> 订阅所有主题
	client.on('connect', () => {
		hasConnected = true;
		connectBtn.disabled = false;
		connectBtn.textContent = '断开';

		client.subscribe(MQTT_CONFIG.topic, { qos: 0 }, (err) => {
			if (!err) {
				setStatus('已连接，正在监听 ' + MQTT_CONFIG.topic + ' 的所有消息…', 'connected');
				return;
			}
			// 订阅 '#' 被拒绝（EMQX 默认 ACL）时，退一步用 '+/#'
			client.subscribe(MQTT_CONFIG.fallbackTopic, { qos: 0 }, (err2) => {
				if (err2) {
					setStatus('订阅失败：' + translateError(err2.message), 'error');
				} else {
					setStatus('已连接，正在监听所有主题（' + MQTT_CONFIG.fallbackTopic + '）…', 'connected');
				}
			});
		});
	});

	// 收到消息 -> 显示到框里，同时写入数据库
	client.on('message', (topic, payload) => {
		appendMessage(payload);
		saveToDb(payload);
	});

	client.on('reconnect', () => {
		setStatus('连接断开，正在重连…');
	});

	client.on('error', (err) => {
		if (hasConnected) {
			// 已经连上过，掉线交给自动重连即可
			setStatus('连接出错：' + err.message, 'error');
			return;
		}
		// 从来没连上就报错（比如账号密码错），停下来让用户可以改账号重试
		closeClient();
		setStatus('连接失败：' + translateError(err.message), 'error');
	});
}

// ==================== 关闭客户端（不更新提示文字） ====================
function closeClient() {
	if (client) {
		client.removeAllListeners(); // 先摘掉监听，避免关闭时又触发 error
		client.end(true);
		client = null;
	}
	hasConnected = false;
	connectBtn.disabled = false;
	connectBtn.textContent = '连接';
}

// ==================== 断开 ====================
function disconnect() {
	closeClient();
	setStatus('已断开连接');
}

// ==================== 绑定交互 ====================
connectBtn.addEventListener('click', () => {
	if (client) {
		disconnect();
	} else {
		connect();
	}
});