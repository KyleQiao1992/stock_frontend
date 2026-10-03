import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewsLoader, parseNews, newsSymbol } from './stockNews.js';
test('news exchange mapping includes Shanghai, Shenzhen and Beijing', () => {
  assert.equal(newsSymbol('603818'), 'sh603818');
  assert.equal(newsSymbol('000001'), 'sz000001');
  assert.equal(newsSymbol('920001'), 'bj920001');
  assert.equal(newsSymbol('00700', 'hk'), 'hk00700');
  assert.throws(() => newsSymbol('AAPL'));
  assert.throws(() => newsSymbol('700', 'hk'));
});
test('untrusted links are omitted; duplicates removed; malformed responses fail', () => {
  const result = parseNews({code:0,data:{data:[{id:'a',title:'标题',url:'javascript:alert(1)'},{id:'a',title:'标题'},{title:'合法',url:'https://example.com/news'},{title:''}]}});
  assert.equal(result.length,2); assert.equal(result[0].url,'');
  assert.equal(result[1].url,'https://example.com/news');
  assert.throws(()=>parseNews({code:1,data:{data:[]}}));
});
test('loader shares concurrent requests, isolates stock/category cache and retries failures', async()=>{
  let count=0;let fail=false;
  const load=createNewsLoader(async()=>{count++;if(fail)throw new Error('offline');return {ok:true,json:async()=>({code:0,data:{data:[]}})};});
  await Promise.all([load('603818','news'),load('603818','news')]);assert.equal(count,1);
  await load('603818','news');assert.equal(count,1);
  await load('603818','notice');await load('688610','news');assert.equal(count,3);
  fail=true;await assert.rejects(load('603818','news',true));
  fail=false;await load('603818','news',true);assert.equal(count,5);
});
