import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const promptLibrarySource = fs.readFileSync(new URL('../config/prompt-library.js', import.meta.url), 'utf8');
const promptSchemeIoSource = fs.readFileSync(new URL('../config/prompt-scheme-io.js', import.meta.url), 'utf8');
const storyDirectorSettingsSource = fs.readFileSync(new URL('../config/story-director-settings.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');

function getFunctionSource(source, name, nextName) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start + 1);
    assert.notEqual(start, -1, `${name} should exist`);
    assert.notEqual(end, -1, `${nextName} should follow ${name}`);
    return source.slice(start, end);
}

function createSandbox() {
    const globalSettings = new Map();
    const sandbox = {
        Blob,
        Date,
        JSON,
        URL,
        structuredClone,
        window: {
            YuzukiMemory: {
                GlobalSettings: {
                    get: (key, fallback) => globalSettings.has(key) ? structuredClone(globalSettings.get(key)) : fallback,
                    set: (key, value) => {
                        globalSettings.set(key, structuredClone(value));
                        return structuredClone(value);
                    },
                },
            },
            setTimeout() {},
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(promptLibrarySource, sandbox, { filename: 'prompt-library.js' });
    vm.runInContext(storyDirectorSettingsSource, sandbox, { filename: 'story-director-settings.js' });
    vm.runInContext(promptSchemeIoSource, sandbox, { filename: 'prompt-scheme-io.js' });
    return sandbox;
}

test('built-in historian remains available outside prompt schemes', () => {
    const sandbox = createSandbox();
    const library = sandbox.window.YuzukiMemory.PromptLibrary;
    const defaultScheme = library.getDefaultScheme();
    const [defaultHistorian] = library.getDefaultHistorianPrompts();

    assert.equal(Object.hasOwn(defaultScheme.prompts, 'historian'), false);
    assert.equal(defaultHistorian.id, library.getDefaultHistorianPromptId());
    assert.equal(defaultHistorian.builtin, true);
    assert.match(defaultHistorian.prompt, /data extraction, summarization, and structuring engine/);
});

test('built-in story director remains independent from prompt schemes', () => {
    const sandbox = createSandbox();
    const library = sandbox.window.YuzukiMemory.PromptLibrary;
    const defaultScheme = library.getDefaultScheme();
    const [director] = library.getDefaultStoryDirectorPrompts();

    assert.equal(Object.hasOwn(defaultScheme.prompts, 'storyDirector'), false);
    assert.equal(director.id, library.getDefaultStoryDirectorPromptId());
    assert.equal(director.builtin, true);
    assert.match(director.prompt, /<下轮导演卡>/);
    assert.match(director.prompt, /若最新输入为 User/);
    assert.match(director.prompt, /若最新输入为 Assistant/);
    assert.match(director.prompt, /严禁再次复述上一轮已发生的声明与事实/);
    assert.match(director.prompt, /3 条不同博弈方向的推演/);
    assert.doesNotMatch(director.prompt, /当前\{\{user\}\}可能做出的反应/);
    assert.match(director.prompt, /所属模块：\[Module 1 \/ 2 \/ 3 \/ 4\]/);
    assert.match(director.prompt, /签发三个不同的具体既成事件推进备选项/);
});

test('story director settings keep the selected custom prompt active', () => {
    const sandbox = createSandbox();
    const settings = sandbox.window.YuzukiMemory.StoryDirectorSettings;
    const custom = {
        id: 'custom-story-director',
        name: 'Custom Director',
        prompt: 'CUSTOM_DIRECTOR_PROMPT',
        builtin: false,
    };

    settings.savePrompts([custom]);
    settings.setActivePromptId(custom.id);

    assert.equal(settings.getActivePromptId(), custom.id);
    assert.equal(settings.getActivePrompt().prompt, custom.prompt);
});

test('changing or saving a story director prompt does not automatically run the agent', () => {
    const selectionHandler = getFunctionSource(
        memoryWindowSource,
        'applyStoryDirectorPromptSelection',
        'startNewStoryDirectorPrompt',
    );
    const saveHandler = getFunctionSource(
        memoryWindowSource,
        'saveActiveStoryDirectorPrompt',
        'deleteActiveStoryDirectorPrompt',
    );

    assert.doesNotMatch(selectionHandler, /scheduleDirector/);
    assert.doesNotMatch(saveHandler, /scheduleDirector/);
    assert.match(selectionHandler, /cancelActiveRun/);
    assert.match(saveHandler, /cancelActiveRun/);
});

test('prompt scheme export strips historian while legacy imports preserve it for migration', () => {
    const sandbox = createSandbox();
    const io = sandbox.window.YuzukiMemory.PromptSchemeIO;
    const legacyScheme = {
        id: 'legacy-scheme',
        name: '旧方案',
        prompts: {
            historian: 'LEGACY_HISTORIAN',
            storyDirector: 'SHOULD_NOT_EXPORT',
            traceRealtime: 'TRACE',
            summary: 'SUMMARY',
            table: 'LEGACY_TABLE_ALIAS',
            futurePrompt: 'FUTURE_PROMPT',
        },
        modes: { trace: 'realtime' },
    };

    const exported = io.createExport(legacyScheme, 'single');
    assert.equal(exported.version, 2);
    assert.equal(Object.hasOwn(exported.scheme.prompts, 'historian'), false);
    assert.equal(Object.hasOwn(exported.scheme.prompts, 'storyDirector'), false);
    assert.equal(exported.scheme.prompts.traceRealtime, 'TRACE');
    assert.equal(exported.scheme.prompts.table, 'LEGACY_TABLE_ALIAS');
    assert.equal(exported.scheme.prompts.futurePrompt, 'FUTURE_PROMPT');

    const imported = io.parseText(JSON.stringify({
        format: io.FORMAT,
        version: 1,
        kind: 'single',
        scheme: legacyScheme,
    }));
    assert.equal(imported.schemes[0].prompts.historian, 'LEGACY_HISTORIAN');
    assert.equal(imported.schemes[0].prompts.table, 'LEGACY_TABLE_ALIAS');
});
