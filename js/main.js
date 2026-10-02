/**
 * js/main.js —— 页面入口
 *
 * 1. 读取 config.json（缺配置时在页面上给出提示，不崩溃）
 * 2. 启动 MQTT 连接，实时显示并把数据写入数据库
 * 3. 定时读取最新一条记录，刷新状态灯、经纬度和地图
 */

import { d1, rawData } from './d1.js';
import { connect } from './mqtt.js';
import { initMapView, updateStatus, updateGps } from './update.js';
import { loadConfig, describeMissing } from './config.js';

const HELMET = { ONLINE: 1, OFFLINE: 0 };
const RIDE = { DANGER: 0, SAFE: 1, UNKNOWN: 2 };

// 没有数据（或数据过期）时，地图回到这个默认位置
const FALLBACK_POSITION = { longitude: 112.5, latitude: 23.5 };

const config = await loadConfig();

d1.setBase(config.d1.base);
d1.setToken(config.d1.token);

showConfigHint(describeMissing(config));
initMapView();
updateStatus(HELMET.OFFLINE, RIDE.UNKNOWN);
updateGps(FALLBACK_POSITION.longitude, FALLBACK_POSITION.latitude, config.map);

function showConfigHint(missing) {
	if (missing.length === 0) return;
	const el = document.getElementById('config-hint');
	if (!el) return;
	el.hidden = false;
	el.textContent =
		`尚未配置：${missing.join('、')}。` +
		'请复制 config.example.json 为 config.json 并填写对应内容，详见 README.md。';
}

/**
 * 把数据库里的时间字符串转成时间戳。
 * 实测本项目 created_at 是带 Z 的 ISO 字符串（如 2026-10-02T14:21:25.846Z），
 * Date.parse 能直接正确处理；这里额外兜底 SQLite CURRENT_TIMESTAMP 那种
 * 不带时区的 "YYYY-MM-DD HH:MM:SS"（不加 Z 的话会被按本地时区解析，差 8 小时）。
 */
function parseDbTime(value) {
	if (typeof value !== 'string') return NaN;

	const text = value.trim();
	if (config.dbTimeZone !== 'utc') return Date.parse(text);

	const matched = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
	if (matched) return Date.parse(`${matched[1]}T${matched[2]}${matched[3] ?? ''}Z`);
	return Date.parse(text);
}

function showFallback() {
	updateStatus(HELMET.OFFLINE, RIDE.UNKNOWN);
	updateGps(FALLBACK_POSITION.longitude, FALLBACK_POSITION.latitude, config.map);
}

async function refresh() {
	// 没配令牌就不用发请求了（页面顶部已经有提示）
	if (!config.d1.token) {
		showFallback();
		return;
	}

	try {
		const [row] = await rawData.latest(1);

		// 表里还没有数据
		if (!row) {
			showFallback();
			return;
		}

		// 太久没有新数据 -> 视为离线
		const age = Date.now() - parseDbTime(row.created_at);
		if (!Number.isFinite(age) || age > config.staleAfterMs) {
			showFallback();
			return;
		}

		updateStatus(HELMET.ONLINE, row.status === 'alive' ? RIDE.SAFE : RIDE.DANGER);
		updateGps(
			row.longitude ?? FALLBACK_POSITION.longitude,
			row.latitude ?? FALLBACK_POSITION.latitude,
			config.map,
		);
	} catch (err) {
		// 网络或数据库出错：保持上一次画面，只打印日志，不要让定时器被打断
		console.error('读取最新数据失败：', err);
	}
}

connect(config.mqtt);
refresh();

const timer = setInterval(() => {
	if (!document.hidden) refresh(); // 页面在后台时不发请求
}, config.pollIntervalMs);

document.addEventListener('visibilitychange', () => {
	if (!document.hidden) refresh(); // 切回前台立刻刷新一次
});

window.addEventListener('pagehide', () => clearInterval(timer));
