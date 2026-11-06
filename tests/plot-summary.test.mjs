import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = { window: { YuzukiMemory: {} } };
vm.createContext(sandbox);
const source = fs.readFileSync(new URL('../config/plot-summary.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'plot-summary.js' });

const plotSummary = sandbox.window.YuzukiMemory.PlotSummary;
const parserBranchSnapshots = new WeakMap();

function loadPlotRecordNormalizer() {
    const uiSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
    const match = uiSource.match(/    function normalizePlotSummaryRecordValues\(record, options = \{\}\) \{[\s\S]*?\n    \}/);
    assert.ok(match, 'plot summary record normalizer should remain available');
    const normalizerSandbox = {
        result: null,
        saveCount: 0,
        YuzukiMemory: { PlotSummary: plotSummary },
        createPlotLineId: (() => {
            let nextId = 0;
            return () => `generated_${nextId += 1}`;
        })(),
        normalizePlotSummaryStoredText: (value) => plotSummary.normalizeStoredLines(value),
        saveState() { normalizerSandbox.saveCount += 1; },
    };
    vm.createContext(normalizerSandbox);
    vm.runInContext(`${match[0]}\nresult = normalizePlotSummaryRecordValues;`, normalizerSandbox, {
        filename: 'memory-window-plot-normalizer.js',
    });
    return normalizerSandbox;
}

function loadPlotItemReader() {
    const uiSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
    const itemsMatch = uiSource.match(/    function getPlotSummaryItems\(text = '', options = \{\}\) \{[\s\S]*?\n    \}/);
    const entriesMatch = uiSource.match(/    function getPlotSummaryItemEntries\(record, kind = activePlotSummaryKind\) \{[\s\S]*?\n    \}/);
    assert.ok(itemsMatch, 'plot summary item reader should remain available');
    assert.ok(entriesMatch, 'plot summary metadata reader should remain available');
    const readerSandbox = {
        result: null,
        YuzukiMemory: { PlotSummary: plotSummary },
        activePlotSummaryKind: 'main',
        getPlotSummaryKindKey: (kind) => kind === 'branch' ? 'branch' : 'main',
        getPlotSummaryLines: (record, kind) => String(record?.values?.[kind === 'branch' ? '支线' : '主线'] || '')
            .split(/\n+/).map((line) => line.trim()).filter(Boolean),
        normalizePlotItemHiddenStates: (record, kind, count) => {
            record.hiddenPlotItems[kind] = record.hiddenPlotItems[kind].slice(0, count);
            return record.hiddenPlotItems[kind];
        },
        normalizePlotItemMeta: (record, kind, count) => {
            record.plotItemMeta[kind] = record.plotItemMeta[kind].slice(0, count);
            return record.plotItemMeta[kind];
        },
    };
    vm.createContext(readerSandbox);
    vm.runInContext(`${itemsMatch[0]}\n${entriesMatch[0]}\nresult = { getPlotSummaryItems, getPlotSummaryItemEntries };`, readerSandbox, {
        filename: 'memory-window-plot-reader.js',
    });
    return readerSandbox.result;
}

function createParserSandbox() {
    const parserSandbox = {
        console,
        CustomEvent: class CustomEvent {},
        localStorage: {
            getItem() { return null; },
        },
        setTimeout() { return 1; },
        clearTimeout() {},
        window: {
            YuzukiMemory: {},
            setTimeout() { return 1; },
            clearTimeout() {},
        },
    };
    vm.createContext(parserSandbox);
    vm.runInContext(source, parserSandbox, { filename: 'plot-summary.js' });
    const parserSource = fs.readFileSync(new URL('../config/memory-tag-parser.js', import.meta.url), 'utf8');
    vm.runInContext(parserSource, parserSandbox, { filename: 'memory-tag-parser.js' });
    const branchSnapshotSource = fs.readFileSync(new URL('../config/branch-snapshot.js', import.meta.url), 'utf8');
    vm.runInContext(branchSnapshotSource, parserSandbox, { filename: 'branch-snapshot.js' });
    const parser = parserSandbox.window.YuzukiMemory.MemoryTagParser;
    parserBranchSnapshots.set(parser, parserSandbox.window.YuzukiMemory.BranchSnapshot);
    return parser;
}

function parserSandboxBranchSnapshot(parser) {
    return parserBranchSnapshots.get(parser);
}

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

test('display grouping reunites the screenshot dates and preserves every source node', () => {
    const items = plotSummary.normalizeStoredItems([
        '0117年12月06日,12:00-12:30\t午间事件',
        '0117年12月07日,09:00-09:30\t次日事件',
        '上弦历117年12月06日,08:00-08:30\t早间事件',
    ]).map((item, index) => ({ ...item, id: `node-${index}`, hidden: false }));
    const before = JSON.stringify(items);
    const groups = plotSummary.groupItemsByDay(items);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].date, '上弦历117年12月06日');
    assert.equal(groups[1].date, '上弦历117年12月07日');
    assert.deepEqual(Array.from(groups[0].items, (item) => item.text), ['早间事件', '午间事件']);
    assert.equal(groups.flatMap((group) => group.items).length, 3);
    assert.ok(groups[0].items.every((item) => items.includes(item)));
    assert.equal(JSON.stringify(items), before);
});

