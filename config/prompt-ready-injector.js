(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};

    function safeDeepClone(value) {
        try {
            if (typeof structuredClone === 'function') return structuredClone(value);
        } catch (_error) {
            // Fall through to JSON clone.
        }
        return JSON.parse(JSON.stringify(value));
    }

    async function injectPromptReadyChat(chat) {
        if (!Array.isArray(chat)) return chat;
        if (!YuzukiMemory.VariableInjector?.processBody) return chat;

        try {
            const safeChat = safeDeepClone(chat);
            const wrapper = { chat: safeChat };
            await YuzukiMemory.VariableInjector.processBody(wrapper, {
                disableVectorInjection: true,
                yzmPromptReadyHook: true,
            });
            return wrapper.chat;
        } catch (error) {
            console.warn('[yuzuki-Memory] prompt-ready memory injection failed.', error);
            return chat;
        }
    }

    function installPromptReadyHook() {
        if (YuzukiMemory.PromptReadyInjector?.installed) return true;
        if (!window.hooks || typeof window.hooks.addFilter !== 'function') return false;

        window.hooks.addFilter('chat_completion_prompt_ready', injectPromptReadyChat);
        YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
            installed: true,
            injectPromptReadyChat,
        });
        console.info('[yuzuki-Memory] chat_completion_prompt_ready memory injector installed.');
        return true;
    }

    YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
        installed: false,
        injectPromptReadyChat,
        installPromptReadyHook,
    });

    if (!installPromptReadyHook()) {
        let attempts = 0;
        const retryTimer = window.setInterval(() => {
            attempts += 1;
            if (installPromptReadyHook() || attempts >= 10) {
                window.clearInterval(retryTimer);
            }
        }, 1000);
    }
})();
