// ============================================================================
// yuzuki-Memory task runner.
// Handles plugin-owned trace/summary tasks without touching SillyTavern chat text.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const TAG_PRESETS_STORAGE_KEY = 'yzm_memory_global_tag_presets';
    const LLM_API_PRESETS_STORAGE_KEY = 'yzm_memory_global_llm_api_presets';
    const LLM_API_MODE_STORAGE_KEY = 'yzm_memory_global_llm_api_mode';
    const LLM_API_ACTIVE_PRESET_STORAGE_KEY = 'yzm_memory_global_llm_api_active_preset';
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_active';
    const PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_character_bindings';
    const AUTO_SUMMARY_SETTINGS_STORAGE_KEY = 'yzm_memory_global_auto_summary_settings';
    const PLUGIN_SETTINGS_STORAGE_KEY = 'yzm_memory_global_plugin_settings';
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const PLOT_SUMMARY_TABLE_ID = 'plot_summary';
    let autoSummaryBound = false;
    let autoSummaryTimer = null;
    let autoSummaryRunning = false;
    let autoSummaryPromptOpen = false;

    function parseJsonStorage(key, fallback) {
        const globalValue = YuzukiMemory.GlobalSettings?.get?.(key, undefined);
        if (globalValue !== undefined) return globalValue === null ? fallback : globalValue;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '');
            return parsed === undefined || parsed === null ? fallback : parsed;
        } catch {
            return fallback;
        }
    }

    function splitTagText(text = '') {
        return String(text || '')
            .split(/[,，\n]+/)
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    function normalizeTagList(tags) {
        const seen = new Set();
        return (Array.isArray(tags) ? tags : splitTagText(tags))
            .map((tag) => String(tag || '').trim())
            .filter((tag) => {
                if (!tag || seen.has(tag)) return false;
                seen.add(tag);
                return true;
            });
    }

    function getActiveTagPreset() {
        const presets = parseJsonStorage(TAG_PRESETS_STORAGE_KEY, []);
        return Array.isArray(presets) ? presets.find((preset) => preset && (preset.blacklist?.length || preset.whitelist?.length)) || null : null;
    }

    function getPluginSettings() {
        const settings = parseJsonStorage(PLUGIN_SETTINGS_STORAGE_KEY, {});
        return {
            fillMode: settings?.fillMode === 'batch' ? 'batch' : 'realtime',
        };
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function filterContentByTags(content, preset = getActiveTagPreset()) {
        if (!content || !preset) return String(content || '');
        let result = String(content || '');
        normalizeTagList(preset.blacklist).forEach((tag) => {
            let re;
            if (tag.startsWith('!--')) {
                re = new RegExp(`<!--[\\s\\S]*?-->`, 'gi');
            } else if (tag.startsWith('[') && tag.endsWith(']')) {
                const inner = escapeRegExp(tag.slice(1, -1));
                re = new RegExp(`\\[${inner}(?:\\s+[^\\]]*)?\\][\\s\\S]*?\\[\\/${inner}\\s*\\]`, 'gi');
            } else {
                const safe = escapeRegExp(tag);
                re = new RegExp(`<${safe}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${safe}\\s*>`, 'gi');
            }
            let previous = '';
            let guard = 0;
            while (previous !== result && guard < 50) {
                previous = result;
                result = result.replace(re, '');
                guard += 1;
            }
        });

        const whitelist = normalizeTagList(preset.whitelist);
        if (whitelist.length) {
            const extracted = [];
            whitelist.forEach((tag) => {
                let re;
                if (tag.startsWith('!--')) {
                    re = /<!--([\s\S]*?)-->/gi;
                } else if (tag.startsWith('[') && tag.endsWith(']')) {
                    const inner = escapeRegExp(tag.slice(1, -1));
                    re = new RegExp(`\\[${inner}(?:\\s+[^\\]]*)?\\]([\\s\\S]*?)(?:\\[\\/${inner}\\s*\\]|$)`, 'gi');
                } else {
                    const safe = escapeRegExp(tag);
                    re = new RegExp(`<${safe}(?:\\s+[^>]*)?>([\\s\\S]*?)(?:<\\/${safe}\\s*>|$)`, 'gi');
                }
                let match;
                while ((match = re.exec(result)) !== null) {
                    const text = String(match[1] || '').trim();
                    if (text) extracted.push(text);
                }
            });
            if (extracted.length) result = extracted.join('\n\n');
        }
        return result.trim();
    }

    function stripMemoryTags(text = '') {
        return String(text || '')
            .replace(/<Memory>[\s\S]*?<\/Memory>/gi, '')
            .replace(/<GaigaiMemory>[\s\S]*?<\/GaigaiMemory>/gi, '')
            .replace(/\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\}\}/gi, '')
            .trim();
    }

    function stripImages(text = '') {
        return String(text || '')
            .replace(/<img[^>]*src=["']data:image[^"']*["'][^>]*>/gi, '[图片]')
            .replace(/!\[[^\]]*\]\(data:image[^)]*\)/gi, '[图片]');
    }

    function getContext() {
        return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
            ? SillyTavern.getContext()
            : null;
    }

    function getCurrentCharacterPromptKey() {
        const ctx = getContext() || {};
        if (ctx.groupId) return `group:${ctx.groupId}`;
        const character = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const characterId = ctx.characterId;
        const raw = characterId !== undefined && characterId !== null && String(characterId) !== ''
            ? characterId
            : (character?.avatar || character?.name || ctx.name2 || ctx.characterName || '');
        return raw !== '' ? `char:${raw}` : '';
    }

    function getChatText(message) {
        const swipeId = Number(message?.swipe_id ?? 0);
        if (Array.isArray(message?.swipes) && message.swipes.length > swipeId) return String(message.swipes[swipeId] || '');
        return String(message?.mes || message?.content || '');
    }

    function isPluginMessage(message) {
        return !!(message?.isGaigaiData || message?.isGaigaiPrompt || message?.isPhoneMessage || message?.yzmMemoryInternal);
    }

    function chatMessagesFromRange(start, end, options = {}) {
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const userName = ctx?.name1 || 'User';
        const charName = ctx?.characters?.[ctx.characterId]?.name || ctx?.name2 || 'Character';
        const from = Math.max(0, Math.min(Number(start) || 0, chat.length));
        const to = Math.max(from, Math.min(Number(end) || chat.length, chat.length));
        const tagPreset = options.tagPreset === false ? null : getActiveTagPreset();
        const messages = [];

        chat.slice(from, to).forEach((message, offset) => {
            if (!message || message.role === 'system' || message.is_system === true || isPluginMessage(message)) return;
            let content = stripImages(stripMemoryTags(getChatText(message)));
            content = filterContentByTags(content, tagPreset);
            if (!content.trim()) return;
            const isUser = message.is_user === true || message.role === 'user';
            const name = message.name || (isUser ? userName : charName);
            const floor = from + offset;
            messages.push({
                role: isUser ? 'user' : 'assistant',
                content: `[楼层 ${floor}] ${name}: ${content}`,
            });
        });

        return { ctx, chat, messages, start: from, end: to, userName, charName };
    }

    function compactLines(lines) {
        return lines.map((line) => String(line || '').trim()).filter(Boolean).join('\n');
    }

    function stateTables(state) {
        return Array.isArray(state?.tables) ? state.tables : [];
    }

    function stateRecords(state, tableId) {
        const records = state?.records?.[tableId];
        return Array.isArray(records) ? records : [];
    }

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^#/, '').trim();
    }

    function isAppendColumn(column) {
        return String(column || '').trim().startsWith('#');
    }

    function getPrimaryColumn(table) {
        return cleanColumnName(table?.columns?.[0]) || '名称';
    }

    function recordTitle(table, record) {
        return String(record?.values?.[getPrimaryColumn(table)] || '').trim();
    }

    function recordToText(table, record) {
        if (!table || !record || record.hidden) return '';
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const body = (table.columns || [])
            .map((column) => {
                const name = cleanColumnName(column);
                const value = String(values[name] ?? values[column] ?? '').trim();
                return value ? `${name}: ${value}` : '';
            })
            .filter(Boolean)
            .join('；');
        return body ? `- ${body}` : '';
    }

    function tablesToReferenceText(state, options = {}) {
        return stateTables(state)
            .filter((table) => !table.hidden && table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !options.tableId || table.id === options.tableId)
            .map((table) => {
                const rows = stateRecords(state, table.id).map((record) => recordToText(table, record)).filter(Boolean);
                return compactLines([`【${table.name}】`, rows.length ? rows.join('\n') : '（当前暂无数据）']);
            })
            .filter(Boolean)
            .join('\n\n');
    }

    function buildDatabaseSchemaText(state, options = {}) {
        if (YuzukiMemory.VariableInjector?.buildDatabaseSchemaText) {
            return YuzukiMemory.VariableInjector.buildDatabaseSchemaText(state, options);
        }
        const lines = stateTables(state)
            .filter((table) => !table.hidden && table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !options.tableId || table.id === options.tableId)
            .map((table) => {
                const columns = (table.columns || []).map(cleanColumnName).filter(Boolean);
                const fields = columns.map((column, index) => index === 0 ? `${column}(主键)` : column).join(', ');
                return `#${table.name}：包含 ${fields}`;
            })
            .filter(Boolean);
        return compactLines(lines);
    }

    function resolveTaskPromptVariables(text, state, options = {}) {
        const names = getRuntimeNames();
        return String(text || '')
            .replace(/\{\{user\}\}/g, names.user)
            .replace(/\{\{char\}\}/g, names.char)
            .replace(/\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS)\}\}/gi, () => buildDatabaseSchemaText(state, options))
            .replace(/\{\{MEMORY_TABLE_(.+?)\}\}/gi, (_match, tableName) => YuzukiMemory.VariableInjector?.buildSpecificTableText?.(state, tableName) || '')
            .replace(/\{\{MEMORY_SUMMARY_(.+?)\}\}/gi, (_match, summaryKey) => YuzukiMemory.VariableInjector?.buildSpecificSummaryText?.(state, summaryKey) || '')
            .replace(/\{\{MEMORY_TABLE\}\}/gi, () => YuzukiMemory.VariableInjector?.buildAllTablesText?.(state) || tablesToReferenceText(state, options))
            .replace(/\{\{MEMORY_SUMMARY\}\}/gi, () => YuzukiMemory.VariableInjector?.buildSummaryText?.(state) || '')
            .replace(/\{\{MEMORY_PROMPT\}\}/gi, '')
            .replace(/\{\{MEMORY\}\}/gi, () => YuzukiMemory.VariableInjector?.buildMemoryText?.(state) || compactLines([YuzukiMemory.VariableInjector?.buildSummaryText?.(state), tablesToReferenceText(state, options)]));
    }

    function getActivePromptScheme(state) {
        const schemes = parseJsonStorage(PROMPT_SCHEMES_STORAGE_KEY, []);
        const defaultScheme = YuzukiMemory.PromptLibrary?.getDefaultScheme?.();
        const sourceSchemes = [
            defaultScheme,
            ...(Array.isArray(schemes) ? schemes : []),
        ].filter((scheme, index, list) => scheme && list.findIndex((entry) => entry?.id === scheme.id) === index);
        const normalized = sourceSchemes.map((scheme) => {
            const prompts = YuzukiMemory.PromptLibrary?.mergeSchemePrompts?.(scheme)
                || (scheme?.prompts && typeof scheme.prompts === 'object' ? scheme.prompts : {});
            return {
                ...scheme,
                prompts: {
                    historian: String(prompts.historian || ''),
                    traceRealtime: String(prompts.traceRealtime ?? prompts.trace ?? prompts.table ?? ''),
                    traceBatch: String(prompts.traceBatch ?? ''),
                    trace: String(prompts.trace ?? prompts.traceRealtime ?? prompts.table ?? ''),
                    traceOptimize: String(prompts.traceOptimize ?? prompts.table ?? ''),
                    summary: String(prompts.summary ?? prompts.summaryOptimize ?? ''),
                    summaryOptimize: String(prompts.summaryOptimize ?? prompts.summary ?? ''),
                },
            };
        });
        const bindings = parseJsonStorage(PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY, {});
        const characterKey = getCurrentCharacterPromptKey();
        const characterId = characterKey && bindings && typeof bindings === 'object'
            ? String(bindings[characterKey] || '')
            : '';
        const globalId = String(YuzukiMemory.GlobalSettings?.get?.(PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY, '')
            ?? localStorage.getItem(PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY)
            ?? '');
        const activeId = characterId || globalId || String(state?.promptPresetId || '');
        return normalized.find((scheme) => scheme.id === activeId)
            || normalized[0]
            || { prompts: YuzukiMemory.PromptLibrary?.mergeSchemePrompts?.({ prompts: {} }) || {} };
    }

    function getLlmMode() {
        const mode = YuzukiMemory.GlobalSettings?.get?.(LLM_API_MODE_STORAGE_KEY, null)
            ?? localStorage.getItem(LLM_API_MODE_STORAGE_KEY);
        return mode === 'custom' ? 'custom' : 'tavern';
    }

    function getActiveLlmPreset() {
        const presets = parseJsonStorage(LLM_API_PRESETS_STORAGE_KEY, []);
        if (!Array.isArray(presets) || !presets.length) return null;
        const activeId = String(YuzukiMemory.GlobalSettings?.get?.(LLM_API_ACTIVE_PRESET_STORAGE_KEY, '')
            ?? localStorage.getItem(LLM_API_ACTIVE_PRESET_STORAGE_KEY)
            ?? '');
        return presets.find((preset) => preset.id === activeId) || presets[0] || null;
    }

    async function generate(messages, options = {}) {
        if (!YuzukiMemory.LlmClient) return { success: false, error: 'LLM 客户端尚未加载。' };
        const previousSummarizing = window.isSummarizing;
        window.isSummarizing = true;
        try {
            if (getLlmMode() === 'custom') {
                const preset = getActiveLlmPreset();
                if (!preset) return { success: false, error: '未选择可用的 LLM API 预设。' };
                return YuzukiMemory.LlmClient.generateWithCustom(preset, messages, { stream: preset.stream !== false, ...options });
            }
            return YuzukiMemory.LlmClient.generateWithTavern(messages, { stream: true, ...options });
        } finally {
            window.isSummarizing = previousSummarizing;
        }
    }

    function parseJsonBlock(text = '') {
        const source = String(text || '').trim();
        const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) return JSON.parse(fenced[1].trim());
        try {
            return JSON.parse(source);
        } catch {
            const firstObject = source.indexOf('{');
            const firstArray = source.indexOf('[');
            const starts = [firstObject, firstArray].filter((index) => index >= 0);
            const start = starts.length ? Math.min(...starts) : -1;
            const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'));
            if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
            throw new Error('未找到可解析的 JSON 结果。');
        }
    }

    function normalizeTaskRows(parsed) {
        const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.records) ? parsed.records : []);
        return rows
            .map((row) => row && typeof row === 'object' ? row : null)
            .filter(Boolean)
            .map((row) => ({
                table: String(row.table || row.tableId || row.tableName || '').trim(),
                values: row.values && typeof row.values === 'object' ? row.values : row,
            }));
    }

    function parseTraceResponse(text = '') {
        try {
            return parseJsonBlock(text);
        } catch (error) {
            const parser = YuzukiMemory.MemoryTagParser;
            const rows = parser?.extractMemoryRows?.(text) || [];
            if (rows.length) return { memoryRows: rows };
            const fallbackRows = parser?.parseMemoryText?.(text) || [];
            if (fallbackRows.length) return { memoryRows: fallbackRows };
            throw error;
        }
    }

    function normalizeSummaryPayload(parsed) {
        const source = parsed && typeof parsed === 'object' ? parsed : {};
        return {
            kind: String(source.kind || source.type || 'main').includes('branch') || String(source.kind || source.type || '').includes('支线') ? 'branch' : 'main',
            title: String(source.title || source['总结标题'] || source.name || '').trim(),
            content: String(source.content || source['总结内容'] || source.summary || '').trim(),
            timeline: Array.isArray(source.timeline) ? source.timeline.join('\n') : String(source.timeline || source['时间线'] || '').trim(),
            unresolved: Array.isArray(source.unresolved) ? source.unresolved.join('\n') : String(source.unresolved || source['未解决问题'] || '').trim(),
            remark: String(source.remark || source.note || source['备注'] || '').trim(),
        };
    }

    function getSummaryPreview(payload) {
        if (!payload) return '';
        return compactLines([
            payload.title ? `标题：${payload.title}` : '',
            payload.kind ? `类型：${payload.kind === 'branch' ? '支线' : '主线'}` : '',
            payload.content ? `内容：${payload.content}` : '',
            payload.timeline ? `时间线：${payload.timeline}` : '',
            payload.unresolved ? `未解决：${payload.unresolved}` : '',
            payload.remark ? `备注：${payload.remark}` : '',
        ]);
    }

    function getTracePreview(rows) {
        if (rows?.memoryRows) {
            return rows.memoryRows
                .map((row, index) => {
                    const values = Object.entries(row.values || {})
                        .filter(([, value]) => String(value || '').trim())
                        .map(([key, value]) => `${key}: ${value}`)
                        .join('；');
                    return `${index + 1}. ${row.table || '未指定表格'} - ${row.primaryValue || '未命名'}${values ? `；${values}` : ''}`;
                })
                .join('\n');
        }
        return normalizeTaskRows(rows)
            .map((row, index) => {
                const values = Object.entries(row.values || {})
                    .filter(([, value]) => String(value || '').trim())
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('；');
                return `${index + 1}. ${row.table || '未指定表格'}${values ? ` - ${values}` : ''}`;
            })
            .join('\n');
    }

    function createRecord(table, values = {}) {
        return {
            id: `record_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            hidden: false,
            values: Object.fromEntries((table?.columns || []).map((column) => {
                const name = cleanColumnName(column);
                return [name, String(values[name] ?? values[column] ?? '')];
            })),
        };
    }

    function findTargetTable(state, tableKey) {
        const key = String(tableKey || '').trim();
        const tables = stateTables(state).filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID);
        return tables.find((table) => table.id === key)
            || tables.find((table) => table.name === key)
            || tables.find((table) => key && table.name.includes(key))
            || null;
    }

    function upsertRecord(state, table, values = {}) {
        if (!table) return null;
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        const records = state.records[table.id];
        const primary = getPrimaryColumn(table);
        const normalizedValues = Object.fromEntries((table.columns || []).map((column) => {
            const name = cleanColumnName(column);
            return [name, String(values[name] ?? values[column] ?? values[name.toLowerCase()] ?? '')];
        }));
        const primaryValue = String(normalizedValues[primary] || values[primary] || values.name || values.title || '').trim();
        if (primaryValue) normalizedValues[primary] = primaryValue;
        if (!normalizedValues[primary]) normalizedValues[primary] = `${primary}${records.length + 1}`;

        let record = records.find((entry) => recordTitle(table, entry) === normalizedValues[primary]);
        if (!record) {
            record = createRecord(table, normalizedValues);
            records.push(record);
        } else {
            record.values = record.values && typeof record.values === 'object' ? record.values : {};
            record.values[primary] = normalizedValues[primary];
            (table.columns || []).forEach((column) => {
                const name = cleanColumnName(column);
                if (name === primary) return;
                const nextValue = String(normalizedValues[name] || '').trim();
                if (!nextValue) return;
                record.values[name] = isAppendColumn(column)
                    ? [String(record.values[name] || '').trim(), nextValue].filter(Boolean).join('；')
                    : nextValue;
            });
        }
        return record;
    }

    function appendPlotSummary(state, text, kind = 'main') {
        const table = stateTables(state).find((entry) => entry.id === PLOT_SUMMARY_TABLE_ID);
        if (!table || !text) return null;
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        let record = state.records[table.id][0];
        if (!record) {
            record = createRecord(table, {});
            state.records[table.id].push(record);
        }
        const field = kind === 'branch' ? '支线' : '主线';
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        record.values[field] = [String(record.values[field] || '').trim(), String(text || '').trim()].filter(Boolean).join('\n');
        return record;
    }

    function getRangeMeta(range) {
        const start = Math.max(0, Math.round(Number(range?.start) || 0));
        const end = Math.max(start, Math.round(Number(range?.end) || 0));
        return end > start ? { start, end } : null;
    }

    function getRangeLabel(range) {
        const normalized = getRangeMeta(range);
        return normalized ? `${normalized.start}-${normalized.end}（不含${normalized.end}）` : '';
    }

    function upsertSummaryRecord(state, payload, meta = {}) {
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table) return null;
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        const label = payload.kind === 'branch' ? '支线总结' : '主线总结';
        const title = payload.title || `${label}${state.records[table.id].length + 1}`;
        const rangeLabel = getRangeLabel(meta.range);
        const remark = rangeLabel && !String(payload.remark || '').includes(rangeLabel)
            ? compactLines([payload.remark, `楼层范围：${rangeLabel}`])
            : payload.remark;
        const values = {
            [getPrimaryColumn(table)]: title,
            总结内容: payload.content,
            时间线: payload.timeline,
            未解决问题: payload.unresolved,
            备注: remark,
        };
        const record = createRecord(table, values);
        if (rangeLabel || meta.autoTaskType) {
            record.meta = {
                ...(record.meta || {}),
                yzmMemoryTask: {
                    kind: 'summary',
                    summaryType: meta.autoTaskType || 'manual',
                    range: getRangeMeta(meta.range),
                    createdAt: Date.now(),
                },
            };
        }
        state.records[table.id].push(record);
        return record;
    }

    function getSummaryRecordTaskMeta(record) {
        const task = record?.meta?.yzmMemoryTask;
        return task && typeof task === 'object' ? task : null;
    }

    function cleanupSmallAutoSummaries(state, range, keepRecordId = '') {
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        const records = stateRecords(state, FIXED_SUMMARY_TABLE_ID);
        if (!table || !records.length) return 0;
        const target = getRangeMeta(range);
        if (!target) return 0;
        const nextRecords = records.filter((record) => {
            if (record?.id === keepRecordId) return true;
            const task = getSummaryRecordTaskMeta(record);
            const recordRange = getRangeMeta(task?.range);
            const isSmallAutoSummary = task?.kind === 'summary' && task?.summaryType === 'summary';
            if (!isSmallAutoSummary || !recordRange) return true;
            return !(recordRange.start >= target.start && recordRange.end <= target.end);
        });
        state.records[table.id] = nextRecords;
        return records.length - nextRecords.length;
    }

    function applyTraceResult(state, resultRows) {
        if (resultRows?.memoryRows && YuzukiMemory.MemoryTagParser?.applyRowsToState) {
            return YuzukiMemory.MemoryTagParser.applyRowsToState(state, resultRows.memoryRows);
        }
        const rows = normalizeTaskRows(resultRows);
        let count = 0;
        rows.forEach((row) => {
            const table = findTargetTable(state, row.table);
            if (!table) return;
            upsertRecord(state, table, row.values);
            count += 1;
        });
        return count;
    }

    function commitTraceResult(state, result) {
        const count = applyTraceResult(state, result?.parsed);
        return { ...result, success: true, count };
    }

    function commitSummaryResult(state, result) {
        const payload = result?.payload;
        if (!payload?.content) return { ...result, success: false, error: '总结结果缺少 content/总结内容。' };
        const record = upsertSummaryRecord(state, payload, result?.meta);
        if (payload.content) appendPlotSummary(state, `${payload.title || '总结'}：${payload.content}`, payload.kind);
        return { ...result, success: true, count: record ? 1 : 0, record };
    }

    function getDefaultTracePrompt(state, options = {}) {
        return `你是记忆表格追溯助手。请阅读聊天记录，提取应该写入记忆表格的信息。
只输出 JSON，不要解释。格式：
{"records":[{"table":"表名或表ID","values":{"字段名":"字段值"}}]}

{{DATABASE_SCHEMA}}`;
    }

    function getDefaultSummaryPrompt() {
        return `你是剧情总结助手。请总结给定聊天范围。
只输出 JSON，不要解释。格式：
{"kind":"main","title":"总结标题","content":"总结正文","timeline":"时间线","unresolved":"未解决问题","remark":"备注"}`;
    }

    function getTracePromptFromScheme(scheme) {
        const prompts = scheme?.prompts || {};
        return String(prompts.traceBatch || '');
    }

    function getDefaultOptimizePrompt(kind = 'trace') {
        if (kind === 'summary') {
            return `你是总结优化助手。请整理现有总结，合并重复、修正冲突、补齐时间线。只输出 JSON，格式同总结任务。`;
        }
        return `你是记忆表格优化助手。请整理现有表格内容，合并重复、修正冲突。只输出 JSON，格式同追溯任务。`;
    }

    function buildTaskRangeText(range, kind = 'trace') {
        const start = Math.max(0, Math.round(Number(range?.start) || 0));
        const end = Math.max(start, Math.round(Number(range?.end) || 0));
        const label = kind === 'summary' ? '总结' : '追溯填表';
        return compactLines([
            `【本次${label}任务】`,
            `处理楼层范围：${start} ~ ${end}（左闭右开，不含 ${end}）`,
            `实际聊天条目数：${Array.isArray(range?.messages) ? range.messages.length : 0}`,
            '聊天内容已按原始楼层编号标注为 [楼层 N]。',
        ]);
    }

    function buildTraceMessages(state, options = {}) {
        const scheme = getActivePromptScheme(state);
        const range = chatMessagesFromRange(options.start, options.end);
        const prompt = resolveTaskPromptVariables(compactLines([scheme?.prompts?.historian, getTracePromptFromScheme(scheme) || getDefaultTracePrompt(state, options)]), state, options);
        const messages = [
            { role: 'system', content: prompt },
            { role: 'system', content: buildTaskRangeText(range, 'trace') },
            { role: 'system', content: `【已归档记忆，仅供参考】\n${tablesToReferenceText(state, options) || '（暂无）'}` },
            { role: 'system', content: `【背景资料】\n角色: ${range.charName}\n用户: ${range.userName}` },
            ...range.messages,
            { role: 'user', content: `请根据以上 ${range.start} ~ ${range.end}（不含 ${range.end}）楼层聊天记录执行追溯填表。严格按系统提示词要求的结果格式输出。` },
        ].filter((message) => message.content && message.content.trim());
        return { messages, range };
    }

    function buildSummaryMessages(state, options = {}) {
        const scheme = getActivePromptScheme(state);
        const range = chatMessagesFromRange(options.start, options.end);
        const prompt = resolveTaskPromptVariables(compactLines([scheme?.prompts?.historian, scheme?.prompts?.summary || getDefaultSummaryPrompt()]), state, options);
        const messages = [
            { role: 'system', content: prompt },
            { role: 'system', content: buildTaskRangeText(range, 'summary') },
            { role: 'system', content: `【背景资料】\n角色: ${range.charName}\n用户: ${range.userName}` },
            ...range.messages,
            { role: 'user', content: `请总结以上 ${range.start} ~ ${range.end}（不含 ${range.end}）楼层范围。只输出 JSON。` },
        ].filter((message) => message.content && message.content.trim());
        return { messages, range };
    }

    async function runTrace(state, options = {}) {
        const built = buildTraceMessages(state, options);
        if (!built.range.messages.length) return { success: false, error: '范围内无有效聊天内容。' };
        const response = await generate(built.messages, options);
        if (!response.success) return response;
        const parsed = parseTraceResponse(response.text);
        const result = { success: true, kind: 'trace', parsed, preview: getTracePreview(parsed), text: response.text, range: built.range };
        return options.previewOnly ? result : commitTraceResult(state, result);
    }

    async function runSummary(state, options = {}) {
        const built = buildSummaryMessages(state, options);
        if (!built.range.messages.length) return { success: false, error: '范围内无有效聊天内容。' };
        const response = await generate(built.messages, options);
        if (!response.success) return response;
        const payload = normalizeSummaryPayload(parseJsonBlock(response.text));
        if (!payload.content) return { success: false, error: '总结结果缺少 content/总结内容。', text: response.text };
        const result = {
            success: true,
            kind: 'summary',
            payload,
            preview: getSummaryPreview(payload),
            text: response.text,
            range: built.range,
            meta: {
                autoTaskType: options.autoTaskType || '',
                range: { start: built.range.start, end: built.range.end },
            },
        };
        return options.previewOnly ? result : commitSummaryResult(state, result);
    }

    async function runTraceOptimize(state, options = {}) {
        const prompt = resolveTaskPromptVariables(compactLines([getActivePromptScheme(state)?.prompts?.traceOptimize, getDefaultOptimizePrompt('trace'), options.note]), state, options);
        const messages = [
            { role: 'system', content: prompt },
            { role: 'user', content: `【待优化表格】\n${tablesToReferenceText(state, options) || '（暂无）'}\n\n请按系统提示词要求输出优化后的结果。` },
        ];
        const response = await generate(messages, options);
        if (!response.success) return response;
        const parsed = parseTraceResponse(response.text);
        const result = { success: true, kind: 'trace', parsed, preview: getTracePreview(parsed), text: response.text };
        return options.previewOnly ? result : commitTraceResult(state, result);
    }

    async function runSummaryOptimize(state, options = {}) {
        const summaries = stateRecords(state, FIXED_SUMMARY_TABLE_ID).map((record) => recordToText(stateTables(state).find((table) => table.id === FIXED_SUMMARY_TABLE_ID), record)).filter(Boolean).join('\n');
        const prompt = resolveTaskPromptVariables(compactLines([getActivePromptScheme(state)?.prompts?.summaryOptimize, getDefaultOptimizePrompt('summary'), options.note]), state, options);
        const messages = [
            { role: 'system', content: prompt },
            { role: 'user', content: `【待优化总结】\n${summaries || '（暂无）'}\n\n请输出优化后的 JSON。` },
        ];
        const response = await generate(messages, options);
        if (!response.success) return response;
        const payload = normalizeSummaryPayload(parseJsonBlock(response.text));
        if (!payload.content) return { success: false, error: '优化结果缺少 content/总结内容。', text: response.text };
        const result = { success: true, kind: 'summary', payload, preview: getSummaryPreview(payload), text: response.text, meta: { autoTaskType: '' } };
        return options.previewOnly ? result : commitSummaryResult(state, result);
    }

    function getAutoSummarySettings() {
        const source = parseJsonStorage(AUTO_SUMMARY_SETTINGS_STORAGE_KEY, {});
        return {
            summaryEnabled: source.summaryEnabled !== false,
            summaryEvery: Math.max(1, Math.round(Number(source.summaryEvery) || 20)),
            historyEnabled: source.historyEnabled !== false,
            historyEvery: Math.max(1, Math.round(Number(source.historyEvery) || 100)),
            summaryDelay: Math.max(0, Math.round(Number(source.summaryDelay) || 2)),
            historyDelay: Math.max(0, Math.round(Number(source.historyDelay) || 3)),
            directTrigger: typeof source.directTrigger === 'boolean' ? source.directTrigger : true,
            autoSave: typeof source.autoSave === 'boolean' ? source.autoSave : true,
        };
    }

    function normalizePointers(state) {
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        const source = state.settings.manualPointers && typeof state.settings.manualPointers === 'object'
            ? state.settings.manualPointers
            : {};
        const pointers = {
            ...source,
            trace: Math.max(0, Math.round(Number(source.trace) || 0)),
            summary: Math.max(0, Math.round(Number(source.summary) || 0)),
            historySummary: Math.max(0, Math.round(Number(source.historySummary ?? source.bigSummary) || 0)),
        };
        state.settings.manualPointers = pointers;
        return pointers;
    }

    function buildAutoTask(type, pointers, chatLength, settings) {
        const isHistory = type === 'history';
        const enabled = isHistory ? settings.historyEnabled : settings.summaryEnabled;
        if (!enabled) return null;
        const pointerKey = isHistory ? 'historySummary' : 'summary';
        const lastIndex = Math.max(0, Number(pointers[pointerKey]) || 0);
        const interval = isHistory ? settings.historyEvery : settings.summaryEvery;
        const delay = isHistory ? settings.historyDelay : settings.summaryDelay;
        const threshold = interval + delay;
        if (chatLength - lastIndex < threshold) return null;
        return {
            type,
            pointerKey,
            title: isHistory ? '自动大总结' : '自动小总结',
            lastIndex,
            currentCount: chatLength,
            interval,
            delay,
            threshold,
            start: lastIndex,
            end: Math.min(lastIndex + interval, chatLength),
        };
    }

    async function confirmAutoTask(task, callbacks = {}) {
        if (settingsSupportsDirect(callbacks) && callbacks.confirmAutoTask) {
            return callbacks.confirmAutoTask(task);
        }
        if (typeof window.confirm !== 'function') return { action: 'confirm', postpone: 0 };
        const ok = window.confirm(`${task.title}已达到触发条件。\n当前楼层：${task.currentCount}\n上次指针：${task.lastIndex}\n触发阈值：${task.threshold}\n处理范围：${task.start}-${task.end}（不含${task.end}）\n\n是否执行？`);
        return { action: ok ? 'confirm' : 'cancel', postpone: 0 };
    }

    function settingsSupportsDirect(callbacks) {
        return callbacks && typeof callbacks.confirmAutoTask === 'function';
    }

    async function confirmTaskResult(result, task, callbacks = {}) {
        if (typeof callbacks.confirmTaskResult === 'function') {
            return callbacks.confirmTaskResult(result, task);
        }
        if (typeof window.confirm !== 'function') return true;
        return window.confirm(`${task?.title || '任务'}已生成结果，是否写入记忆？\n\n${String(result.preview || result.text || '').slice(0, 1000)}`);
    }

    async function runAutoSummaryTask(state, task, settings, callbacks = {}) {
        const shouldRun = settings.directTrigger ? { action: 'confirm', postpone: 0 } : await confirmAutoTask(task, callbacks);
        if (shouldRun?.action !== 'confirm') return { skipped: true };
        if (Number(shouldRun.postpone) > 0) {
            const pointers = normalizePointers(state);
            pointers[task.pointerKey] = Math.max(0, task.currentCount - task.threshold + Math.round(Number(shouldRun.postpone) || 0));
            callbacks.saveState?.();
            return { postponed: true };
        }

        const result = await runSummary(state, {
            start: task.start,
            end: task.end,
            silent: settings.autoSave,
            previewOnly: !settings.autoSave,
            autoTaskType: task.type,
        });
        if (!result.success) return result;

        let committed = result;
        if (!settings.autoSave) {
            const approved = await confirmTaskResult(result, task, callbacks);
            if (!approved) return { success: true, skipped: true, result };
            committed = commitSummaryResult(state, result);
        }

        const pointers = normalizePointers(state);
        pointers[task.pointerKey] = committed.range?.end || task.end;
        if (task.type === 'history' && pointers.summary < pointers.historySummary) pointers.summary = pointers.historySummary;
        if (task.type === 'history') {
            committed.cleanupCount = cleanupSmallAutoSummaries(state, { start: task.start, end: task.end }, committed.record?.id);
        }
        callbacks.saveState?.();
        callbacks.onUpdate?.(committed);
        return committed;
    }

    function scheduleAutoSummary(callbacks = {}) {
        window.clearTimeout(autoSummaryTimer);
        autoSummaryTimer = window.setTimeout(async () => {
            if (autoSummaryRunning || autoSummaryPromptOpen) return;
            const state = callbacks.getState?.();
            if (!state) return;
            const settings = getAutoSummarySettings();
            const chat = getContext()?.chat || [];
            const pointers = normalizePointers(state);
            const historyTask = buildAutoTask('history', pointers, chat.length, settings);
            const summaryTask = historyTask ? null : buildAutoTask('summary', pointers, chat.length, settings);
            const task = historyTask || summaryTask;
            if (!task) return;

            autoSummaryRunning = true;
            try {
                autoSummaryPromptOpen = !settings.directTrigger || !settings.autoSave;
                const result = await runAutoSummaryTask(state, task, settings, callbacks);
                if (result?.success === false) console.warn('[yuzuki-Memory] Auto summary skipped:', result.error);
            } catch (error) {
                console.warn('[yuzuki-Memory] Auto summary failed:', error);
            } finally {
                autoSummaryRunning = false;
                autoSummaryPromptOpen = false;
            }
        }, 800);
    }

    function bindAutoSummary(callbacks = {}) {
        if (autoSummaryBound) return;
        autoSummaryBound = true;
        const ctx = getContext();
        const eventSource = ctx?.eventSource;
        const eventTypes = ctx?.event_types;
        const handler = () => scheduleAutoSummary(callbacks);
        if (eventSource && eventTypes) {
            const events = [
                eventTypes.CHARACTER_MESSAGE_RENDERED,
                eventTypes.USER_MESSAGE_RENDERED,
                eventTypes.MESSAGE_RECEIVED,
                eventTypes.GENERATION_ENDED,
                eventTypes.CHAT_CHANGED,
            ].filter(Boolean);
            events.forEach((eventName) => eventSource.on?.(eventName, handler));
        }
        window.setInterval(handler, 15000);
    }

    YuzukiMemory.TaskRunner = Object.assign(YuzukiMemory.TaskRunner || {}, {
        filterContentByTags,
        runTrace,
        runSummary,
        runTraceOptimize,
        runSummaryOptimize,
        commitTraceResult,
        commitSummaryResult,
        bindAutoSummary,
    });
})();
