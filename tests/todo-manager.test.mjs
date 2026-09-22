import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {
    console,
    CustomEvent: class CustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    },
    SillyTavern: { getContext: () => null },
    window: {
        YuzukiMemory: {},
        setTimeout: () => 1,
        clearTimeout() {},
        addEventListener() {},
        dispatchEvent() {},
    },
};
vm.createContext(sandbox);
const plotSummarySource = fs.readFileSync(new URL('../config/plot-summary.js', import.meta.url), 'utf8');
vm.runInContext(plotSummarySource, sandbox, { filename: 'plot-summary.js' });
const source = fs.readFileSync(new URL('../config/todo-manager.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'todo-manager.js' });

const todoManager = sandbox.window.YuzukiMemory.TodoManager;

test('ancient globalTime status bars expose regnal date and clock time', () => {
    const storyTime = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大明永乐十二年九月初八日·🍂·辰时(07:30)·☀️',
        '</globalTime>',
    ].join('\n'));

    assert.equal(storyTime.source, 'chat-tag');
    assert.equal(storyTime.date, '大明永乐十二年九月初八日');
    assert.equal(storyTime.time, '07:30');
    assert.equal(storyTime.calendar, 'ancient');
    assert.equal(storyTime.era, '大明永乐');
    assert.deepEqual(
        { ...storyTime.dateTimeParts },
        { year: 12, month: 9, day: 8, hour: 7, minute: 30 },
    );
    assert.equal(Number.isFinite(storyTime.ordinalMinutes), true);
    assert.equal(
        todoManager.fillMissingTodoDates('〔1〕07:40·上朝（高）', storyTime),
        '〔1〕大明永乐十二年九月初八日 07:40·上朝（高）',
    );
    assert.equal(
        todoManager.pruneTodoText('〔1〕大明永乐十二年九月初八日 07:20·上朝（高）', storyTime).changed,
        true,
    );
});

test('ancient todos parse and expire after the 10-minute delay', () => {
    const text = '〔1〕大楚宣武十二年十二月十八日 18:00·调定国军布防西市北仓与各处要害（高）';
    const item = todoManager.parseTodoItems(text)[0];
    const beforeExpiry = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大楚宣武十二年十二月十八日·❄️·酉时(18:09)·☀️',
        '</globalTime>',
    ].join('\n'));
    const atExpiry = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大楚宣武十二年十二月十八日·❄️·酉时(18:10)·☀️',
        '</globalTime>',
    ].join('\n'));

    assert.equal(item.calendar, 'ancient');
    assert.equal(item.era, '大楚宣武');
    assert.equal(item.dateTime, '大楚宣武十二年十二月十八日 18:00');
    assert.equal(item.text, '调定国军布防西市北仓与各处要害');
    assert.deepEqual(
        { ...item.dateTimeParts },
        { year: 12, month: 12, day: 18, hour: 18, minute: 0 },
    );
    assert.equal(todoManager.pruneTodoText(text, beforeExpiry).changed, false);
    assert.equal(todoManager.pruneTodoText(text, atExpiry).changed, true);
});

test('ancient todo expiry handles day rollover and rejects a different era', () => {
    const text = '〔1〕大楚宣武十二年十二月十八日 23:55·巡视西市北仓（高）';
    const nextDay = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大楚宣武十二年十二月十九日·❄️·子时(00:05)·☀️',
        '</globalTime>',
    ].join('\n'));
    const differentEra = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大楚承平十二年十二月十九日·❄️·子时(00:05)·☀️',
        '</globalTime>',
    ].join('\n'));

    assert.equal(todoManager.pruneTodoText(text, nextDay).changed, true);
    assert.equal(todoManager.pruneTodoText(text, differentEra).changed, false);
});

test('ancient cleanup supports legacy numeric regnal dates and deletion identities', () => {
    const storyTime = todoManager.parseStoryTimeText([
        '<globalTime>',
        'T_story：大楚宣武十二年十二月十八日·❄️·酉时(18:10)·☀️',
        '</globalTime>',
    ].join('\n'));
    const legacyNumeric = '〔1〕12年12月18日 18:00·巡视西市北仓（高）';
    const ancientText = '〔1〕大楚宣武十二年十二月十八日 18:00·巡视西市北仓（高）';
    const legacyDeletedIdentity = 'content:|大楚宣武十二年十二月十八日18:00·巡视西市北仓';

    assert.equal(todoManager.pruneTodoText(legacyNumeric, storyTime).changed, true);
    assert.equal(todoManager.filterDeletedTodoText(ancientText, [legacyDeletedIdentity]), '');
});

test('timed todos are removed after the 10-minute expiry delay', () => {
    const text = '〔1〕2035-07-19 10:00·审查财务报表（高）';
    const scheduled = todoManager.parseTodoItems(text)[0];

    assert.equal(todoManager.EXPIRY_DELAY_MINUTES, 10);

    const beforeExpiry = todoManager.pruneTodoText(text, scheduled.ordinalMinutes + 9);
    assert.equal(beforeExpiry.changed, false);
    assert.equal(beforeExpiry.value, text);

    const atExpiry = todoManager.pruneTodoText(text, scheduled.ordinalMinutes + 10);
    assert.equal(atExpiry.changed, true);
    assert.equal(atExpiry.removed.length, 1);
    assert.equal(atExpiry.value, '');
});

