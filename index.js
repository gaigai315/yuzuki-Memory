// ============================================================================
// yuzuki-Memory
// SillyTavern memory table plugin entry.
// Keep this file as the loader/bootstrap only; feature logic belongs in modules.
// ============================================================================
import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

(function () {
    'use strict';

    const NAMESPACE = 'YuzukiMemory';
    const VERSION = '1.0.7';
    const baseUrl = new URL('./', import.meta.url).href;
    let resolveReady;
    const readyPromise = new Promise((resolve) => {
        resolveReady = resolve;
    });

    const CONTROLLER_MODULES = [
        'ui/extension-toggle.js',
    ];
    const FEATURE_MODULES = [
        'config/global-settings.js',
        'config/mobile-world-info-compat.js',
        'config/timed-prompt-settings.js',
        'config/storage.js',
        'config/character-name-matcher.js',
        'config/character-status.js',
        'config/character-graph.js',
        'config/memory-io.js',
        'config/plot-summary.js',
        'config/memory-tag-parser.js',
        'config/branch-snapshot.js',
        'config/floor-ledger.js',
        'config/todo-manager.js',
        'config/prompt-library.js',
        'config/story-director-settings.js',
        'config/prompt-scheme-io.js',
        'config/llm-client.js',
        'config/worldbook-manager.js',
        'config/task-runner.js',
        'config/story-director-runtime.js',
        'config/embedding-client.js',
        'config/rerank-client.js',
        'config/vector-store.js',
        'config/floor-hider.js',
        'config/variable-injector.js',
        'config/prompt-ready-injector.js',
        'config/request-probe.js',
        'config/log-viewer.js',
        'ui/character-graph-window.js',
        'ui/memory-window.js',
    ];

    function isPluginEnabled() {
        return extension_settings?.yuzukiMemory?.masterSwitch !== false;
    }

    async function setPluginEnabled(enabled) {
        extension_settings.yuzukiMemory = extension_settings.yuzukiMemory || {};
        extension_settings.yuzukiMemory.masterSwitch = enabled === true;
        await saveSettings();
        return extension_settings.yuzukiMemory.masterSwitch;
    }

    if (window[NAMESPACE]?.loaded) {
        console.warn('[yuzuki-Memory] Already loaded, skipping duplicate init.');
        return;
    }

    window[NAMESPACE] = Object.assign(window[NAMESPACE] || {}, {
        loaded: true,
        version: VERSION,
        baseUrl,
        readyPromise,
        settingsBridge: Object.freeze({
            extensionSettings: extension_settings,
            saveSettings,
            saveSettingsDebounced,
            isPluginEnabled,
            setPluginEnabled,
            reloadPage: () => window.location.reload(),
        }),
    });

    globalThis.yuzukiMemoryGenerateInterceptor = async function (chat, _contextSize, _abort, type = 'normal') {
        const generationType = String(type || 'normal').trim().toLowerCase();
        if (!['normal', 'regenerate', 'swipe'].includes(generationType)) return;
        await readyPromise;
        if (!isPluginEnabled()) return;
        return window[NAMESPACE]?.StoryDirectorRuntime?.injectDirectorCardForGeneration?.(chat, {
            generationType,
        });
    };

    function resolveModule(path) {
        const url = new URL(path, baseUrl);
        url.searchParams.set('v', VERSION);
        return url.href;
    }

    function loadScript(path) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = resolveModule(path);
            script.async = false;
            script.dataset.yzmModule = path;
            script.onload = () => resolve(path);
            script.onerror = () => reject(new Error(`Failed to load module: ${path}`));
            document.head.appendChild(script);
        });
    }

    function onDomReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
            return;
        }
        callback();
    }

    async function bootstrap() {
        try {
            for (const modulePath of CONTROLLER_MODULES) {
                await loadScript(modulePath);
            }
            const pluginEnabled = isPluginEnabled();
            if (pluginEnabled) {
                for (const modulePath of FEATURE_MODULES) {
                    await loadScript(modulePath);
                }
            }
            resolveReady?.();

            onDomReady(() => {
                window[NAMESPACE].ToggleController?.mount?.();
                if (pluginEnabled) window[NAMESPACE].MemoryWindow?.mount?.();
                console.log(`[yuzuki-Memory] v${VERSION} ${pluginEnabled ? 'ready' : 'controller ready; features disabled'}.`);
            });
        } catch (error) {
            resolveReady?.();
            console.error('[yuzuki-Memory] Startup failed.', error);
        }
    }

    bootstrap();
})();
