// ============================================================================
// yuzuki-Memory story director prompt settings.
// Stores an independent global prompt collection and active selection.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPTS_STORAGE_KEY = 'yzm_memory_global_story_director_prompts';
    const ACTIVE_PROMPT_STORAGE_KEY = 'yzm_memory_global_story_director_prompt_active';
    const UNSET = '__yzm_story_director_prompt_active_unset__';

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
        if (YuzukiMemory.GlobalSettings?.get) return YuzukiMemory.GlobalSettings.get(key, fallback);
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return fallback;
            try {
                return JSON.parse(raw);
            } catch (_error) {
                return raw;
            }
        } catch (_error) {
            return fallback;
        }
    }

    function writeSetting(key, value) {
        if (YuzukiMemory.GlobalSettings?.set) return YuzukiMemory.GlobalSettings.set(key, value);
        localStorage.setItem(key, JSON.stringify(value));
        return value;
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
        const builtinIds = new Set((YuzukiMemory.PromptLibrary?.getDefaultStoryDirectorPrompts?.() || [])
            .map((prompt) => String(prompt?.id || '').trim())
            .filter(Boolean));
        const seen = new Set();
        const normalized = (Array.isArray(prompts) ? prompts : [])
            .map(normalizePrompt)
            .filter((prompt) => {
                if (!prompt?.id || !prompt.name || prompt.builtin || builtinIds.has(prompt.id) || seen.has(prompt.id)) return false;
                seen.add(prompt.id);
                return true;
            });
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
        createPromptId,
        normalizePrompt,
        getPrompts,
        savePrompts,
        getSelection,
        getActivePromptId,
        getActivePrompt,
        setActivePromptId,
    });
})();
