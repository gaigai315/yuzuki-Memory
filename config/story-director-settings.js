// ============================================================================
// yuzuki-Memory story director prompt settings.
// Stores an independent global prompt collection and active selection.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPTS_STORAGE_KEY = 'yzm_memory_global_story_director_prompts';
    const ACTIVE_PROMPT_STORAGE_KEY = 'yzm_memory_global_story_director_prompt_active';
    const STORAGE_MIGRATION_KEY = 'yzm_memory_global_story_director_extension_migrated_v1';
    const UNSET = '__yzm_story_director_prompt_active_unset__';
    let migrationPromise = null;

    function createPromptId() {
        return `story_director_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizePrompt(rawPrompt, index = 0) {
        if (!rawPrompt || typeof rawPrompt !== 'object') return null;
        return {
            id: String(rawPrompt.id || createPromptId()).trim(),
            name: String(rawPrompt.name || `剧情导演提示词 ${String(index + 1).padStart(2, '0')}`).trim(),
            prompt: String(rawPrompt.prompt ?? rawPrompt.content ?? rawPrompt.text ?? ''),
            builtin: rawPrompt.builtin === true,
        };
    }

    function readSetting(key, fallback) {
        if (!YuzukiMemory.GlobalSettings?.get) return fallback;
        return YuzukiMemory.GlobalSettings.get(key, fallback, { localFallback: false });
    }

    function writeSetting(key, value) {
        if (!YuzukiMemory.GlobalSettings?.set) {
            throw new Error('剧情导演全局设置存储尚未加载。');
        }
        return YuzukiMemory.GlobalSettings.set(key, value, {
            immediate: true,
            localFallback: false,
            requirePersistent: true,
        });
    }

    function valuesMatch(left, right) {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return left === right;
        }
    }

    function getBuiltinPromptIds() {
        return new Set((YuzukiMemory.PromptLibrary?.getDefaultStoryDirectorPrompts?.() || [])
            .map((prompt) => String(prompt?.id || '').trim())
            .filter(Boolean));
    }

    function normalizeCustomPrompts(prompts) {
        const builtinIds = getBuiltinPromptIds();
        const seen = new Set();
        return (Array.isArray(prompts) ? prompts : [])
            .map(normalizePrompt)
            .filter((prompt) => {
                if (!prompt?.id || !prompt.name || prompt.builtin || builtinIds.has(prompt.id) || seen.has(prompt.id)) return false;
                seen.add(prompt.id);
                return true;
            });
    }

    async function migrateLegacyBrowserSettings() {
        const settings = YuzukiMemory.GlobalSettings;
        if (!settings?.getExtension || !settings?.getLocalFallback || !settings?.set) return false;

        if (settings.getExtension(STORAGE_MIGRATION_KEY, false) === true) {
            settings.removeLocalFallback?.(PROMPTS_STORAGE_KEY);
            settings.removeLocalFallback?.(ACTIVE_PROMPT_STORAGE_KEY);
            return false;
        }

        try {
            const extensionRaw = settings.getExtension(PROMPTS_STORAGE_KEY, undefined);
            const localRaw = settings.getLocalFallback(PROMPTS_STORAGE_KEY, undefined);
            const extensionPrompts = normalizeCustomPrompts(extensionRaw);
            const localPrompts = normalizeCustomPrompts(localRaw);
            const mergedById = new Map(extensionPrompts.map((prompt) => [prompt.id, prompt]));
            const recoveredLocalIds = new Set();
            localPrompts.forEach((prompt) => {
                if (mergedById.has(prompt.id)) return;
                mergedById.set(prompt.id, prompt);
                recoveredLocalIds.add(prompt.id);
            });
            const mergedPrompts = [...mergedById.values()];

            if (localRaw !== undefined && (extensionRaw === undefined || !valuesMatch(extensionPrompts, mergedPrompts))) {
                writeSetting(PROMPTS_STORAGE_KEY, mergedPrompts);
            }

            const extensionActive = settings.getExtension(ACTIVE_PROMPT_STORAGE_KEY, UNSET);
            const localActive = settings.getLocalFallback(ACTIVE_PROMPT_STORAGE_KEY, UNSET);
            const validIds = new Set([
                ...getBuiltinPromptIds(),
                ...mergedPrompts.map((prompt) => prompt.id),
            ]);
            const normalizedLocalActive = localActive === UNSET ? UNSET : String(localActive ?? '').trim();
            const nextActive = normalizedLocalActive !== UNSET
                && validIds.has(normalizedLocalActive)
                && (extensionActive === UNSET || recoveredLocalIds.has(normalizedLocalActive))
                ? normalizedLocalActive
                : extensionActive;
            if (nextActive !== UNSET && !valuesMatch(extensionActive, nextActive)) {
                writeSetting(ACTIVE_PROMPT_STORAGE_KEY, nextActive);
            }

            writeSetting(STORAGE_MIGRATION_KEY, true);
            await settings.flushPersistence?.();
            settings.removeLocalFallback?.(PROMPTS_STORAGE_KEY);
            settings.removeLocalFallback?.(ACTIVE_PROMPT_STORAGE_KEY);
            return true;
        } catch (error) {
            console.error('[yuzuki-Memory] 剧情导演提示词浏览器缓存迁移失败。', error);
            return false;
        }
    }

    function getPrompts() {
        const stored = readSetting(PROMPTS_STORAGE_KEY, []);
        const source = YuzukiMemory.PromptLibrary?.mergeStoryDirectorPrompts?.(stored)
            || (Array.isArray(stored) ? stored : []);
        const seen = new Set();
        return source.map(normalizePrompt).filter((prompt) => {
            if (!prompt?.id || !prompt.name || seen.has(prompt.id)) return false;
            seen.add(prompt.id);
            return true;
        });
    }

    function savePrompts(prompts) {
        const normalized = normalizeCustomPrompts(prompts);
        writeSetting(PROMPTS_STORAGE_KEY, normalized);
        return normalized;
    }

    function getSelection() {
        const value = readSetting(ACTIVE_PROMPT_STORAGE_KEY, UNSET);
        if (value === UNSET) return { initialized: false, id: '' };
        return { initialized: true, id: String(value ?? '').trim() };
    }

    function getActivePromptId() {
        const prompts = getPrompts();
        const selection = getSelection();
        const selectedId = selection.initialized
            ? selection.id
            : String(YuzukiMemory.PromptLibrary?.getDefaultStoryDirectorPromptId?.() || prompts[0]?.id || '').trim();
        return prompts.some((prompt) => prompt.id === selectedId) ? selectedId : '';
    }

    function getActivePrompt() {
        const activeId = getActivePromptId();
        return activeId ? getPrompts().find((prompt) => prompt.id === activeId) || null : null;
    }

    function setActivePromptId(promptId) {
        const normalized = String(promptId || '').trim();
        const validId = getPrompts().some((prompt) => prompt.id === normalized) ? normalized : '';
        writeSetting(ACTIVE_PROMPT_STORAGE_KEY, validId);
        return validId;
    }

    YuzukiMemory.StoryDirectorSettings = Object.assign(YuzukiMemory.StoryDirectorSettings || {}, {
        promptStorageKey: PROMPTS_STORAGE_KEY,
        activePromptStorageKey: ACTIVE_PROMPT_STORAGE_KEY,
        storageMigrationKey: STORAGE_MIGRATION_KEY,
        createPromptId,
        normalizePrompt,
        getPrompts,
        savePrompts,
        migrateLegacyBrowserSettings,
        whenReady: () => migrationPromise || Promise.resolve(false),
        flushPersistence: () => YuzukiMemory.GlobalSettings?.flushPersistence?.() || Promise.resolve(),
        getSelection,
        getActivePromptId,
        getActivePrompt,
        setActivePromptId,
    });

    migrationPromise = migrateLegacyBrowserSettings();
})();
