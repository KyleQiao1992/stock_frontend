import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { deflateSync } from 'node:zlib';
import { buildTdxHistoryPacket, parseTdxHistoryTransactions, readTdxTradeSideDay,
  parseTradeSideDailyPlan, fetchTdxTradeSideHistory, connectTdxHistory } from './tdxTradeSideHistory.js';

const NOW = Date.parse('2026-10-14T05:00:00Z');
const encode = value => {
  const bytes = [];
  let rest = Math.abs(value);
  let first = rest % 64;
  rest = Math.floor(rest / 64);
  if (value < 0) first |= 64;
  if (rest) first |= 128;
  bytes.push(first);
  while (rest) {
    const part = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(part | (rest ? 128 : 0));
  }
  return Buffer.from(bytes);
};
function body(rows) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(rows.length);
  let previous = 0;
  const chunks = [head];
  for (const row of rows) {
    const time = Buffer.alloc(2); time.writeUInt16LE(row.minute);
    const price = Math.round(row.price * 100);
    chunks.push(time, encode(price - previous), encode(row.vol), encode(row.side), encode(0));
    previous = price;
  }
  return Buffer.concat(chunks);
}
const empty = () => body([]);
const trade = (changes = {}) => ({minute:900,price:4.34,vol:10,side:0,...changes});
const day = (changes = {}) => ({code:'603818',market:1,date:'2026-10-13',expectedTotalVol:10,close:4.34,...changes});
const connection = pages => ({request:async packet => {
  const offset = packet.readUInt16LE(24);
  const page = pages[offset];
  if (!page) throw new Error(`unexpected offset ${offset}`);
  return page;
},close() {}});

test('historical requests encode the actual date and reject truncating pagination offsets', () => {
  const packet=buildTdxHistoryPacket({code:'603818',market:1,date:'2026-09-21',start:2000});
  assert.equal(packet.length,28);
  assert.equal(packet.readUInt32LE(12),20260921);
  assert.equal(packet.subarray(18,24).toString(),'603818');
  assert.equal(packet.readUInt16LE(24),2000);
  assert.throws(() => buildTdxHistoryPacket({code:'603818',market:1,date:'2026-02-30'}));
  assert.throws(() => buildTdxHistoryPacket({code:'603818',market:1,date:'2026-09-21',start:65536}));
});

test('parsing preserves signed price changes, neutral directions and large exact lot counts', () => {
  const rows=[trade({vol:3_000_000_000}),trade({price:4.22,vol:3,side:2}),trade({price:4.23,side:5})];
  assert.deepEqual(parseTdxHistoryTransactions(body(rows)),rows);
  assert.throws(() => parseTdxHistoryTransactions(body(rows).subarray(0,-1)),/截断/);
  assert.throws(() => parseTdxHistoryTransactions(Buffer.concat([body(rows),Buffer.from([0])])),/未识别/);
});

test('full pagination keeps the last trade from the newest page and reads through EOF', async () => {
  const newest=Array.from({length:2000},() => trade({vol:1}));
  const older=Array.from({length:10},() => trade({price:4.22,vol:1,side:1}));
  const row=await readTdxTradeSideDay(connection({0:body(newest),2000:body(older),2010:empty()}),day({expectedTotalVol:2010}),{now:()=>NOW});
  assert.equal(row.outerVol,2000);
  assert.equal(row.innerVol,10);
  assert.equal(row.quality.closingPrice,4.34);
  assert.equal(row.quality.pageCount,3);
  assert.equal(row.quality.volumeDifference,0);
  assert.equal(row.quoteTime,null);
  assert.equal(row.complete,true);
});

test('repeated pages, missing volume and wrong closing prices cannot be archived as complete', async () => {
  const repeated=body(Array.from({length:2000},()=>trade({vol:1})));
  await assert.rejects(readTdxTradeSideDay(connection({0:repeated,2000:repeated}),day({expectedTotalVol:4000})),/重复/);
  await assert.rejects(readTdxTradeSideDay(connection({0:body([trade()]),10:empty(),1:empty()}),day({expectedTotalVol:11})),/成交量与日线不一致/);
  await assert.rejects(readTdxTradeSideDay(connection({0:body([trade({price:4.22})]),1:empty()}),day()),/收盘价不一致/);
});

test('matching totals and close cannot verify direction labels against the exchange', async () => {
  const buy = await readTdxTradeSideDay(connection({0:body([trade({side:0})]),1:empty()}),day(),{now:()=>NOW});
  const sell = await readTdxTradeSideDay(connection({0:body([trade({side:1})]),1:empty()}),day(),{now:()=>NOW});
  assert.equal(buy.totalVol, sell.totalVol);
  assert.equal(buy.quality.closingPrice, sell.quality.closingPrice);
  assert.equal(buy.netVol, -sell.netVol);
  for (const row of [buy, sell]) {
    assert.equal(row.validated, true);
    assert.equal(row.quality.verification.exchangeDirectionVerified, false);
    assert.equal(row.quality.verification.directionSource, 'tdx');
    assert.equal(row.quality.verification.rawRecordsRetained, false);
  }
});

