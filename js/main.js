import { connect } from './mqtt.js';
import { rawData } from './d1.js';
import { Status_Update } from './updata.js';
import { GPS_Update } from './updata.js';

async function main() {
    const time = new Date().getTime();
    const row = (await rawData.latest(1))[0];
    let Time_row = new Date(row.created_at).getTime();
    if (time-Time_row > 30*60*1000){
        Status_Update(0, 2);
        GPS_Update(112.5, 23.5);
    }else {
        if (row.status === 'alive'){
            Status_Update(1, 1);
        }else{
            Status_Update(1, 0);
        }
        GPS_Update(row.longitude, row.latitude);
    }
    console.log(row);
}

connect();
main();
const timer = setInterval(main, 10 * 1000);