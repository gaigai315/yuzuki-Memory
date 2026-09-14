import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = { window: { YuzukiMemory: {} } };
vm.createContext(sandbox);
const source = fs.readFileSync(new URL('../config/plot-summary.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'plot-summary.js' });

const plotSummary = sandbox.window.YuzukiMemory.PlotSummary;

test('ancient regnal dates remain visible in plot summary groups', () => {
    const items = plotSummary.normalizeStoredItems(
        '[景和七年三月十五日,20:00-20:30] | 内容: 沈昭阳将楚玄带回永宁王府',
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].date, '景和七年三月十五日');
    assert.equal(items[0].startTime, '20:00');
    assert.equal(items[0].endTime, '20:30');
    assert.equal(items[0].text, '沈昭阳将楚玄带回永宁王府');
    assert.match(items[0].raw, /^景和七年三月十五日,20:00-20:30\t/);
});

test('ancient dates support dynasty names, lunar-style days, and midnight rollover', () => {
    const sourceText = '大明永乐十二年九月初八日·🍂·辰时(07:30)·☀️';
    const date = plotSummary.getDateToken(sourceText);
    const parts = plotSummary.parseDateToken(date);

    assert.equal(date, '大明永乐十二年九月初八日');
    assert.equal(parts.era, '大明永乐');
    assert.equal(parts.year, 12);
    assert.equal(parts.month, 9);
    assert.equal(parts.day, 8);
    assert.equal(plotSummary.addDateDays('景和七年三月十五日', 1), '景和七年三月十六日');
    assert.equal(plotSummary.parseDateToken('大唐贞观元年正月初一日').year, 1);
    assert.equal(plotSummary.parseDateToken('大元至元元年正月初一日').era, '大元至元');
    assert.equal(plotSummary.addDateDays('大唐贞观元年正月初一日', 1), '大唐贞观元年正月初二日');
});

test('modern date parsing remains unchanged', () => {
    const items = plotSummary.normalizeStoredItems(
        '[2025年01月01日,14:30-15:00] | 内容: 现代剧情事件',
    );

    assert.equal(items[0].date, '2025年01月01日');
    assert.equal(items[0].startTime, '14:30');
    assert.equal(items[0].endTime, '15:00');
});

test('date matching keeps narrative prefixes out of era names', () => {
    assert.equal(plotSummary.getDateToken('现在是2025年01月01日'), '2025年01月01日');
    assert.equal(plotSummary.parseDateToken('现在是2025年01月01日').style, 'cn');
    assert.equal(plotSummary.getDateToken('某人于景和七年三月十五日'), '景和七年三月十五日');
    assert.equal(plotSummary.parseDateToken('故事发生在景和七年三月十五日。').era, '景和');
});
