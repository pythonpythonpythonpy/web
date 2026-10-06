/**
 * js/time.js —— 数据库时间解析（main.js 与 mqtt.js 共用）
 */

/**
 * 把数据库里的时间字符串转成时间戳。
 * 实测本项目 created_at 是带 Z 的 ISO 字符串（如 2026-10-02T14:21:25.846Z），
 * Date.parse 能直接正确处理；这里额外兜底 SQLite CURRENT_TIMESTAMP 那种
 * 不带时区的 "YYYY-MM-DD HH:MM:SS"（不加 Z 的话会被按本地时区解析，差 8 小时）。
 *
 * @param {unknown} value 数据库返回的时间字段
 * @param {boolean} utc created_at 是否按 UTC 存储（config.dbTimeZone === 'utc'）
 */
export function parseDbTime(value, utc = false) {
	if (typeof value !== 'string') return NaN;

	const text = value.trim();
	if (!utc) return Date.parse(text);

	const matched = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
	if (matched) return Date.parse(`${matched[1]}T${matched[2]}${matched[3] ?? ''}Z`);
	return Date.parse(text);
}
