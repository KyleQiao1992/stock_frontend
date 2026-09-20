import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndustryDirectory, parseAnnualBars, createThsProvider } from './heatmapThs.js';
import { summarizeHistory, createHistoryService } from './heatmapHistory.js';
const annual = (data) => `callback(${JSON.stringify({data})})`;
test('THS directory deduplicates codes and rejects non-directory responses', () => {
  const link='<a href="http://q.10jqka.com.cn/thshy/detail/code/881121/" target="_blank">半导体</a>';
  assert.deepEqual(parseIndustryDirectory(link+link),[{code:'THS881121',name:'半导体'}]);
  assert.throws(()=>parseIndustryDirectory('<html>Unavailable</html>'));
  assert.throws(()=>parseAnnualBars(annual('20260105,1,1,1,100,1,-')));
});
test('annual cache supports September then January and obtains prior-year baseline', async () => {
  const calls=[];
  const provider=createThsProvider(async(url)=>{
    calls.push(url);
    if(url.endsWith('2025.js'))return annual('20251231,1,1,1,100,1,100000000');
    return annual('20260105,1,1,1,110,1,200000000;20260901,1,1,1,99,1,300000000');
  });
  const item={code:'THS881121'};
  let rows=await provider.bars(item,{start:'2026-09-01',end:'2026-09-18'});
  assert.equal(summarizeHistory(rows,'2026-09-01','2026-09-18').pct,-10);
  rows=await provider.bars(item,{start:'2026-01-01',end:'2026-01-05'});
  assert.equal(summarizeHistory(rows,'2026-01-01','2026-01-05').pct,10);
  assert.equal(summarizeHistory(rows,'2026-01-01','2026-01-05').amount,2);
  assert.equal(calls.length,2);
  assert.equal(summarizeHistory(rows,'2026-01-03','2026-01-04'),null);
});
test('provider metadata and underlying errors are exposed without substituting live data', async()=>{
  const provider={source:'test',supportsDrilldown:false,listing:async()=>[{name:'行业',code:'THS881121'}],bars:async()=>{throw new Error('HTTP 503')}};
  const service=createHistoryService(undefined,provider);
  const q={start:'2026-09-01',end:'2026-09-18',board:''};
  service.query(q);
  await new Promise(resolve=>setImmediate(resolve));
  const r=service.query(q);
  assert.equal(r.status,'complete');assert.equal(r.source,'test');assert.equal(r.supportsDrilldown,false);
  assert.equal(r.failureReasons['行业'],'HTTP 503');assert.equal(r.industries.length,0);
});
