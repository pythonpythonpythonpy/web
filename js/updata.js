const helmet_status = document.getElementById('helmet-status');
const ride_status = document.getElementById('ride-status');
const helmet_text = document.getElementById('helmet-text');
const ride_text = document.getElementById('ride-text');
const longitude_text = document.getElementById('longitude-text');
const latitude_text = document.getElementById('latitude-text');
const map_image = document.getElementById('map-image');

export function Status_Update(Helmet, Ride) {
    if (Helmet === 1) {
        helmet_status.style.background = 'rgb(0, 255, 0)';
        helmet_text.textContent = '在线';
    }else{
        helmet_status.style.background = 'rgb(127, 127, 127)';
        helmet_text.textContent = '离线';
    }

    if (Ride === 1) {
        ride_status.style.background = 'rgb(0, 255, 0)';
        ride_text.textContent = '安全';
    }else if (Ride === 2) {
        ride_status.style.background = 'rgb(127, 127, 127)';
        ride_text.textContent = '未知';
    }else {
        ride_status.style.background = 'rgb(255, 0, 0)';
        ride_text.textContent = '危险';
    }
}

export function GPS_Update(Longitude, Latitude) {
    longitude_text.textContent = Longitude;
    latitude_text.textContent = Latitude;
    map_image.src = `http://api.tianditu.gov.cn/staticimage?
    center=${Longitude},${Latitude}
    &width=1000
    &height=590
    &zoom=10
    &markers=${Longitude},${Latitude}
    &tk=be0a7553c81927d557b83f4690dd33f7`;
}