test('unknown after-hours volume is preserved but never relabelled as active buying', async () => {
  const rows=[trade({minute:895,vol:5,side:1}),trade({vol:5}),trade({minute:912,vol:35,side:5})];
  const row=await readTdxTradeSideDay(connection({0:body(rows),3:empty()}),day(),{now:()=>NOW});
  assert.equal(row.totalVol,45);
  assert.equal(row.regularVol,10);
  assert.equal(row.unknownVol,35);
  assert.equal(row.afterHoursVol,35);
  assert.equal(row.outerVol,5);
  assert.equal(row.netRatio,0);
});

const dailyPayload=bars=>({code:0,data:{sh603818:{day:bars}}});
const bar=(date,volume='10')=>[date,'4.22','4.34','4.38','4.12',volume];
test('trading dates come from real daily bars and unfinished current sessions are excluded', () => {
  const plan=parseTradeSideDailyPlan(dailyPayload([bar('2026-10-12'),bar('2026-10-13'),bar('2026-10-14')]),'603818',{now:()=>NOW});
  assert.deepEqual(plan.map(row=>row.date),['2026-10-12','2026-10-13']);
  assert.throws(()=>parseTradeSideDailyPlan(dailyPayload([bar('2026-10-12','')]),'603818',{now:()=>NOW}),/缺少/);
  assert.equal(parseTradeSideDailyPlan(dailyPayload([bar('2026-10-12','0'),bar('2026-10-13')]),'603818',{now:()=>NOW}).length,1);
});

test('STAR Market daily plans preserve exact shares and do not compare shares with integer lots', () => {
  const payload = {code:0,data:{sh688610:{day:[['2026-10-13','130','126.13','135.01','124.32','1763046']]}}};
  const plan = parseTradeSideDailyPlan(payload, '688610', {now:()=>NOW});
  assert.equal(plan[0].expectedTotalVol,17630.46);
  assert.equal(plan[0].expectedTotalShares,1763046);
  assert.equal(plan[0].sourceVolumeUnit,'share');
});

test('an integer-lot historical feed cannot claim precise STAR Market volume even if totals happen to match', async () => {
  for (const code of ['688610','689009']) {
    const options = {code,limit:3,request:async()=>{throw new Error('Precision failure must precede network work');}};
    await assert.rejects(fetchTdxTradeSideHistory(options), error =>
      error.code === 'TDX_SHARE_PRECISION_UNAVAILABLE' && /零股/.test(error.message));
    await assert.rejects(readTdxTradeSideDay({request:async()=>{throw new Error('No precision');}},day({code})),
      error=>error.code==='TDX_SHARE_PRECISION_UNAVAILABLE');
  }
});

test('history skips already archived dates, freezes the starting session and reports gaps', async () => {
  let clock=Date.parse('2026-10-13T06:59:00Z');
  let persisted=0;
  const result=await fetchTdxTradeSideHistory({code:'603818',now:()=>clock,limit:30,
    existingDates:new Set(['2026-10-09']),
    request:async url=>{
      assert(new URL(url).searchParams.get('param').endsWith(','));
      clock=Date.parse('2026-10-13T07:20:00Z');
      return {ok:true,json:async()=>dailyPayload([bar('2026-10-09'),bar('2026-10-12'),bar('2026-10-13')])};
    },
    connect:async()=>connection({0:body([trade()]),1:empty()}),
    onDay:async()=>{persisted+=1;},
  });
  assert.equal(persisted,1);
  assert.deepEqual(result.targetDates,['2026-10-09','2026-10-12']);
  assert.equal(result.quality.done,2);
  assert.equal(result.rows.length,1);
});

test('TCP responses may be fragmented and compressed without truncating records', async () => {
  const reply=body([trade()]);
  const zipped=deflateSync(reply);
  const frame=Buffer.alloc(16);
  frame.writeUInt16LE(zipped.length,12);frame.writeUInt16LE(reply.length,14);
  const server=net.createServer(socket=>{
    let incoming=Buffer.alloc(0),stage=0;
    socket.on('data',chunk=>{
      incoming=Buffer.concat([incoming,chunk]);
      const sizes=[13,13,42,28];
      while(stage<sizes.length && incoming.length>=sizes[stage]) {
        incoming=incoming.subarray(sizes[stage]);
        const bytes=stage<3?Buffer.alloc(16):Buffer.concat([frame,zipped]);
        stage+=1;
        for(let i=0;i<bytes.length;i+=3) socket.write(bytes.subarray(i,i+3));
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let client;
  try {
    client=await connectTdxHistory({host:'127.0.0.1',port:server.address().port});
    const response=await client.request(buildTdxHistoryPacket({code:'603818',market:1,date:'2026-10-13'}));
    assert.deepEqual(parseTdxHistoryTransactions(response),[trade()]);
  } finally {
    client?.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
