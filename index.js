// ============================================================================
// yuzuki-Memory
// SillyTavern memory table plugin entry.
// Keep this file as the loader/bootstrap only; feature logic belongs in modules.
// ============================================================================
(function () {
    'use strict';

    const NAMESPACE = 'YuzukiMemory';
    const VERSION = '0.1.0';
    const baseUrl = new URL('./', import.meta.url).href;

    const MODULES = [
        'config/global-settings.js',
        'config/storage.js',
        'config/memory-tag-parser.js',
        'config/prompt-library.js',
        'config/llm-client.js',
        'config/task-runner.js',
        'config/embedding-client.js',
        'config/rerank-client.js',
        'config/vector-store.js',
        'config/floor-hider.js',
        'config/variable-injector.js',
        'config/request-probe.js',
        'config/log-viewer.js',
        'ui/memory-window.js',
    ];

    if (window[NAMESPACE]?.loaded) {
        console.warn('[yuzuki-Memory] Already loaded, skipping duplicate init.');
        return;
    }

    window[NAMESPACE] = Object.assign(window[NAMESPACE] || {}, {
        loaded: true,
        version: VERSION,
        baseUrl,
    });

    function resolveModule(path) {
        return new URL(path, baseUrl).href;
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
            for (const modulePath of MODULES) {
                await loadScript(modulePath);
            }

            onDomReady(() => {
                window[NAMESPACE].MemoryWindow?.mount?.();
                console.log(`[yuzuki-Memory] v${VERSION} ready.`);
            });
        } catch (error) {
            console.error('[yuzuki-Memory] Startup failed.', error);
        }
    }

    bootstrap();
})();
