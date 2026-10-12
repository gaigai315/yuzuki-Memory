import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

test('keyboard viewport changes preserve the intended icon position without measurement feedback', () => {
    const window = { visualViewport: { width: 390, height: 800, offsetLeft: 0, offsetTop: 0 } };
    let writes = 0;
    const values = {};
    const style = new Proxy(values, { set(target, key, value) { writes++; target[key] = value; return true; } });
    const button = {
        isConnected: true, hidden: false, dataset: {}, style,
        classList: { contains: () => false },
        getBoundingClientRect() { throw new Error('screen measurements must not affect placement'); },
    };
    const context = vm.createContext({
        window, document: { documentElement: {} }, Number, Math,
        getFloatingIconSize: () => 34, getFloatingIconEdgeInset: () => 0,
        isMemoryShellOpen: () => false, isStoryDirectorCardOpen: () => false,
        YuzukiMemory: {}, saveFloatingIconPosition() { throw new Error('resize must not save'); },
    });
    const start = memoryWindowSource.indexOf('    function clampFloatingIconPosition(');
    const end = memoryWindowSource.indexOf('    function armShellOpenInteractionGuard(', start);
    vm.runInContext(memoryWindowSource.slice(start, end), context);
    context.applyFloatingIconPosition(button, 356, 576);
    window.visualViewport.height = 400;
    window.visualViewport.offsetTop = 80;
    context.ensureFloatingIconVisible(button);
    assert.equal(style.top, '446px');
    assert.equal(button.dataset.yzmFloatingTop, '576');
    window.visualViewport.height = 800;
    window.visualViewport.offsetTop = 0;
    context.ensureFloatingIconVisible(button);
    assert.equal(style.top, '576px');
    const stableWrites = writes;
    // right/bottom are unchanged; left/top must remain untouched on repeated checks.
    for (let i = 0; i < 20; i++) context.ensureFloatingIconVisible(button);
    assert.equal(writes - stableWrites, 40);
    button.classList.contains = () => true;
    window.visualViewport.height = 300;
    context.ensureFloatingIconVisible(button);
    assert.equal(style.top, '576px');
});

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