test('display grouping normalizes padding, separators, and Chinese regnal numerals', () => {
    const modern = plotSummary.groupItemsByDay([
        { date: '2026年1月6日' }, { date: '2026-01-06' }, { date: '2026/1/6' },
    ]);
    assert.equal(modern.length, 1);
    assert.equal(modern[0].date, '2026年01月06日');
    const ancient = plotSummary.groupItemsByDay([
        { date: '景和七年正月初六日' }, { date: '景和7年01月06日' },
    ]);
    assert.equal(ancient.length, 1);
    assert.equal(ancient[0].date, '景和七年正月初六日');
});

test('display calendar inference uses chat context and remains local to each call', () => {
    const items = [{ date: '0117年12月07日' }];
    const options = { contextDates: ['上弦历117年12月06日,08:00\t另一个摘要分组'] };
    assert.equal(plotSummary.groupItemsByDay(items, options)[0].date, '上弦历117年12月07日');
    assert.equal(plotSummary.groupItemsByDay(items, {
        contextDates: ['上弦历117年12月06日,08:00\t提到下弦历117年12月06日的往事'],
    })[0].date, '上弦历117年12月07日');
    assert.equal(plotSummary.groupItemsByDay(items)[0].date, '0117年12月07日');
    assert.equal(plotSummary.groupItemsByDay([{ date: '0118年1月1日' }], options)[0].date, '0118年01月01日');
});

test('competing calendars and yearless dates remain separate', () => {
    const groups = plotSummary.groupItemsByDay([
        { date: '上弦历117年12月06日' }, { date: '下弦历117年12月06日' },
        { date: '0117年12月06日' }, { date: '12月06日' }, { date: '' },
    ]);
    assert.equal(groups.length, 5);
    assert.equal(new Set(groups.map((group) => group.date)).size, 5);
    const ambiguous = plotSummary.groupItemsByDay([{ date: '0117年12月06日' }], {
        contextDates: ['上弦历117年12月07日', '下弦历117年12月08日'],
    });
    assert.equal(ambiguous[0].date, '0117年12月06日');
});

test('display grouping preserves identical nodes, hidden states and chronological ordering', () => {
    const hidden = { date: '117年12月6日', startTime: '07:00', hidden: true, id: 'hidden' };
    const duplicate = { date: '0117年12月06日', startTime: '08:00', id: 'first' };
    const groups = plotSummary.groupItemsByDay([
        hidden, { date: '117年12月6日', startTime: '12:00', id: 'late' },
        duplicate, { ...duplicate, id: 'second' },
    ]);
    assert.deepEqual(Array.from(groups[0].items, (item) => item.id), ['first', 'second', 'late', 'hidden']);
    assert.equal(groups[0].items[3], hidden);
});

