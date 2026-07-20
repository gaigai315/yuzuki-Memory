// ============================================================================
// yuzuki-Memory global settings.
// Stores global plugin config in localStorage so browser windows share the
// latest value immediately, and mirrors it to SillyTavern extension_settings.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const NAMESPACE = 'yuzukiMemory';

    function getContext() {
        return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
            ? SillyTavern.getContext()
            : null;
    }

    function getExtensionSettings(create = false) {
        const context = getContext();
        let contextStore = null;
        if (context) {
            context.extensionSettings = context.extensionSettings || {};
            if (create && !context.extensionSettings[NAMESPACE]) context.extensionSettings[NAMESPACE] = {};
            if (context.extensionSettings[NAMESPACE]) contextStore = context.extensionSettings[NAMESPACE];
        }

        window.extension_settings = window.extension_settings || {};
        if (create && !window.extension_settings[NAMESPACE]) window.extension_settings[NAMESPACE] = {};
        const windowStore = window.extension_settings[NAMESPACE] || null;
        if (contextStore && windowStore && contextStore !== windowStore) {
            const mergedStore = Object.assign({}, windowStore, contextStore);
            context.extensionSettings[NAMESPACE] = mergedStore;
            window.extension_settings[NAMESPACE] = mergedStore;
            return mergedStore;
        }
        if (contextStore) {
            window.extension_settings[NAMESPACE] = contextStore;
            return contextStore;
        }
        if (windowStore && context) {
            context.extensionSettings[NAMESPACE] = windowStore;
        }
        return windowStore;
    }

    function persist() {
        const context = getContext();
        if (typeof context?.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
            return;
        }
        if (typeof window.saveSettingsDebounced === 'function') {
            window.saveSettingsDebounced();
        }
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

    function valuesMatch(left, right) {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return left === right;
        }
    }

    function get(key, fallback = null, options = {}) {
        const localValue = parseLocalStorage(key, undefined);
        const store = getExtensionSettings(false);
        const hasStoredValue = !!store && Object.prototype.hasOwnProperty.call(store, key);

        if (localValue !== undefined) {
            if (options.migrate !== false && (!hasStoredValue || !valuesMatch(store[key], localValue))) {
                set(key, localValue);
            }
            return clone(localValue);
        }

        if (hasStoredValue) {
            const storedValue = clone(store[key]);
            if (options.localFallback !== false) {
                try {
                    localStorage.setItem(key, JSON.stringify(storedValue));
                } catch (error) {
                    console.warn('[yuzuki-Memory] Failed to cache global setting locally.', key, error);
                }
            }
            return storedValue;
        }

        return clone(fallback);
    }

    function set(key, value, options = {}) {
        const cloned = clone(value);
        const store = getExtensionSettings(true);
        if (store) {
            store[key] = cloned;
            const context = getContext();
            if (context?.extensionSettings) {
                context.extensionSettings[NAMESPACE] = store;
            }
            window.extension_settings = window.extension_settings || {};
            window.extension_settings[NAMESPACE] = store;
            persist();
        }
        if (options.localFallback !== false) {
            try {
                localStorage.setItem(key, JSON.stringify(cloned));
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to write local fallback setting.', key, error);
            }
        }
        return clone(cloned);
    }

    function remove(key, options = {}) {
        const store = getExtensionSettings(false);
        if (store && Object.prototype.hasOwnProperty.call(store, key)) {
            delete store[key];
            const context = getContext();
            if (context?.extensionSettings) {
                context.extensionSettings[NAMESPACE] = store;
            }
            window.extension_settings = window.extension_settings || {};
            window.extension_settings[NAMESPACE] = store;
            persist();
        }
        if (options.localFallback !== false) {
            try {
                localStorage.removeItem(key);
            } catch (_error) {
                // Ignore local fallback cleanup failures.
            }
        }
    }

    YuzukiMemory.GlobalSettings = Object.assign(YuzukiMemory.GlobalSettings || {}, {
        namespace: NAMESPACE,
        get,
        set,
        remove,
        persist,
    });
})();
