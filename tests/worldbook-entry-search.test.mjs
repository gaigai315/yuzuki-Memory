import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

test('worldbook entry dialog filters entry titles and content without rebuilding the list', () => {
    assert.match(source, /placeholder = '搜索条目名称或内容'/);
    assert.match(source, /entry\.comment.*entry\.content.*normalize\('NFKC'\)/s);
    assert.match(source, /terms\.every\(\(term\) => choice\.searchText\.includes\(term\)\)/);
    assert.match(source, /choice\.row\.hidden = !matches/);
    assert.doesNotMatch(source, /applyEntrySearch[\s\S]*?list\.innerHTML\s*=/);
});

test('entry search keeps hidden selections and select-all targets visible results only', () => {
    assert.match(source, /getVisibleChoices\(\)\.forEach\(\(\{ input \}\) => \{ input\.checked = selectAll\.checked; \}\)/);
    assert.match(source, /choices\.filter\(\(\{ input \}\) => input\.checked\)\.map/);
    assert.match(source, /全选筛选结果/);
    assert.match(source, /没有找到匹配的条目/);
});

test('entry search controls and hidden rows use scoped styles', () => {
    assert.match(css, /#yzm-memory-root \.yzm-worldbook-entry-search/);
    assert.match(css, /#yzm-memory-root \.yzm-worldbook-entry-row\[hidden\]/);
});
