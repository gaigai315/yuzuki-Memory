import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {
    window: {
        YuzukiMemory: {},
    },
};
vm.createContext(sandbox);
const source = fs.readFileSync(new URL('../config/task-runner.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'task-runner.js' });

const filterContentByTags = sandbox.window.YuzukiMemory.TaskRunner.filterContentByTags;

test('blacklist removes paired and closing-only thinking blocks', () => {
    const preset = { blacklist: ['thinking'], whitelist: [] };

    assert.equal(
        filterContentByTags('<thinking>内部推理</thinking>\n剧情正文', preset),
        '剧情正文',
    );
    assert.equal(
        filterContentByTags('未闭合的内部推理\n</thinking>\n剧情正文', preset),
        '剧情正文',
    );
});

test('blacklist removes opening-only hidden suffixes without changing plain text', () => {
    const preset = { blacklist: ['think'], whitelist: [] };

    assert.equal(filterContentByTags('剧情正文\n<think>未闭合的内部推理', preset), '剧情正文');
    assert.equal(filterContentByTags('没有标签的剧情正文', preset), '没有标签的剧情正文');
});

test('closing-only bracket tags remove the hidden prefix', () => {
    const preset = { blacklist: ['[analysis]'], whitelist: [] };

    assert.equal(
        filterContentByTags('内部分析\n[/analysis]\n剧情正文', preset),
        '剧情正文',
    );
});

test('whitelist extracts content from either unpaired boundary', () => {
    const preset = { blacklist: [], whitelist: ['content'] };

    assert.equal(filterContentByTags('<content>剧情正文', preset), '剧情正文');
    assert.equal(filterContentByTags('剧情正文</content>\n后台文本', preset), '剧情正文');
});

test('closing-only blacklist keeps an earlier whitelisted block available for extraction', () => {
    const preset = { blacklist: ['thinking'], whitelist: ['content'] };

    assert.equal(
        filterContentByTags('<content>剧情正文</content>\n残余推理</thinking>\n后台文本', preset),
        '剧情正文',
    );
});
