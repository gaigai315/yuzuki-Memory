(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const SETTINGS_KEY = 'yzm_memory_global_timed_prompt_injection';
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';

    function clone(value) {
        if (value === undefined || value === null) return value;
        try {
            return structuredClone(value);
        } catch (_error) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function createRuleId() {
        return `timed_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeRule(rawRule, index = 0) {
        const source = rawRule && typeof rawRule === 'object' ? rawRule : {};
        const interval = Math.max(1, Math.min(9999, Math.round(Number(source.interval ?? source.every ?? source.floorInterval ?? 8) || 8)));
        return {
            id: String(source.id || `timed_prompt_legacy_${index + 1}`),
            name: String(source.name || `提示词 ${String(index + 1).padStart(2, '0')}`).trim(),
            interval,
            content: String(source.content ?? source.prompt ?? source.text ?? ''),
            enabled: source.enabled !== false,
        };
    }

    function normalize(source = {}) {
        const raw = source && typeof source === 'object' ? source : {};
        const rawRules = Array.isArray(raw.rules)
            ? raw.rules
            : (Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.prompts) ? raw.prompts : []));
        return {
            enabled: raw.enabled === true,
            rules: rawRules.map(normalizeRule).filter((rule) => rule.content || rule.name),
        };
    }

    function mergeLegacyConfigs(sources) {
        const configs = (Array.isArray(sources) ? sources : []).map(normalize);
        const signatures = new Set();
        const usedIds = new Set();
        const rules = [];
        configs.forEach((config) => {
            config.rules.forEach((rule) => {
                const signature = JSON.stringify([rule.name, rule.interval, rule.content, rule.enabled]);
                if (signatures.has(signature)) return;
                signatures.add(signature);
                let id = String(rule.id || createRuleId());
                let suffix = 1;
                while (usedIds.has(id)) {
                    id = `${rule.id || 'timed_prompt'}_migrated_${suffix}`;
                    suffix += 1;
                }
                usedIds.add(id);
                rules.push({ ...rule, id });
            });
        });
        return {
            enabled: configs.some((config) => config.enabled),
            rules,
        };
    }

    function stripLegacySchemeSettings(rawSchemes) {
        let changed = false;
        const schemes = (Array.isArray(rawSchemes) ? rawSchemes : []).map((scheme) => {
            if (!scheme || typeof scheme !== 'object') return scheme;
            if (!Object.prototype.hasOwnProperty.call(scheme, 'timedPromptInjection')
                && !Object.prototype.hasOwnProperty.call(scheme, 'timedInjection')) {
                return scheme;
            }
            changed = true;
            const cleaned = { ...scheme };
            delete cleaned.timedPromptInjection;
            delete cleaned.timedInjection;
            return cleaned;
        });
        return { changed, schemes };
    }

    function migrateLegacySettings() {
        const globalSettings = YuzukiMemory.GlobalSettings;
        if (!globalSettings?.get || !globalSettings?.set) return normalize();
        const rawSchemes = globalSettings.get(PROMPT_SCHEMES_STORAGE_KEY, []);
        const legacySources = (Array.isArray(rawSchemes) ? rawSchemes : [])
            .map((scheme) => scheme?.timedPromptInjection || scheme?.timedInjection)
            .filter((source) => source && typeof source === 'object');
        const migrated = mergeLegacyConfigs(legacySources);
        const cleaned = stripLegacySchemeSettings(rawSchemes);
        globalSettings.set(SETTINGS_KEY, migrated);
        if (cleaned.changed) globalSettings.set(PROMPT_SCHEMES_STORAGE_KEY, cleaned.schemes);
        return clone(migrated);
    }

    function load() {
        const globalSettings = YuzukiMemory.GlobalSettings;
        if (!globalSettings?.get) return normalize();
        const stored = globalSettings.get(SETTINGS_KEY, null);
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) return normalize(stored);
        return migrateLegacySettings();
    }

    function save(source) {
        const normalized = normalize(source);
        YuzukiMemory.GlobalSettings?.set?.(SETTINGS_KEY, normalized);
        return clone(normalized);
    }

    YuzukiMemory.TimedPromptSettings = Object.assign(YuzukiMemory.TimedPromptSettings || {}, {
        storageKey: SETTINGS_KEY,
        createRuleId,
        normalizeRule,
        normalize,
        load,
        save,
        migrateLegacySettings,
    });
})();
