import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const compatSource = fs.readFileSync(new URL('../config/mobile-world-info-compat.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name),
    };
}

function loadCompat({ enabled = false, touch = true, existingSelect2 = false } = {}) {
    const calls = [];
    const select = {
        dataset: {},
        classList: createClassList(existingSelect2 ? ['select2-hidden-accessible'] : []),
        options: [
            { value: '0', selected: true },
            { value: '1', selected: false },
        ],
    };
    const state = { active: existingSelect2 };
    const wrapper = {
        data: (key) => key === 'select2' && state.active ? {} : undefined,
        select2: (options) => {
            calls.push(options);
            if (options === 'destroy') {
                state.active = false;
                select.classList.remove('select2-hidden-accessible');
            } else {
                state.active = true;
                select.classList.add('select2-hidden-accessible');
            }
            return wrapper;
        },
    };
    const jquery = () => wrapper;
    jquery.fn = { select2() {} };

    const sandbox = {
        console,
        navigator: { maxTouchPoints: touch ? 5 : 0 },
        localStorage: { getItem: () => null },
        document: {
            getElementById: (id) => id === 'world_info' ? select : null,
            addEventListener() {},
        },
        window: {
            YuzukiMemory: {
                GlobalSettings: {
                    get: () => ({ mobileWorldInfoSelect2Compat: enabled }),
                },
            },
            jQuery: jquery,
            matchMedia: (query) => ({ matches: touch && /pointer: coarse|hover: none/.test(query) }),
            setTimeout,
            clearTimeout,
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(compatSource, sandbox, { filename: 'mobile-world-info-compat.js' });
    return { sandbox, select, calls };
}

test('mobile world-info compatibility defaults to disabled', () => {
    const { sandbox, calls } = loadCompat();
    assert.equal(sandbox.window.YuzukiMemory.MobileWorldInfoCompat.sync(), false);
    assert.deepEqual(calls, []);
});

test('enabled touch devices initialize Select2 once and preserve selection', () => {
    const { sandbox, select, calls } = loadCompat({ enabled: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
        width: '100%',
        placeholder: '未启用世界书，点击这里选择',
        allowClear: true,
        closeOnSelect: false,
    });
    assert.equal(select.dataset.yzmMobileWorldInfoCompat, 'true');
    assert.deepEqual(select.options.map((option) => option.selected), [true, false]);
    assert.equal(sandbox.window.YuzukiMemory.MobileWorldInfoCompat.sync(), true);
    assert.equal(calls.length, 1);
});

test('disabling destroys only the Select2 instance created by this module', () => {
    const owned = loadCompat({ enabled: true });
    owned.sandbox.window.YuzukiMemory.MobileWorldInfoCompat.setEnabled(false);
    assert.equal(owned.calls.at(-1), 'destroy');
    assert.equal(owned.select.dataset.yzmMobileWorldInfoCompat, undefined);
    assert.deepEqual(owned.select.options.map((option) => option.selected), [true, false]);

    const external = loadCompat({ enabled: true, existingSelect2: true });
    assert.deepEqual(external.calls, []);
    external.sandbox.window.YuzukiMemory.MobileWorldInfoCompat.setEnabled(false);
    assert.deepEqual(external.calls, []);
});

test('non-touch devices are left unchanged even when the setting is enabled', () => {
    const { calls, select } = loadCompat({ enabled: true, touch: false });
    assert.deepEqual(calls, []);
    assert.equal(select.dataset.yzmMobileWorldInfoCompat, undefined);
});

test('plugin settings expose a default-off switch and load the compatibility module', () => {
    assert.match(memoryWindowSource, /mobileWorldInfoSelect2Compat:\s*false/);
    assert.match(memoryWindowSource, /移动端世界书折叠兼容/);
    assert.match(memoryWindowSource, /MobileWorldInfoCompat\?\.setEnabled\?\.\(isOn\)/);
    assert.match(indexSource, /'config\/mobile-world-info-compat\.js'/);
});
