/**
 * js/update.js —— 把数据渲染到页面上（状态灯、经纬度、天地图静态地图）
 *
 * 页面元素缺失时只跳过对应显示并给出警告，不让整个脚本崩掉。
 */

const els = {
	helmetStatus: document.getElementById('helmet-status'),
	rideStatus: document.getElementById('ride-status'),
	helmetText: document.getElementById('helmet-text'),
	rideText: document.getElementById('ride-text'),
	longitudeText: document.getElementById('longitude-text'),
	latitudeText: document.getElementById('latitude-text'),
	mapImage: document.getElementById('map-image'),
	mapHint: document.getElementById('map-hint'),
};

const COLOR = {
	ok: 'rgb(0, 255, 0)',
	danger: 'rgb(255, 0, 0)',
	unknown: 'rgb(127, 127, 127)',
};

function setText(el, text) {
	if (!el) return;
	el.textContent = text;
}

function setColor(el, color) {
	if (!el) return;
	el.style.background = color;
}

function showMapHint(text) {
	if (els.mapImage) els.mapImage.hidden = true;
	if (els.mapHint) {
		els.mapHint.hidden = false;
		els.mapHint.textContent = text;
	}
}

/** 地图加载成功时把「加载中…」的提示收起来 */
export function initMapView() {
	if (!els.mapImage) return;
	els.mapImage.addEventListener('load', () => {
		if (els.mapHint) els.mapHint.hidden = true;
	});
	els.mapImage.addEventListener('error', () => {
		showMapHint('地图图片加载失败：请检查网络，以及天地图密钥和域名白名单是否有效。');
	});
}

/**
 * 拼装天地图静态图地址。
 * 这里手动拼串而不用 URLSearchParams，是为了让 center/markers 里的逗号保持原样
 * （部分服务端不解析 %2C），同时避免模板字符串换行带来的多余空格。
 */
export function buildMapUrl(longitude, latitude, map) {
	const parts = [
		['center', `${longitude},${latitude}`],
		['width', map.width],
		['height', map.height],
		['zoom', map.zoom],
		['layers', map.layers],
		['markers', `${longitude},${latitude}`],
		['tk', map.tiandituToken],
	];
	return map.endpoint + '?' + parts.map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * 更新头盔状态和骑行状态
 * @param {number} helmet 1 = 在线，其它 = 离线
 * @param {number} ride 1 = 安全，2 = 未知，其它 = 危险
 */
export function updateStatus(helmet, ride) {
	if (helmet === 1) {
		setColor(els.helmetStatus, COLOR.ok);
		setText(els.helmetText, '在线');
	} else {
		setColor(els.helmetStatus, COLOR.unknown);
		setText(els.helmetText, '离线');
	}

	if (ride === 1) {
		setColor(els.rideStatus, COLOR.ok);
		setText(els.rideText, '安全');
	} else if (ride === 2) {
		setColor(els.rideStatus, COLOR.unknown);
		setText(els.rideText, '未知');
	} else {
		setColor(els.rideStatus, COLOR.danger);
		setText(els.rideText, '危险');
	}
}

/** 更新经纬度文字和静态地图 */
export function updateGps(longitude, latitude, map) {
	setText(els.longitudeText, longitude);
	setText(els.latitudeText, latitude);

	if (!els.mapImage) return;

	if (!map?.tiandituToken) {
		showMapHint('未配置天地图密钥（config.json → map.tiandituToken），地图无法显示。');
		return;
	}

	const url = buildMapUrl(longitude, latitude, map);
	if (els.mapImage.getAttribute('src') === url) return; // 坐标没变就不重新请求

	els.mapImage.hidden = false;
	els.mapImage.src = url;
}