test('plot UI delegates grouping with dates from both current-chat summary fields', () => {
    const uiSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
    const match = uiSource.match(/    function groupPlotSummaryItemsByDay\(items = \[\], options = \{\}\) \{[\s\S]*?\n    \}/);
    assert.ok(match);
    const uiSandbox = { YuzukiMemory: { PlotSummary: plotSummary } };
    vm.createContext(uiSandbox);
    vm.runInContext(`${match[0]}\nresult = groupPlotSummaryItemsByDay;`, uiSandbox);
    assert.equal(uiSandbox.result([{ date: '0117年12月06日' }], {
        contextDates: ['上弦历117年12月07日'],
    })[0].date, '上弦历117年12月06日');
    assert.match(uiSource, /groupPlotSummaryItemsByDay\(displayItems, \{\s*contextDates: \[getRecordValue\(record, '主线'\), getRecordValue\(record, '支线'\)\]/);
});

test('plot record normalization keeps metadata and hidden state aligned after time sorting', () => {
    const normalizerSandbox = loadPlotRecordNormalizer();
    const record = {
        values: {
            主线: '2026年1月4日,13:00-13:10\t较晚剧情\n2026年1月4日,11:00-11:10\t较早剧情',
            支线: '',
        },
        plotItemMeta: {
            main: [
                { id: 'late', text: '较晚剧情', source: 'manual' },
                { id: 'early', text: '较早剧情', source: 'realtime' },
            ],
            branch: [],
        },
        hiddenPlotItems: { main: [true, false], branch: [] },
    };

    assert.equal(normalizerSandbox.result(record, { save: false }), true);
    assert.match(record.values.主线, /^2026年1月4日,11:00-11:10\t较早剧情/);
    assert.deepEqual(Array.from(record.plotItemMeta.main, (item) => item.id), ['early', 'late']);
    assert.deepEqual(Array.from(record.hiddenPlotItems.main), [false, true]);
    assert.equal(record.plotItemMeta.main[0].source, 'realtime');
    assert.equal(record.plotItemMeta.main[1].source, 'manual');
    assert.equal(normalizerSandbox.saveCount, 0);
});

test('plot record normalization preserves identical rows with distinct metadata and hidden state', () => {
    const duplicate = '2026年1月4日,11:00-11:10\t相同剧情';
    assert.equal(plotSummary.normalizeStoredItems([duplicate, duplicate]).length, 1);

    const normalizerSandbox = loadPlotRecordNormalizer();
    const record = {
        values: { 主线: `${duplicate}\n${duplicate}`, 支线: '' },
        plotItemMeta: {
            main: [
                { id: 'realtime', text: duplicate, source: 'realtime', sourceRange: { start: 1, end: 2 } },
                { id: 'manual', text: duplicate, source: 'manual' },
            ],
            branch: [],
        },
        hiddenPlotItems: { main: [false, true], branch: [] },
    };

    assert.equal(normalizerSandbox.result(record, { save: false }), false);
    assert.equal(record.values.主线.split('\n').length, 2);
    assert.deepEqual(Array.from(record.plotItemMeta.main, (item) => item.id), ['realtime', 'manual']);
    assert.deepEqual(Array.from(record.hiddenPlotItems.main), [false, true]);
});

test('plot item count and reader preserve identical rows with aligned metadata', () => {
    const duplicate = '2026年1月4日,11:00-11:10\t相同剧情';
    const reader = loadPlotItemReader();
    const record = {
        values: { 主线: `${duplicate}\n${duplicate}`, 支线: '' },
        plotItemMeta: { main: [{ id: 'first' }, { id: 'second' }], branch: [] },
        hiddenPlotItems: { main: [false, true], branch: [] },
    };

    assert.equal(reader.getPlotSummaryItems(record.values.主线, {
        metadata: record.plotItemMeta.main,
        preserveDistinctMetadata: true,
    }).length, 2);
    const entries = reader.getPlotSummaryItemEntries(record, 'main');
    assert.equal(entries.length, 2);
    assert.deepEqual(Array.from(entries, (item) => item.lineId), ['first', 'second']);
    assert.deepEqual(Array.from(entries, (item) => item.hidden), [false, true]);
});

test('plot record normalization marks generated metadata as legacy and keeps its original index', () => {
    const normalizerSandbox = loadPlotRecordNormalizer();
    const record = {
        values: {
            主线: '2026年1月4日,13:00-13:10\t较晚旧剧情\n2026年1月4日,11:00-11:10\t较早旧剧情',
            支线: '',
        },
        plotItemMeta: { main: [], branch: [] },
        hiddenPlotItems: { main: [true, false], branch: [] },
    };

    assert.equal(normalizerSandbox.result(record, { save: false }), true);
    assert.deepEqual(Array.from(record.plotItemMeta.main, (item) => item.legacyUnanchored), [true, true]);
    assert.deepEqual(Array.from(record.plotItemMeta.main, (item) => item.legacyIndex), [1, 0]);
    assert.deepEqual(Array.from(record.hiddenPlotItems.main), [false, true]);
});

test('plot record normalization writes back legacy-only metadata repairs', () => {
    const normalizerSandbox = loadPlotRecordNormalizer();
    const line = '2026年1月4日,11:00-11:10\t旧剧情';
    const record = {
        values: { 主线: line, 支线: '' },
        plotItemMeta: { main: [{ id: 'legacy-id', text: line, legacyUnanchored: true }], branch: [] },
        hiddenPlotItems: { main: [false], branch: [] },
    };

    assert.equal(normalizerSandbox.result(record, { save: false }), true);
    assert.equal(record.plotItemMeta.main[0].legacyUnanchored, true);
    assert.equal(record.plotItemMeta.main[0].legacyIndex, 0);
});

test('date matching keeps narrative prefixes out of era names', () => {
    assert.equal(plotSummary.getDateToken('现在是2025年01月01日'), '2025年01月01日');
    assert.equal(plotSummary.parseDateToken('现在是2025年01月01日').style, 'cn');
    assert.equal(plotSummary.getDateToken('某人于景和七年三月十五日'), '景和七年三月十五日');
    assert.equal(plotSummary.parseDateToken('故事发生在景和七年三月十五日。').era, '景和');
});

test('realtime plot batch inherits its first explicit date instead of the historical latest date', () => {
    const parser = createParserSandbox();
    const rows = parser.extractMemoryRows(`
<Memory>
# 剧情摘要|[主线摘要]|内容:[2026年1月4日,12:10-13:05] | 内容: 一行完整日期；[13:25-13:40] | 内容: 后续只有时间
</Memory>`);

    assert.equal(rows.length, 2);
    assert.equal(rows[1].values['日期'], '2026年1月4日,13:25-13:40');

    const state = parser.createDefaultState();
    state.records.plot_summary = [{
        id: 'plot',
        values: {
            主线: '2026年1月6日,09:00-10:00\t历史最新日期',
            支线: '',
        },
    }];
    assert.equal(parser.applyRowsToState(state, rows), 2);
    assert.match(state.records.plot_summary[0].values.主线, /2026年1月4日,13:25-13:40\t后续只有时间/);
    assert.doesNotMatch(state.records.plot_summary[0].values.主线, /2026年1月6日,13:25-13:40/);

    const leadingTimeRows = parser.extractMemoryRows(`
<Memory>
# 剧情摘要|[主线摘要]|内容:[11:30-11:40] | 内容: 日期前的时间；[2026年1月4日,11:40-11:50] | 内容: 稍后给出完整日期
</Memory>`);
    assert.equal(leadingTimeRows.length, 2);
    assert.equal(leadingTimeRows[0].values['日期'], '2026年1月4日,11:30-11:40');
});

test('generic plot headings default to main while explicit storyline labels still take precedence', () => {
    const parser = createParserSandbox();
    const rows = parser.extractMemoryRows(`<Memory><!--
#剧情摘要
[2026年1月4日,08:00-09:15]|内容:A和B商量去找C;[09:25-12:15]|内容:A购买礼物
[2026年1月4日,08:00-09:10]|内容:C和D商讨工作;[09:30-10:20]|内容:C确认账册异常
[支线摘要]|日期:2026年1月4日,13:00-13:10|内容:D联系同事
#支线摘要
[2026年1月4日,14:00-14:10]|内容:D离开公司
#剧情摘要
[2026年1月4日,15:00-15:10]|内容:A回到家中
#角色档案
[A]|身份:顾客
--></Memory>`);
    assert.equal(rows.length, 8);
    assert.deepEqual(Array.from(rows.slice(0, 7), row => row.primaryValue), [
        '主线摘要', '主线摘要', '主线摘要', '主线摘要', '支线摘要', '支线摘要', '主线摘要',
    ]);
    assert.equal(rows[1].values.日期, '2026年1月4日,09:25-12:15');
    assert.equal(rows[3].values.日期, '2026年1月4日,09:30-10:20');
    assert.equal(rows[7].table, '角色档案');
    assert.equal(rows[7].values.身份, '顾客');
});

test('plot extraction rejects explicit OOC and quote blocks without filtering narrative mentions', () => {
    const parser = createParserSandbox();
    const rows = parser.extractMemoryRows(`
<Memory>
# 剧情摘要|[主线摘要]|内容:[2026年1月4日,12:00-12:10] | 内容: > **[OOC助手解答]**：旧剧情说明；[12:10-12:20] | 内容: 【OOC说明】这不是剧情；[12:20-12:30] | 内容: 原文引用：用户上一轮的话；[12:30-12:40] | 内容: 她引用古籍后找到了密道
</Memory>`);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].values['摘要内容'], '她引用古籍后找到了密道');
    assert.equal(rows[0].values['日期'], '2026年1月4日,12:30-12:40');
});

