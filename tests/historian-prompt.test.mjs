import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const globalSettingsSource = fs.readFileSync(new URL('../config/global-settings.js', import.meta.url), 'utf8');
const promptLibrarySource = fs.readFileSync(new URL('../config/prompt-library.js', import.meta.url), 'utf8');
const promptSchemeIoSource = fs.readFileSync(new URL('../config/prompt-scheme-io.js', import.meta.url), 'utf8');
const storyDirectorSettingsSource = fs.readFileSync(new URL('../config/story-director-settings.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

function getFunctionSource(source, name, nextName) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start + 1);
    assert.notEqual(start, -1, `${name} should exist`);
    assert.notEqual(end, -1, `${nextName} should follow ${name}`);
    return source.slice(start, end);
}

function createLocalStorage(initial = {}) {
    const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    };
}

function createPersistentStoryDirectorSandbox({ extension = {}, local = {} } = {}) {
    const localStorage = createLocalStorage(local);
    const extensionSettings = { yuzukiMemory: structuredClone(extension) };
    let immediateSaveCalls = 0;
    let debouncedSaveCalls = 0;
    const sandbox = {
        Blob,
        Date,
        JSON,
        URL,
        console,
        localStorage,
        structuredClone,
        window: {
            YuzukiMemory: {
                settingsBridge: {
                    extensionSettings,
                    saveSettings: () => {
                        immediateSaveCalls += 1;
                    },
                    saveSettingsDebounced: () => {
                        debouncedSaveCalls += 1;
                    },
                },
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(globalSettingsSource, sandbox, { filename: 'global-settings.js' });
    vm.runInContext(promptLibrarySource, sandbox, { filename: 'prompt-library.js' });
    vm.runInContext(storyDirectorSettingsSource, sandbox, { filename: 'story-director-settings.js' });
    return {
        sandbox,
        extensionSettings,
        localStorage,
        getImmediateSaveCalls: () => immediateSaveCalls,
        getDebouncedSaveCalls: () => debouncedSaveCalls,
    };
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

test('built-in character status prompt remains available with its growth task prompt', () => {
    const sandbox = createSandbox();
    const library = sandbox.window.YuzukiMemory.PromptLibrary;
    const [characterStatusPrompt] = library.getDefaultCharacterStatusPrompts();
    const merged = library.mergeCharacterStatusPrompts([]);

    assert.equal(characterStatusPrompt.id, 'yuzuki_default_character_status_prompt_v1');
    assert.equal(characterStatusPrompt.builtin, true);
    assert.match(characterStatusPrompt.prompt, /只允许更新角色状态表“头部信息”和“状态总览”/);
    assert.match(characterStatusPrompt.prompt, /禁止更新基础属性和事务分组/);
    assert.match(characterStatusPrompt.growthPrompt, /角色属性成长任务设计助手/);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, characterStatusPrompt.id);
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
    assert.match(director.prompt, /最后一条发言为user方仅输出分支A/);
    assert.match(director.prompt, /最后一条发言为Assistant方,仅输出分支B/);
    assert.match(director.prompt, /根据\{\{user\}\}可能产生的反应,预演其他角色\/群体反应/);
    assert.match(director.prompt, /导演卡职责仅限于确立“宏观博弈走向\/策略态度”/);
    assert.match(director.prompt, /所有的预案只输出策略标签\(8~20字以内\)/);
    assert.match(director.prompt, /预案1\(正向\)/);
    assert.match(director.prompt, /预案2\(中立\)/);
    assert.match(director.prompt, /预案3\(对抗\)/);
    assert.match(director.prompt, /若\{\{user\}\}直接跨时间或剧情推进/);
    assert.match(director.prompt, /预案内容严禁预设\{\{user\}\}的言行或决定/);
    assert.doesNotMatch(director.prompt, /当前角色正向：顺从\/接纳\/主动/);
    assert.doesNotMatch(director.prompt, /当前\{\{user\}\}可能做出的反应/);
    assert.match(director.prompt, /所有模块权重相同/);
    assert.match(director.prompt, /近10轮中出现未出现或次数最少的模块/);
    assert.match(director.prompt, /连续4轮未出现时强制调用/);
    assert.match(director.prompt, /核对近10轮账本中的正文实际事件/);
    assert.match(director.prompt, /禁止轨道B复用相同或高度相似的地点、行为和剧情/);
    assert.match(director.prompt, /登场角色：角色A、角色B、角色C/);
    assert.match(director.prompt, /所属模块：Module 1/);
    assert.match(director.prompt, /备选1\(直球升温\)/);
    assert.match(director.prompt, /情感\/追求\/误会\/私心/);
    assert.match(director.prompt, /敌对\/陷害\/野心\/博弈/);
    assert.match(director.prompt, /严禁因为当前主线[^\n]*压制情感、社交、日常或第三方支线/);
    assert.match(director.prompt, /用户独处：否/);
    assert.match(director.prompt, /处于真性独处[^\n]*跳过[^\n]*轨道B[^\n]*2个或2个以上/);
    assert.match(director.prompt, /处于真性独处[^\n]*不需要输出分支A\/B/);
    assert.match(director.prompt, /外力单向穿透介入/);
    assert.doesNotMatch(director.prompt, /跳过执行轨道B/);
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

test('story director settings migrate legacy browser data into extension settings once', async () => {
    const custom = {
        id: 'legacy-browser-director',
        name: 'Legacy Browser Director',
        prompt: 'LEGACY_BROWSER_PROMPT',
        builtin: false,
    };
    const promptsKey = 'yzm_memory_global_story_director_prompts';
    const activeKey = 'yzm_memory_global_story_director_prompt_active';
    const migrationKey = 'yzm_memory_global_story_director_extension_migrated_v1';
    const {
        sandbox,
        extensionSettings,
        localStorage,
        getImmediateSaveCalls,
        getDebouncedSaveCalls,
    } = createPersistentStoryDirectorSandbox({
        extension: {
            [promptsKey]: [],
            [activeKey]: '',
        },
        local: {
            [promptsKey]: [custom],
            [activeKey]: custom.id,
        },
    });

    const store = extensionSettings.yuzukiMemory;
    const settings = sandbox.window.YuzukiMemory.StoryDirectorSettings;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store[promptsKey].length, 1);
    assert.equal(store[promptsKey][0].id, custom.id);
    assert.equal(store[activeKey], custom.id);
    assert.equal(store[migrationKey], true);
    assert.equal(settings.getActivePromptId(), custom.id);
    assert.equal(localStorage.getItem(promptsKey), null);
    assert.equal(localStorage.getItem(activeKey), null);
    assert.equal(getImmediateSaveCalls(), 1);
    assert.equal(getDebouncedSaveCalls(), 0);
});

test('story director settings do not restore stale browser prompts after migration', () => {
    const stale = {
        id: 'deleted-browser-director',
        name: 'Deleted Browser Director',
        prompt: 'SHOULD_STAY_DELETED',
        builtin: false,
    };
    const promptsKey = 'yzm_memory_global_story_director_prompts';
    const activeKey = 'yzm_memory_global_story_director_prompt_active';
    const migrationKey = 'yzm_memory_global_story_director_extension_migrated_v1';
    const { sandbox, localStorage } = createPersistentStoryDirectorSandbox({
        extension: {
            [promptsKey]: [],
            [activeKey]: '',
            [migrationKey]: true,
        },
        local: {
            [promptsKey]: [stale],
            [activeKey]: stale.id,
        },
    });

    const settings = sandbox.window.YuzukiMemory.StoryDirectorSettings;
    assert.equal(settings.getPrompts().some((prompt) => prompt.id === stale.id), false);
    assert.equal(settings.getActivePromptId(), '');
    assert.equal(localStorage.getItem(promptsKey), null);
    assert.equal(localStorage.getItem(activeKey), null);
});

test('story director migration keeps extension content when browser cache has the same id', async () => {
    const promptsKey = 'yzm_memory_global_story_director_prompts';
    const activeKey = 'yzm_memory_global_story_director_prompt_active';
    const customId = 'shared-story-director-id';
    const { sandbox, extensionSettings, localStorage } = createPersistentStoryDirectorSandbox({
        extension: {
            [promptsKey]: [{
                id: customId,
                name: 'Extension Director',
                prompt: 'EXTENSION_IS_AUTHORITATIVE',
                builtin: false,
            }],
            [activeKey]: '',
        },
        local: {
            [promptsKey]: [{
                id: customId,
                name: 'Stale Browser Director',
                prompt: 'STALE_BROWSER_VALUE',
                builtin: false,
            }],
            [activeKey]: customId,
        },
    });

    await sandbox.window.YuzukiMemory.StoryDirectorSettings.whenReady();
    const store = extensionSettings.yuzukiMemory;
    assert.equal(store[promptsKey][0].name, 'Extension Director');
    assert.equal(store[promptsKey][0].prompt, 'EXTENSION_IS_AUTHORITATIVE');
    assert.equal(store[activeKey], '');
    assert.equal(localStorage.getItem(promptsKey), null);
    assert.equal(localStorage.getItem(activeKey), null);
});

test('new story director saves stay out of browser storage', async () => {
    const promptsKey = 'yzm_memory_global_story_director_prompts';
    const activeKey = 'yzm_memory_global_story_director_prompt_active';
    const migrationKey = 'yzm_memory_global_story_director_extension_migrated_v1';
    const { sandbox, extensionSettings, localStorage } = createPersistentStoryDirectorSandbox({
        extension: { [migrationKey]: true },
    });
    const settings = sandbox.window.YuzukiMemory.StoryDirectorSettings;
    const custom = {
        id: 'extension-only-director',
        name: 'Extension Only Director',
        prompt: 'EXTENSION_ONLY_PROMPT',
        builtin: false,
    };

    settings.savePrompts([custom]);
    settings.setActivePromptId(custom.id);
    await settings.flushPersistence();

    const store = extensionSettings.yuzukiMemory;
    assert.equal(store[promptsKey][0].id, custom.id);
    assert.equal(store[activeKey], custom.id);
    assert.equal(localStorage.getItem(promptsKey), null);
    assert.equal(localStorage.getItem(activeKey), null);
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

test('story director switch is stored in the current chat state instead of global plugin settings', () => {
    const updateHandler = getFunctionSource(
        memoryWindowSource,
        'updateStoryDirectorEnabled',
        'saveFillModeSetting',
    );
    const configPanel = getFunctionSource(
        memoryWindowSource,
        'createPluginConfigPanel',
        'createFloatingIconStylePicker',
    );

    assert.ok(updateHandler.includes('state.storyDirector = {'));
    assert.ok(updateHandler.includes('saveState({ force: true })'));
    assert.doesNotMatch(updateHandler, /GlobalSettings|updatePluginSetting/);
    assert.ok(configPanel.includes('getStoryDirectorEnabled()'));
    assert.match(configPanel, /storyDirectorEnabled/);
    assert.ok(!configPanel.includes('settings.enableStoryDirector'));
});

test('director card can replan through the shared runner and refresh in place', () => {
    const openHandler = getFunctionSource(
        memoryWindowSource,
        'openStoryDirectorCard',
        'bindShellOpenInteractionGuard',
    );

    assert.match(openHandler, /yzm-story-director-card-replan/);
    assert.match(openHandler, /runManualStoryDirector\(replanButton\)/);
    assert.match(openHandler, /getCurrentDirectorCard/);
    assert.match(openHandler, /body\.classList\.toggle\('yzm-story-director-card-empty'/);
    assert.match(openHandler, /body\.scrollTop = 0/);
});

test('manual story director action remains clickable and stops the active run on a second click', () => {
    const buttonStateHandler = getFunctionSource(
        memoryWindowSource,
        'updateStoryDirectorActionButton',
        'updateStoryDirectorActionButtons',
    );
    const manualRunner = getFunctionSource(
        memoryWindowSource,
        'runManualStoryDirector',
        'openStoryDirectorErrorDialog',
    );

    assert.match(buttonStateHandler, /yzm-story-director-stoppable/);
    assert.match(buttonStateHandler, /fa-solid fa-stop/);
    assert.match(buttonStateHandler, /停止当前剧情规划/);
    assert.match(manualRunner, /runtime\.isRunning\?\.\(\) === true/);
    assert.match(manualRunner, /runtime\.cancelActiveRun\?\.\('manual story director stop'\)/);
    assert.match(manualRunner, /if \(result\?\.aborted\) return result/);
    assert.doesNotMatch(manualRunner, /button\.disabled = true/);
    assert.match(memoryCssSource, /\.yzm-top-story-director\.yzm-story-director-stoppable[\s\S]*?cursor: pointer/);
    assert.match(memoryCssSource, /\.yzm-story-director-card-replan\.yzm-story-director-stoppable[\s\S]*?cursor: pointer/);
});

test('retry actions close failure dialogs before restarting background work', () => {
    const directorDialog = getFunctionSource(
        memoryWindowSource,
        'openStoryDirectorErrorDialog',
        'createSidebarTableItem',
    );
    const taskResultDialog = getFunctionSource(
        memoryWindowSource,
        'openTaskResultConfirmDialog',
        'openCharacterGrowthTaskDialog',
    );
    const mountStart = memoryWindowSource.indexOf('function mount(');
    const mountEnd = memoryWindowSource.indexOf('YuzukiMemory.MemoryWindow', mountStart + 1);
    assert.notEqual(mountStart, -1, 'mount should exist');
    assert.notEqual(mountEnd, -1, 'MemoryWindow export should follow mount');
    const mountHandler = memoryWindowSource.slice(mountStart, mountEnd);

    assert.match(directorDialog, /retry\.onclick = \(\) => \{\s*closeDialog\(\);\s*void runManualStoryDirector\(retry\);/);
    assert.match(taskResultDialog, /options\.retryLabel/);
    assert.match(taskResultDialog, /closeWith\(\{ action: 'retry', retry: true \}\)/);
    assert.match(mountHandler, /retryLabel: '重试'/);
    assert.match(mountHandler, /retryPendingAutoTask\?\.\(payload\.sessionId\)/);
});

test('story director progress indicator follows the live runtime lifecycle', () => {
    const ensureIndicator = getFunctionSource(
        memoryWindowSource,
        'ensureStoryDirectorProgressIndicator',
        'updateStoryDirectorProgressIndicator',
    );
    const bindIndicator = getFunctionSource(
        memoryWindowSource,
        'bindStoryDirectorProgressListener',
        'scheduleSessionWorkspaceRefresh',
    );

    assert.match(ensureIndicator, /yzm-story-director-progress/);
    assert.match(ensureIndicator, /正在剧情规划/);
    assert.match(ensureIndicator, /visualViewport/);
    assert.match(ensureIndicator, /offsetTop/);
    assert.match(ensureIndicator, /viewportHeight \/ 2/);
    assert.match(ensureIndicator, /yzm-story-director-progress-center-y/);
    assert.match(bindIndicator, /yzmStoryDirectorProgressHandler/);
    assert.match(bindIndicator, /yzmStoryDirectorProgressViewportController/);
    assert.match(bindIndicator, /visualViewport\?\.addEventListener\?\.\('resize'/);
    assert.match(bindIndicator, /visualViewport\?\.addEventListener\?\.\('scroll'/);
    assert.match(bindIndicator, /event\?\.detail\?\.running === true/);
    assert.match(bindIndicator, /updateStoryDirectorProgressIndicator\(\)/);
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
