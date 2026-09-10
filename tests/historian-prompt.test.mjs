import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const promptLibrarySource = fs.readFileSync(new URL('../config/prompt-library.js', import.meta.url), 'utf8');
const promptSchemeIoSource = fs.readFileSync(new URL('../config/prompt-scheme-io.js', import.meta.url), 'utf8');

function createSandbox() {
    const sandbox = {
        Blob,
        Date,
        JSON,
        URL,
        structuredClone,
        window: {
            YuzukiMemory: {},
            setTimeout() {},
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(promptLibrarySource, sandbox, { filename: 'prompt-library.js' });
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

test('prompt scheme export strips historian while legacy imports preserve it for migration', () => {
    const sandbox = createSandbox();
    const io = sandbox.window.YuzukiMemory.PromptSchemeIO;
    const legacyScheme = {
        id: 'legacy-scheme',
        name: '旧方案',
        prompts: {
            historian: 'LEGACY_HISTORIAN',
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
