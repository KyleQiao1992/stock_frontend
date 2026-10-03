import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPool, buildHistory, createTodayMarketSessionLoader, createTodayMarketHandler} from './todayMarket.js';
import {isCurrentMarketSnapshot} from '../src/lib/marketSnapshotQuality.js';

const NOW=Date.parse('2026-10-03T04:00:00Z');
const DATE='2026-09-30';
const sessions={date:DATE,previousDate:'2026-09-29',days:['20260928','20260929','20260930'],source:'tencent-index'};
const stocks=[{code:'600001',name:'上涨',market:1,pct:5,open:9,close:10,mktcap:2e11},
  {code:'000001',name:'下跌',market:0,pct:-1,open:10,close:9,mktcap:1e10}];
const positivePool={tc:1,pool:[{c:'600001',m:1,lbc:2}],latestDate:'20260930'};
const zeroPool={tc:0,pool:[],latestDate:'20260930'};
const body=()=>({rc:0,data:{qdate:20260930,tc:1,pool:[{c:'600001',m:1,lbc:2}]}});
const request=(payload)=>async()=>({ok:true,json:async()=>payload});
const response=async(handler)=>{
  const res={statusCode:200,setHeader(){},end(text){this.body=JSON.parse(text);}};
  await handler({url:'/?retry=1'},res);return res;
};

test('pool date is bounded by available quote session, not the requested natural day',async()=>{
  const options={request:request(body()),now:()=>NOW};
  assert.equal((await fetchPool('zt','20260930',NOW+5000,options)).tc,1);
  // Historical responses carry the latest global qdate, not the requested date.
  assert.equal((await fetchPool('zt','20260929',NOW+5000,options)).tc,1);
  assert.equal(await fetchPool('zt','20261003',NOW+5000,options),null);
  assert.equal(await fetchPool('zt','20260230',NOW+5000,options),null);
  assert.equal(await fetchPool('bad','20260930',NOW+5000,options),null);
  assert.equal(await fetchPool('zt','20260930',NOW,options),null);
  const empty={rc:0,data:{qdate:20260930,tc:0,pool:[]}};
  assert.deepEqual(await fetchPool('zt','20260930',NOW+5000,{request:request(empty),now:()=>NOW}),zeroPool);
});

test('invalid, incomplete and future pool responses remain unknown',async(t)=>{
  for(const [name,change] of [
    ['upstream error',p=>{p.rc=-1;}],['missing quote session',p=>{delete p.data.qdate;}],
    ['future session',p=>{p.data.qdate=20261008;}],['invalid session',p=>{p.data.qdate=20260230;}],
    ['count mismatch',p=>{p.data.tc=2;}],['negative count',p=>{p.data.tc=-1;}],
    ['null member',p=>{p.data.pool=[null];}],['unknown security',p=>{p.data.pool[0].c='bad';}],
    ['unknown market',p=>{p.data.pool[0].m=9;}],['invalid streak',p=>{p.data.pool[0].lbc=0;}],
  ]) await t.test(name,async()=>{
    const payload=body();change(payload);
    assert.equal(await fetchPool('zt','20260930',NOW+5000,{request:request(payload),now:()=>NOW}),null);
  });
});

function loader(options={}) {
  return createTodayMarketSessionLoader({now:()=>NOW,loadDays:async()=>sessions,
    loadPool:async(kind)=>kind==='zt'?positivePool:zeroPool,...options});
}

test('long-holiday panels use one quote session and its actual previous session',async()=>{
  const queries=[];
  const data=await loader({loadPool:async(kind,date)=>{
    queries.push([kind,date]);return kind==='zt'?positivePool:zeroPool;
  }})({date:DATE,stocks});
  assert.equal(data.poolDate,DATE);
  assert.equal(data.previousDate,'2026-09-29');
  assert.equal(data.strong.ztCount,1);
  assert.equal(data.heat.value,70);
  assert.equal(data.consecutive.lbCount,1);
  assert.equal(data.premium.avg,5);
  assert.equal(data.premiumCoverage.quoted,1);
  assert.deepEqual(data.history.map(row=>row.date),['2026-09-28','2026-09-29','2026-09-30']);
  assert.equal(data.history.find(row=>row.date==='2026-09-29').nextDaySuccess,1);
  assert.equal(data.history.at(-1).nextDaySuccess,null);
  assert.equal(queries.length,9);
  assert.ok(queries.every(([,date])=>date<='20260930'));
});