test('plot write path also rejects explicit non-narrative rows supplied outside tag extraction', () => {
    const parser = createParserSandbox();
    const state = parser.createDefaultState();
    const count = parser.applyRowsToState(state, [{
        table: '剧情摘要',
        primaryValue: '主线摘要',
        values: { 日期: '2026年1月4日,12:00-12:10', 摘要内容: '> 引用块' },
    }]);

    assert.equal(count, 0);
    assert.equal(state.records.plot_summary, undefined);
});

test('plot replay cannot revive a manually deleted realtime item with a regenerated id', () => {
    const parser = createParserSandbox();
    const branchSnapshot = parserSandboxBranchSnapshot(parser);
    const state = parser.createDefaultState();
    const deletedText = '2026年1月4日,12:00-12:10\t进入遗迹';
    const sourceRange = { start: 4, end: 5 };
    const floorScope = { sessionId: 'plot-replay-test' };
    const record = {
        id: 'plot',
        values: { 主线: '', 支线: '' },
        plotItemMeta: { main: [], branch: [] },
        hiddenPlotItems: { main: [], branch: [] },
    };
    state.records.plot_summary = [record];
    branchSnapshot.markDeletedPlotItems(record, [{
        kind: 'main',
        raw: deletedText,
        meta: { id: 'deleted-original-id', text: deletedText, sourceRange, floorScope },
    }]);

    assert.equal(parser.applyRowsToState(state, [{
        table: '剧情摘要',
        primaryValue: '主线摘要',
        values: { 日期: '2026年1月4日,12:00-12:10', 摘要内容: '进入遗迹' },
    }], {
        source: 'realtime',
        range: sourceRange,
        floorScope,
    }), 1);
    assert.equal(record.values.主线, '');
    assert.equal(record.plotItemMeta.main.length, 0);
    assert.equal(record.hiddenPlotItems.main.length, 0);
});
