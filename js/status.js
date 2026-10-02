const helmet_status = document.getElementById('helmet-status');
const ride_status = document.getElementById('ride-status');
const helmet_text = document.getElementById('helmet-text');
const ride_text = document.getElementById('ride-text');

function Status_Update(Helmet, Ride) {
    if (Helmet === true) {
        helmet_status.style.color = rgb(0, 255, 0);
        helmet_text.textContent = '在线';
    }else{
        helmet_status.style.color = rgb(127, 127, 127);
        helmet_text.textContent = '离线';
    }

    if (Ride === true) {
        ride_status.style.color = rgb(0, 255, 0);
        ride_text.textContent = '安全';
    }else{
        ride_status.style.color = rgb(255, 0, 0);
        ride_text.textContent = '危险';
    }
}