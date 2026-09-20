import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHistory, validateHistoryQuery, createHistoryService } from './heatmapHistory.js';
const line = (date, close, pct, amount = 100000000) => `${date},100,${close},120,90,1000,${amount},1,${pct},1,1`;
const q = { start: '2025-09-01', end: '2025-09-03', board: '' };
async function finish(service, query = q) {
  for (let i = 0; i < 100; i++) {
    const result = service.query(query);
    if (result.status === 'complete') return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Job did not settle');
}
test('single day includes its daily move; range uses prior close, not summed percentages', () => {
  const data = [line('2025-09-01',110,10), line('2025-09-02',99,-10)];
  assert.equal(summarizeHistory(data,q.start,q.start).pct,10);
  assert.equal(summarizeHistory(data,q.start,q.end).pct,-1);
  assert.equal(summarizeHistory(data,q.start,q.end).amount,2);
  assert.equal(summarizeHistory(data,'2025-09-06','2025-09-07'),null);
  assert.throws(()=>summarizeHistory([line(q.start,110,10,'-')],q.start,q.end));
});
test('invalid dates, reversed ranges, excessive ranges and invalid boards are rejected', () => {
  for (const query of ['start=2025-02-30','start=2025-09-03&end=2025-09-01','start=2020-01-01&end=2025-01-01','start=2025-09-01&board=unsafe']) {
    assert.throws(()=>validateHistoryQuery(new URLSearchParams(query)));
  }
});
test('history job returns progress, reuses cached bars and supports current-member drilldown', async () => {
  let requests=0;
  const service=createHistoryService(async (url)=>{
    requests++;
    if(url.includes('clist')) return {total:1,diff:[url.includes('b:BK') ? {f12:'600519',f13:1,f14:'样本股'} : {f12:'BK1326',f14:'样本行业'}]};
    return {klines:[line('2025-09-01',110,10),line('2025-09-02',99,-10)]};
  });
  assert.equal(service.query(q).status,'loading');
  const result=await finish(service);
  assert.equal(result.industries[0].pct,-1);
  const before=requests;
  assert.equal((await finish(service,{...q,end:'2025-09-02'})).industries.length,1);
  assert.equal(requests,before);
  const detail=await finish(service,{...q,board:'BK1326'});
  assert.equal(detail.stocks[0].code,'600519');
});
test('unavailable source stops after probe and permits explicit retry',async()=>{
  let calls=0;
  const service=createHistoryService(async(url)=>{
    if(url.includes('clist'))return {total:10,diff:Array.from({length:10},(_,i)=>({f12:`BK${1300+i}`,f14:`行业${i}`}))};
    calls++; throw new Error('Unavailable');
  });
  const result=await finish(service);
  assert.ok(result.error);
  assert.equal(calls,6);
  assert.equal(result.industries.length,0);
  assert.equal(service.query(q,true).status,'loading');
  await finish(service);
  assert.equal(calls,12);
});
test('failed member remains explicitly partial rather than silently complete',async()=>{
  const service=createHistoryService(async(url)=>{
    if(url.includes('clist'))return {total:2,diff:[{f12:'BK1326',f14:'好'},{f12:'BK1327',f14:'坏'}]};
    if(url.includes('BK1327'))throw new Error('Unavailable');
    return {klines:[line(q.start,110,10)]};
  });
  const result=await finish(service);
  assert.equal(result.partial,true);assert.deepEqual(result.failed,['坏']);
  assert.equal(result.industries.length,1);
});
