(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const FORMAT = 'yuzuki-memory-prompt-schemes';
    const VERSION = 1;

    function clone(value) {
        try {
            return structuredClone(value);
        } catch (_error) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function isScheme(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (!String(value.name || '').trim()) return false;
        return !!String(value.id || '').trim()
            || (value.prompts && typeof value.prompts === 'object')
            || (value.modes && typeof value.modes === 'object')
            || (value.timedPromptInjection && typeof value.timedPromptInjection === 'object');
    }

    function cleanScheme(scheme) {
        if (!isScheme(scheme)) throw new Error('方案数据缺少名称、ID 或提示词内容。');
        return clone({
            id: String(scheme.id || ''),
            name: String(scheme.name || '').trim(),
            builtin: scheme.builtin === true,
            tableVisibility: scheme.tableVisibility && typeof scheme.tableVisibility === 'object'
                ? scheme.tableVisibility
                : {},
            timedPromptInjection: scheme.timedPromptInjection && typeof scheme.timedPromptInjection === 'object'
                ? scheme.timedPromptInjection
                : {},
            prompts: scheme.prompts && typeof scheme.prompts === 'object' ? scheme.prompts : {},
            modes: scheme.modes && typeof scheme.modes === 'object' ? scheme.modes : {},
        });
    }

    function createExport(schemes, kind = 'all') {
        const normalized = (Array.isArray(schemes) ? schemes : [schemes])
            .filter(Boolean)
            .map(cleanScheme);
        if (!normalized.length) throw new Error('没有可导出的记忆方案。');
        const exportKind = kind === 'single' ? 'single' : 'all';
        const base = {
            format: FORMAT,
            version: VERSION,
            kind: exportKind,
            exportedAt: new Date().toISOString(),
        };
        return exportKind === 'single'
            ? { ...base, scheme: normalized[0] }
            : { ...base, schemes: normalized };
    }

    function extractImport(raw) {
        if (Array.isArray(raw)) {
            return { kind: raw.length === 1 ? 'single' : 'all', schemes: raw };
        }
        if (!raw || typeof raw !== 'object') {
            throw new Error('无法识别的记忆方案文件。');
        }
        if (isScheme(raw.scheme)) {
            return { kind: 'single', schemes: [raw.scheme] };
        }
        if (Array.isArray(raw.schemes)) {
            return {
                kind: raw.kind === 'single' && raw.schemes.length === 1 ? 'single' : 'all',
                schemes: raw.schemes,
            };
        }
        if (isScheme(raw)) {
            return { kind: 'single', schemes: [raw] };
        }
        throw new Error('文件中没有可导入的记忆方案。');
    }

    function parseText(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) throw new Error('导入文件为空。');
        let raw;
        try {
            raw = JSON.parse(trimmed);
        } catch (_error) {
            throw new Error('记忆方案文件不是有效的 JSON。');
        }
        const imported = extractImport(raw);
        const schemes = imported.schemes.filter(isScheme).map(cleanScheme);
        if (!schemes.length) throw new Error('文件中没有有效的记忆方案。');
        if (schemes.length !== imported.schemes.length) {
            throw new Error('文件中存在缺少名称、ID 或提示词内容的无效方案。');
        }
        return {
            format: String(raw?.format || ''),
            version: Number(raw?.version || 0),
            kind: imported.kind,
            schemes,
        };
    }

    function parseFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve(parseText(reader.result || ''));
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = () => reject(new Error('记忆方案文件读取失败。'));
            reader.readAsText(file);
        });
    }

    function sanitizeFilename(value, fallback = 'scheme') {
        const normalized = String(value || '').trim()
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '');
        return normalized || fallback;
    }

    function createTimestamp() {
        const date = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    function download(payload, filename) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function downloadCurrent(scheme) {
        const payload = createExport([scheme], 'single');
        const name = sanitizeFilename(payload.scheme.name, 'scheme');
        download(payload, `yuzuki_memory_scheme_${name}_${createTimestamp()}.json`);
        return payload;
    }

    function downloadAll(schemes) {
        const payload = createExport(schemes, 'all');
        download(payload, `yuzuki_memory_schemes_all_${createTimestamp()}.json`);
        return payload;
    }

    function comparableScheme(scheme) {
        const cleaned = cleanScheme(scheme);
        return {
            name: cleaned.name,
            tableVisibility: cleaned.tableVisibility,
            timedPromptInjection: cleaned.timedPromptInjection,
            prompts: cleaned.prompts,
            modes: cleaned.modes,
        };
    }

    function areSchemeContentsEqual(left, right) {
        try {
            return JSON.stringify(comparableScheme(left)) === JSON.stringify(comparableScheme(right));
        } catch (_error) {
            return false;
        }
    }

    function createUniqueName(name, schemes, currentId = '') {
        const base = String(name || '').trim() || '导入方案';
        const occupied = new Set((Array.isArray(schemes) ? schemes : [])
            .filter((scheme) => scheme.id !== currentId)
            .map((scheme) => String(scheme.name || '').trim()));
        if (!occupied.has(base)) return base;
        let index = 1;
        let candidate = `${base}（导入）`;
        while (occupied.has(candidate)) {
            index += 1;
            candidate = `${base}（导入 ${index}）`;
        }
        return candidate;
    }

    function createUniqueId(occupiedIds, createId) {
        let id = String(createId());
        while (!id || occupiedIds.has(id)) id = String(createId());
        occupiedIds.add(id);
        return id;
    }

    function mergeSchemes(existingSchemes, rawSchemes, options = {}) {
        const normalizeScheme = options.normalizeScheme;
        const createId = options.createId;
        if (typeof normalizeScheme !== 'function' || typeof createId !== 'function') {
            throw new Error('记忆方案合并器缺少标准化或 ID 生成函数。');
        }
        const existing = (Array.isArray(existingSchemes) ? existingSchemes : [])
            .map((scheme) => normalizeScheme(scheme))
            .filter(Boolean);
        const builtinSchemes = existing.filter((scheme) => scheme.builtin);
        const customSchemes = existing.filter((scheme) => !scheme.builtin);
        const builtinById = new Map(builtinSchemes.map((scheme) => [scheme.id, scheme]));
        const occupiedIds = new Set(existing.map((scheme) => scheme.id));
        const result = {
            schemes: [],
            added: 0,
            updated: 0,
            skippedBuiltin: 0,
            selectedId: '',
        };

        (Array.isArray(rawSchemes) ? rawSchemes : []).forEach((rawScheme) => {
            let imported = normalizeScheme({ ...rawScheme, builtin: false });
            if (!imported) return;
            const builtin = builtinById.get(imported.id);
            if (builtin) {
                if (areSchemeContentsEqual(imported, builtin)) {
                    result.skippedBuiltin += 1;
                    result.selectedId = builtin.id;
                    return;
                }
                imported = {
                    ...imported,
                    id: createUniqueId(occupiedIds, createId),
                    name: createUniqueName(imported.name, [...builtinSchemes, ...customSchemes]),
                    builtin: false,
                };
                customSchemes.push(imported);
                result.added += 1;
                result.selectedId = imported.id;
                return;
            }

            const existingIndex = customSchemes.findIndex((scheme) => scheme.id === imported.id);
            if (existingIndex >= 0) {
                imported = {
                    ...imported,
                    id: customSchemes[existingIndex].id,
                    name: createUniqueName(imported.name, [...builtinSchemes, ...customSchemes], imported.id),
                    builtin: false,
                };
                customSchemes[existingIndex] = imported;
                result.updated += 1;
                result.selectedId = imported.id;
                return;
            }

            if (!imported.id || occupiedIds.has(imported.id)) {
                imported.id = createUniqueId(occupiedIds, createId);
            } else {
                occupiedIds.add(imported.id);
            }
            imported.name = createUniqueName(imported.name, [...builtinSchemes, ...customSchemes]);
            imported.builtin = false;
            customSchemes.push(imported);
            result.added += 1;
            result.selectedId = imported.id;
        });

        result.schemes = [...builtinSchemes, ...customSchemes];
        return result;
    }

    YuzukiMemory.PromptSchemeIO = Object.assign(YuzukiMemory.PromptSchemeIO || {}, {
        FORMAT,
        VERSION,
        createExport,
        parseText,
        parseFile,
        downloadCurrent,
        downloadAll,
        areSchemeContentsEqual,
        mergeSchemes,
    });
})();
