import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

test('all nine floating icon styles are registered with bundled assets', () => {
    const stylesBlock = memoryWindowSource.match(
        /const FLOATING_ICON_STYLES = Object\.freeze\(\[([\s\S]*?)\]\);/,
    );
    assert.ok(stylesBlock, 'floating icon style registry should exist');

    const registeredStyles = [...stylesBlock[1].matchAll(
        /\{ id: '(xftb\d+)', label: '样式 (\d+)', file: 'ui\/(xftb\d+\.png)' \}/g,
    )].map((match) => ({ id: match[1], labelNumber: match[2], file: match[3] }));

    assert.deepEqual(registeredStyles, Array.from({ length: 9 }, (_, index) => {
        const number = String(index + 1);
        return { id: `xftb${number}`, labelNumber: number, file: `xftb${number}.png` };
    }));

    registeredStyles.forEach(({ file }) => {
        assert.equal(fs.existsSync(new URL(`../ui/${file}`, import.meta.url)), true, `${file} should exist`);
    });
});

test('floating icon picker keeps a three-column layout for nine choices', () => {
    const columnRules = memoryCssSource.match(
        /#yzm-memory-root \.yzm-floating-icon-picker-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/g,
    ) || [];

    assert.equal(columnRules.length, 2);
});
