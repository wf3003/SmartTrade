import 'dotenv/config';
import Database from 'better-sqlite3';
import ccxt from 'ccxt';
const ex=new ccxt.okx({sandbox:true,enableRateLimit:true,httpsProxy:process.env.HTTPS_PROXY});
const db=new Database('/home/rose/SmartTrade/data/quantmax.db',{readonly:true});

// BTC K线
console.log('BTC 6/1 K线(1h):');
const k=await ex.fetchOHLCV('BTC/USDT','1h',new Date('2026-06-01T06:00Z').getTime(),28);
for(const c of k.slice(-20)){
 const t=new Date(c[0]).toISOString().substring(11,16);
 const o=c[1],cl=c[4],ch=((cl-o)/o*100).toFixed(1);
 console.log(t+' o'+o+' c'+cl+' '+ch+'%');
}

// 峰值时间和谷底
const prices=k.map(c=>c[4]);
let peak=0,peakAt='',trough=999999,trAt='';
for(let i=0;i<k.length;i++){
 if(k[i][4]>peak){peak=k[i][4];peakAt=new Date(k[i][0]).toISOString().substring(5,16);}
 if(k[i][4]<trough){trough=k[i][4];trAt=new Date(k[i][0]).toISOString().substring(5,16);}
}
console.log('\n峰值:'+peakAt+' $'+peak+' 谷底:'+trAt+' $'+trough);

// 谷底附近的backtest_logs
const btAround=db.prepare("SELECT time,symbol,optimal_strategy,confidence,rev_accuracy,cont_accuracy FROM backtest_logs WHERE symbol='BTC/USDT' AND time BETWEEN ? AND ? ORDER BY time").all(trAt.replace('T',' ')+':00',new Date(new Date(trAt).getTime()+4*3600*1000).toISOString().replace('T',' ').substring(0,19));
if(btAround.length){
 console.log('\n谷底附近回测信号:');
 for(const r of btAround)console.log((r as any).time.substring(11,19)+' '+(r as any).optimal_strategy+' cf'+(r as any).confidence+'% rev'+(r as any).rev_accuracy+'% cont'+(r as any).cont_accuracy+'%');
}else{
 console.log('谷底附近无回测记录');
}
db.close();process.exit(0);