test('a real previous session with zero limit-ups is not skipped for an earlier nonzero session',async()=>{
  const data=await loader({loadPool:async(kind,date)=>kind==='zt'&&date!=='20260929'?positivePool:zeroPool})({date:DATE,stocks});
  assert.equal(data.previousDate,'2026-09-29');
  assert.equal(data.poolAvailability.previousZt,true);
  assert.equal(data.premium,null);
  assert.deepEqual(data.premiumCoverage,{expected:0,quoted:0});
  assert.equal(data.history.find(row=>row.date==='2026-09-29').ztCount,0);
  assert.equal(data.history.find(row=>row.date==='2026-09-29').nextDaySuccess,null);
});

test('one failed pool hides only its dependent indicators, rather than the entire session',async()=>{
  const data=await loader({loadPool:async(kind)=>kind==='zt'?positivePool:kind==='zb'?null:zeroPool})({date:DATE,stocks});
  assert.equal(data.strong,null);
  assert.equal(data.heat.value,70);
  assert.equal(data.consecutive.lbCount,1);
  assert.equal(data.premium.avg,5);
  assert.equal(data.breadth.total,2);
  assert.equal(data.poolAvailability.zb,false);
});

test('calendar outage still displays the verified current session without guessing yesterday',async()=>{
  const queries=[];
  const data=await loader({loadDays:async()=>{throw new Error('index unavailable');},loadPool:async(kind,date)=>{
    queries.push(date);return kind==='zt'?positivePool:zeroPool;
  }})({date:DATE,stocks});
  assert.equal(data.previousDate,null);
  assert.equal(data.poolAvailability.previousZt,false);
  assert.equal(data.premium,null);
  assert.equal(data.strong.ztCount,1);
  assert.deepEqual(queries,['20260930','20260930','20260930']);
});

test('pool reuse is shared, but price-derived panels use each request quotes and manual refresh refetches',async()=>{
  let calls=0;
  let dayCalls=0;
  const load=loader({loadDays:async()=>{dayCalls++;return sessions;},loadPool:async(kind)=>{calls++;return kind==='zt'?positivePool:zeroPool;}});
  const [first,second]=await Promise.all([load({date:DATE,stocks}),load({date:DATE,stocks:[{...stocks[0],pct:-5}]})]);
  assert.equal(calls,9);assert.equal(dayCalls,1);
  assert.equal(first.premium.avg,5);assert.equal(second.premium.avg,-5);
  await load({date:DATE,stocks});assert.equal(calls,9);
  await load({date:DATE,stocks,force:true});assert.equal(calls,18);assert.equal(dayCalls,2);
});

test('failed current pools are not cached as a successful session',async()=>{
  let failed=true;
  let calls=0;
  const load=loader({loadPool:async(kind)=>{calls++;return failed?null:kind==='zt'?positivePool:zeroPool;}});
  assert.equal((await load({date:DATE,stocks})).strong,null);
  failed=false;
  assert.equal((await load({date:DATE,stocks})).strong.ztCount,1);
  assert.equal(calls,18);
});

test('primary quote, pool, history and panel date cannot disagree',async()=>{
  const data=await loader()({date:DATE,stocks});
  const good={live:true,...data,date:DATE,quoteTime:'2026-09-30T07:00:00Z',updatedAt:new Date(NOW).toISOString()};
  assert.equal((await response(createTodayMarketHandler({load:async()=>good,getRedis:async()=>null,now:()=>NOW}))).statusCode,200);
  for(const bad of [{date:'2026-09-29'},{dataDate:'2026-09-29'},{poolDate:'2026-09-29'},
    {previousDate:DATE},{history:[{...data.history[0],date:'2026-10-01'}]}]) {
    const candidate={...good,...bad};
    assert.equal((await response(createTodayMarketHandler({load:async()=>candidate,getRedis:async()=>null,now:()=>NOW}))).statusCode,502);
    assert.equal(isCurrentMarketSnapshot(candidate,'today'),false);
  }
});

test('missing historical pools cannot redefine the next trading session',async()=>{
  const days=['20260928','20260930'];
  const ztMap=new Map(days.map(date=>[date,positivePool]));
  const data=await buildHistory(days,ztMap,new Map(),new Map(),NOW+5000,{
    now:()=>NOW,sessions:['20260928','20260929','20260930'],
    loadDailyPct:async()=>({'20260929':-5,'20260930':5}),
  });
  assert.equal(data[0].date,'2026-09-28');
  assert.equal(data[0].nextDaySuccess,0);
  assert.equal(data[1].date,'2026-09-30');
  assert.equal(data[1].nextDaySuccess,null);
});
