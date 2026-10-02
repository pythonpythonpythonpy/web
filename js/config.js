/**
 * js/config.js —— 运行时配置
 *
 * 敏感信息（MQTT 账号密码、D1 令牌、天地图密钥）不再写死在源码里，
 * 而是放在项目根目录的 config.json 中，该文件已被 .gitignore 忽略。
 *
 * 没有 config.json 时页面照样能打开，只是会在顶部提示「尚未配置」。
 * 复制 config.example.json 为 config.json 再填写即可，详见 README.md。
 */

const CONFIG_URL = './config.json';

/** 非敏感默认值（网址、参数这类） */
export const DEFAULT_CONFIG = {
	mqtt: {
		url: '',
		topic: 'topic/#',
		fallbackTopic: '+/#',
		username: '',
		password: '',
		connectTimeout: 10000,
		reconnectPeriod: 3000,
		maxLines: 500,
		maxWritesPerSecond: 5,
	},
	d1: {
		base: 'https://d1.api.shenxv.dpdns.org',
		token: '',
	},
	map: {
		endpoint: 'https://api.tianditu.gov.cn/staticimage',
		tiandituToken: '',
		zoom: 12,
		width: 1000,
		height: 590,
		layers: 'vec_c,cva_c',
	},
	pollIntervalMs: 10000,
	// 超过这么久没有新数据，就认为设备已离线
	staleAfterMs: 30 * 60 * 1000,
	// 数据库 created_at 的时区：SQLite CURRENT_TIMESTAMP 存的是 UTC
	dbTimeZone: 'utc',
};

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 递归合并：用户配置覆盖默认值，未填的键保留默认值 */
function merge(base, extra) {
	const out = { ...base };
	for (const [key, value] of Object.entries(extra ?? {})) {
		out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
	}
	return out;
}

let cached = null;

/** 读取 config.json（没有 / 读失败都当成空配置）；结果会缓存，只请求一次 */
export function loadConfig() {
	if (!cached) {
		cached = fetch(CONFIG_URL, { cache: 'no-store' })
			.then((res) => (res.ok ? res.json() : {}))
			.catch(() => ({}))
			.then((user) => merge(DEFAULT_CONFIG, user));
	}
	return cached;
}

/** 返回还没配好的关键项名称，供页面提示用 */
export function describeMissing(config) {
	const missing = [];
	if (!config.d1.token) missing.push('D1 令牌（d1.token）');
	if (!config.mqtt.url) missing.push('MQTT 地址（mqtt.url）');
	if (!config.mqtt.username) missing.push('MQTT 账号（mqtt.username）');
	if (!config.map.tiandituToken) missing.push('天地图密钥（map.tiandituToken）');
	return missing;
}