test('timed appointments expire after 10 minutes while long-term entries remain', () => {
    const text = [
        '2035-07-19 10:00·在钟楼会合',
        '永远保护对方',
        '旧格式约定：下次见面再商量',
    ].join(';');
    const scheduled = todoManager.parseAppointmentItems(text)[0];

    const beforeExpiry = todoManager.pruneAppointmentText(text, scheduled.ordinalMinutes + 9);
    assert.equal(beforeExpiry.changed, false);
    assert.equal(beforeExpiry.value, text);

    const atExpiry = todoManager.pruneAppointmentText(text, scheduled.ordinalMinutes + 10);
    assert.equal(atExpiry.changed, true);
    assert.equal(atExpiry.removed.length, 1);
    assert.equal(atExpiry.value, '永远保护对方;旧格式约定：下次见面再商量');
});

test('appointment expiry compares across day, month, and year boundaries', () => {
    const cases = [
        ['2035-07-19 23:55·跨日会合', '2035-07-20 00:05'],
        ['2035-07-31 23:55·跨月会合', '2035-08-01 00:05'],
        ['2035-12-31 23:55·跨年会合', '2036-01-01 00:05'],
    ];

    cases.forEach(([appointment, current]) => {
        const currentItem = todoManager.parseAppointmentItems(`${current}·当前时间锚点`)[0];
        const result = todoManager.pruneAppointmentText(appointment, currentItem.ordinalMinutes);
        assert.equal(result.changed, true, appointment);
        assert.equal(result.value, '', appointment);
    });
});

test('appointment pruning removes only expired timed entries', () => {
    const text = [
        '2035-12-31 23:55·已过期约定',
        '2036-01-01 00:00·尚未到十分钟',
        '2036-01-01 08:00·未来约定',
        '长期共同遵守秘密原则',
    ].join(';');
    const current = todoManager.parseAppointmentItems('2036-01-01 00:05·当前时间锚点')[0];
    const result = todoManager.pruneAppointmentText(text, current.ordinalMinutes);

    assert.equal(result.changed, true);
    assert.deepEqual(
        Array.from(todoManager.parseAppointmentItems(result.value), (item) => item.text),
        ['尚未到十分钟', '未来约定', '长期共同遵守秘密原则'],
    );
});

test('scheduled maintenance cleans todos and appointments in one state save', () => {
    const state = {
        records: {
            character_profile: [{
                id: 'role-1',
                values: {
                    角色名: '测试角色',
                    待办事项: '〔1〕2035-12-31 23:55·过期待办（高）',
                    约定: '2035-12-31 23:55·过期约定;长期约定',
                },
            }],
        },
    };
    let savedState = null;
    sandbox.window.YuzukiMemory.Storage = {
        isSessionSwitching: () => false,
        getCurrentSessionId: () => 'test-session',
        loadState: () => state,
        saveState: (nextState) => {
            savedState = nextState;
            return true;
        },
    };
    sandbox.window.YuzukiMemory.MemoryTagParser = { createDefaultState: () => ({ records: {} }) };
    sandbox.window.YuzukiMemory.BranchSnapshot = { captureCurrentStateSnapshot() {} };
    const storyTime = todoManager.parseStoryTimeText('<globalTime>2036-01-01 00:05</globalTime>');

    const result = todoManager.cleanupExpiredTodos({ storyTime });

    assert.equal(result.changed, true);
    assert.equal(result.todoRemovedCount, 1);
    assert.equal(result.appointmentRemovedCount, 1);
    assert.equal(result.removedCount, 2);
    assert.equal(savedState.records.character_profile[0].values.待办事项, '');
    assert.equal(savedState.records.character_profile[0].values.约定, '长期约定');
});

test('multiple user-deleted todos stay excluded from later merges', () => {
    const record = {
        values: {
            待办事项: [
                '〔1〕2035-07-19 10:00·审查财务报表（高）',
                '〔2〕2035-07-19 11:00·参加业务会议（中）',
            ].join(';'),
        },
    };

    for (let count = 0; count < 2; count += 1) {
        const deleted = todoManager.deleteTodoItemAt(record.values.待办事项, 0);
        assert.equal(deleted.changed, true);
        todoManager.markTodoItemsDeleted(record, [deleted.removed]);
        record.values.待办事项 = deleted.value;
    }

    const merged = todoManager.mergeTodoTexts(record.values.待办事项, [
        '〔1〕2035-07-19 10:00·再次输出旧财务事项（低）',
        '〔2〕2035-07-19 11:00·再次输出旧会议事项（高）',
        '〔3〕2035-07-19 12:00·新增午餐安排（中）',
    ].join(';'), {
        deletedIdentities: todoManager.getDeletedTodoIdentities(record),
    });

    assert.deepEqual(
        Array.from(todoManager.parseTodoItems(merged), (item) => item.text),
        ['新增午餐安排'],
    );
    assert.equal(todoManager.getDeletedTodoIdentities(record).length, 2);
});

test('todo ledger reconciliation preserves a user-edited item after its source floor changes', () => {
    const expected = '〔1〕2035-07-19 10:00·调查遗迹（高）';
    const current = '〔1〕2035-07-19 10:00·调查遗迹并带回样本（低）';

    const reconciled = todoManager.reconcileTodoTexts(current, expected, '');

    assert.deepEqual(
        Array.from(todoManager.parseTodoItems(reconciled), (item) => item.rawContent),
        ['2035-07-19 10:00·调查遗迹并带回样本（低）'],
    );
});

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
