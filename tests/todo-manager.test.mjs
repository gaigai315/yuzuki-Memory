import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {
    console,
    SillyTavern: { getContext: () => null },
    window: {
        YuzukiMemory: {},
        setTimeout: () => 1,
        clearTimeout() {},
        addEventListener() {},
    },
};
vm.createContext(sandbox);
const source = fs.readFileSync(new URL('../config/todo-manager.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'todo-manager.js' });

const todoManager = sandbox.window.YuzukiMemory.TodoManager;

test('todo items display in chronological order while retaining their source indexes', () => {
    const items = todoManager.parseTodoItems([
        '〔1〕2035-07-19 14:00·第二轮业务面试（高）',
        '〔2〕2035-07-19 10:16·审查财务报表（高）',
        '〔3〕2035-07-19 10:30·挑选礼物（中）',
        '〔4〕2035-07-19 12:00·共进午餐（中）',
        '〔5〕2035-07-20·次日事项（低）',
        '〔6〕没有明确时间的事项（低）',
    ].join(';'));

    const sorted = todoManager.sortTodoItemsChronologically(items);

    assert.deepEqual(
        Array.from(sorted, (item) => item.dateTime || item.text),
        [
            '2035-07-19 10:16',
            '2035-07-19 10:30',
            '2035-07-19 12:00',
            '2035-07-19 14:00',
            '2035-07-20',
            '没有明确时间的事项',
        ],
    );
    assert.deepEqual(Array.from(sorted, (item) => item.sourceIndex), [1, 2, 3, 0, 4, 5]);
});

test('a sorted todo can update and delete the matching original item', () => {
    const original = [
        '〔1〕2035-07-19 14:00·第二轮业务面试（高）',
        '〔2〕2035-07-19 10:16·审查财务报表（高）',
        '〔3〕2035-07-19 10:30·挑选礼物（中）',
    ].join(';');
    const firstDisplayed = todoManager.sortTodoItemsChronologically(todoManager.parseTodoItems(original))[0];

    const updated = todoManager.updateTodoItemAt(original, firstDisplayed.sourceIndex, {
        dateTime: '2035-07-19 11:20',
        text: '复核公司财务报表',
        priority: '低',
    });

    assert.equal(updated.changed, true);
    assert.equal(updated.error, '');
    assert.deepEqual(
        Array.from(todoManager.parseTodoItems(updated.value), (item) => item.rawContent),
        [
            '2035-07-19 14:00·第二轮业务面试（高）',
            '2035-07-19 11:20·复核公司财务报表(低)',
            '2035-07-19 10:30·挑选礼物（中）',
        ],
    );

    const deleted = todoManager.deleteTodoItemAt(updated.value, firstDisplayed.sourceIndex);
    assert.equal(deleted.changed, true);
    assert.deepEqual(
        Array.from(todoManager.parseTodoItems(deleted.value), (item) => item.text),
        ['第二轮业务面试', '挑选礼物'],
    );
});

test('todo updates reject invalid dates and empty content', () => {
    const original = '〔1〕2035-07-19 10:16·审查财务报表（高）;〔2〕2035-07-19 12:00·共进午餐（中）';

    const invalidDate = todoManager.updateTodoItemAt(original, 0, {
        dateTime: '2035-02-30 10:16',
        text: '审查财务报表',
        priority: '高',
    });
    const emptyText = todoManager.updateTodoItemAt(original, 0, {
        dateTime: '2035-07-19 10:16',
        text: '   ',
        priority: '高',
    });
    const duplicateDateTime = todoManager.updateTodoItemAt(original, 0, {
        dateTime: '2035-07-19 12:00',
        text: '改到午餐时间',
        priority: '高',
    });

    assert.equal(invalidDate.error, 'invalid_datetime');
    assert.equal(invalidDate.value, original);
    assert.equal(emptyText.error, 'empty_text');
    assert.equal(emptyText.value, original);
    assert.equal(duplicateDateTime.error, 'duplicate');
    assert.equal(duplicateDateTime.value, original);
});
