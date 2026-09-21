// ============================================================================
// yuzuki-Memory global settings.
// Stores global plugin config in SillyTavern extension_settings. Selected
// settings use localStorage only for a one-time migration from older versions.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const NAMESPACE = 'yuzukiMemory';
    const EXTENSION_ONLY_KEYS = new Set([
        'yzm_memory_global_prompt_schemes',
        'yzm_memory_global_prompt_scheme_active',
        'yzm_memory_global_prompt_scheme_character_bindings',
        'yzm_memory_global_timed_prompt_injection',
        'yzm_memory_global_story_director_prompts',
        'yzm_memory_global_story_director_prompt_active',
        'yzm_memory_global_story_director_extension_migrated_v1',
    ]);
    let immediateSavePending = false;
    let immediateSaveQueue = Promise.resolve();

    function getContext() {
        return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
            ? SillyTavern.getContext()
            : null;
    }

    function getExtensionSettings(create = false) {
        const bridgeSettings = YuzukiMemory.settingsBridge?.extensionSettings;
        if (bridgeSettings && typeof bridgeSettings === 'object') {
            if (create && !bridgeSettings[NAMESPACE]) bridgeSettings[NAMESPACE] = {};
            return bridgeSettings[NAMESPACE] || null;
        }

        const context = getContext();
        if (context?.extensionSettings && typeof context.extensionSettings === 'object') {
            if (create && !context.extensionSettings[NAMESPACE]) context.extensionSettings[NAMESPACE] = {};
            if (context.extensionSettings[NAMESPACE]) return context.extensionSettings[NAMESPACE];
        }

        const windowSettings = window.extension_settings;
        if (!windowSettings || typeof windowSettings !== 'object') return null;
        if (create && !windowSettings[NAMESPACE]) windowSettings[NAMESPACE] = {};
        return windowSettings[NAMESPACE] || null;
    }

    function callSave(save, label) {
        try {
            const result = save();
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    console.error(`[yuzuki-Memory] ${label} failed.`, error);
                });
            }
            return true;
        } catch (error) {
            console.error(`[yuzuki-Memory] ${label} failed.`, error);
            return false;
        }
    }

    function scheduleImmediateSave(save, label) {
        if (immediateSavePending) return true;
        immediateSavePending = true;
        Promise.resolve().then(() => {
            immediateSavePending = false;
            const operation = immediateSaveQueue
                .catch(() => undefined)
                .then(() => save());
            immediateSaveQueue = operation;
            operation.catch((error) => {
                console.error(`[yuzuki-Memory] ${label} failed.`, error);
            });
        });
        return true;
    }

    function flushPersistence() {
        return Promise.resolve().then(() => immediateSaveQueue);
    }

    function persist(options = {}) {
        if (options.immediate === true) {
            const bridgeSave = YuzukiMemory.settingsBridge?.saveSettings;
            if (typeof bridgeSave === 'function') {
                return scheduleImmediateSave(bridgeSave, 'Immediate SillyTavern settings save');
            }
            const context = getContext();
            if (typeof context?.saveSettings === 'function') {
                return scheduleImmediateSave(() => context.saveSettings(), 'Immediate SillyTavern context settings save');
            }
            if (typeof window.saveSettings === 'function') {
                return scheduleImmediateSave(() => window.saveSettings(), 'Immediate SillyTavern window settings save');
            }
        }

        const bridgeSave = YuzukiMemory.settingsBridge?.saveSettingsDebounced;
        if (typeof bridgeSave === 'function') {
            return callSave(bridgeSave, 'Debounced SillyTavern settings save');
        }
        const context = getContext();
        if (typeof context?.saveSettingsDebounced === 'function') {
            return callSave(() => context.saveSettingsDebounced(), 'Debounced SillyTavern context settings save');
        }
        if (typeof window.saveSettingsDebounced === 'function') {
            return callSave(() => window.saveSettingsDebounced(), 'Debounced SillyTavern window settings save');
        }
        console.error('[yuzuki-Memory] SillyTavern settings save function is unavailable.');
        return false;
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        try {
            return structuredClone(value);
        } catch (_error) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function parseLocalStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined || raw === '') return fallback;
            try {
                return JSON.parse(raw);
            } catch (_jsonError) {
                return raw;
            }
        } catch (_error) {
            return fallback;
        }
    }

    function removeLocalStorage(key) {
        try {
            localStorage.removeItem(key);
        } catch (_error) {
            // Ignore legacy cache cleanup failures.
        }
    }

    function valuesMatch(left, right) {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return left === right;
        }
    }

    function getExtension(key, fallback) {
        const resolvedFallback = arguments.length >= 2 ? fallback : null;
        const store = getExtensionSettings(false);
        if (!store || !Object.prototype.hasOwnProperty.call(store, key)) return clone(resolvedFallback);
        return clone(store[key]);
    }

    function getLocalFallback(key, fallback) {
        const resolvedFallback = arguments.length >= 2 ? fallback : null;
        return clone(parseLocalStorage(key, resolvedFallback));
    }

    function removeLocalFallback(key) {
        removeLocalStorage(key);
    }

    function get(key, fallback = null, options = {}) {
        const extensionOnly = EXTENSION_ONLY_KEYS.has(key);
        const localValue = parseLocalStorage(key, undefined);
        const store = getExtensionSettings(false);
        const hasStoredValue = !!store && Object.prototype.hasOwnProperty.call(store, key);

        if (hasStoredValue) {
            const storedValue = clone(store[key]);
            if (extensionOnly) {
                removeLocalStorage(key);
            } else if (options.localFallback !== false && !valuesMatch(localValue, storedValue)) {
                try {
                    localStorage.setItem(key, JSON.stringify(storedValue));
                } catch (error) {
                    console.warn('[yuzuki-Memory] Failed to cache global setting locally.', key, error);
                }
            }
            return storedValue;
        }

        if (localValue !== undefined) {
            if (options.migrate !== false && store) {
                set(key, localValue, extensionOnly ? { localFallback: false } : undefined);
                if (extensionOnly) removeLocalStorage(key);
            }
            return clone(localValue);
        }

        return clone(fallback);
    }

    function set(key, value, options = {}) {
        const extensionOnly = EXTENSION_ONLY_KEYS.has(key);
        const requirePersistent = options.requirePersistent === true;
        const cloned = clone(value);
        const store = getExtensionSettings(true);
        if (!store) {
            if (requirePersistent) {
                throw new Error(`SillyTavern extension_settings is unavailable for ${key}.`);
            }
        } else {
            const hadPreviousValue = Object.prototype.hasOwnProperty.call(store, key);
            const previousValue = hadPreviousValue ? clone(store[key]) : undefined;
            store[key] = cloned;
            const persistScheduled = persist({ immediate: options.immediate === true });
            if (requirePersistent && !persistScheduled) {
                if (hadPreviousValue) store[key] = previousValue;
                else delete store[key];
                throw new Error(`SillyTavern settings persistence is unavailable for ${key}.`);
            }
        }
        if (!extensionOnly && options.localFallback !== false) {
            try {
                localStorage.setItem(key, JSON.stringify(cloned));
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to write local fallback setting.', key, error);
            }
        } else if (extensionOnly && store) {
            removeLocalStorage(key);
        }
        return clone(cloned);
    }

    function remove(key, options = {}) {
        const extensionOnly = EXTENSION_ONLY_KEYS.has(key);
        const store = getExtensionSettings(false);
        if (store && Object.prototype.hasOwnProperty.call(store, key)) {
            delete store[key];
            persist();
        }
        if (extensionOnly || options.localFallback !== false) {
            removeLocalStorage(key);
        }
    }

    YuzukiMemory.GlobalSettings = Object.assign(YuzukiMemory.GlobalSettings || {}, {
        namespace: NAMESPACE,
        get,
        getExtension,
        getLocalFallback,
        removeLocalFallback,
        set,
        remove,
        persist,
        flushPersistence,
    });
})();
