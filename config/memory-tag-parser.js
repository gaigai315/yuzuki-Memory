// ============================================================================
// yuzuki-Memory memory tag parser.
// Parses <Memory><!-- #表名 [主键]|字段：内容 --></Memory> from assistant
// replies and applies updates to plugin-owned memory tables.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const MEMORY_TAG_PATTERN = /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>([\s\S]*?)<\/\1>/gi;
    const COMMENT_PATTERN = /<!--|-->/g;
    const DEFAULT_STATE_REVISION = 13;
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const PLOT_SUMMARY_TABLE_ID = 'plot_summary';
    let bound = false;
    let applying = false;
    let bindRetryTimer = null;
    const processedSignatures = new Set();
    const processedSignatureQueue = [];
    const pendingTimers = {};

    const DEFAULT_TABLES = [
        { id: 'plot_summary', name: '剧情摘要', icon: 'timeline', columns: ['#主线', '#支线'] },
        { id: 'character_profile', name: '角色档案', icon: 'person', columns: ['角色名', '年龄', '性别', '身份', '性格', '当前位置', '周围角色', '生理', '人际关系', '着装', '待办事项', '约定'] },
        { id: 'item_tracking', name: '物品追踪', icon: 'item', columns: ['物品名称', '物品描述', '物品位置', '持有者', '状态', '备注'] },
        { id: 'world_setting', name: '世界设定', icon: 'world', columns: ['设定名', '类型', '详细说明', '影响范围'] },
        { id: 'memory_summary', name: '记忆总结', icon: 'memory_book', columns: ['总结标题', '核心角色', '楼层数', '总结内容', '未解决问题', '备注'] },
    ];

    function createDefaultState() {
        return {
            defaultRevision: DEFAULT_STATE_REVISION,
            tables: DEFAULT_TABLES.map((table) => ({
                id: table.id,
                name: table.name,
                icon: table.icon,
                columns: [...table.columns],
                hidden: false,
            })),
            activeTableId: 'character_profile',
            activeRecordIds: {},
            records: {
                memory_summary: [
                    { id: 'summary_main_default', values: { 总结标题: '主线总结', 核心角色: '', 楼层数: '', 总结内容: '', 未解决问题: '', 备注: '' } },
                    { id: 'summary_branch_default', values: { 总结标题: '支线总结', 核心角色: '', 楼层数: '', 总结内容: '', 未解决问题: '', 备注: '' } },
                ],
            },
            promptPresetId: '',
            settings: {},
        };
    }

    function getContext() {
        try {
            return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
        } catch (_error) {
            return null;
        }
    }

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^#/, '').trim();
    }

    function isAppendColumn(column) {
        return String(column || '').trim().startsWith('#');
    }

    function normalizeName(value) {
        return String(value || '')
            .normalize('NFKC')
            .replace(/^#/, '')
            .replace(/\s+/g, '')
            .trim()
            .toLowerCase();
    }

    function getPrimaryColumn(table) {
        return table?.columns?.[0] || '名称';
    }

    function getPrimaryColumnName(table) {
        return cleanColumnName(getPrimaryColumn(table));
    }

    function findTable(state, tableName) {
        const key = normalizeName(tableName);
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        return tables.find((table) => normalizeName(table.name) === key)
            || tables.find((table) => normalizeName(table.id) === key)
            || tables.find((table) => key && normalizeName(table.name).includes(key))
            || null;
    }

    function findColumn(table, fieldName) {
        const key = normalizeName(fieldName);
        return (Array.isArray(table?.columns) ? table.columns : []).find((column) => normalizeName(column) === key) || '';
    }

    function splitSegments(line) {
        return String(line || '')
            .split('|')
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function parseFieldSegment(segment) {
        const match = String(segment || '').match(/^([^:：]+)[:：]([\s\S]*)$/);
        if (!match) return null;
        return {
            field: match[1].trim(),
            value: match[2].trim(),
        };
    }

    function getPlotKind(value = '') {
        return /支线/.test(String(value || '')) ? 'branch' : (/主线/.test(String(value || '')) ? 'main' : '');
    }

    function isPlotTimeBracket(value = '') {
        const text = String(value || '').trim();
        return /(?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[:：]\d{2}/.test(text);
    }

    function normalizePlotField(field = '') {
        const key = normalizeName(field);
        if (key === '标题' || key === '名称' || key === '摘要名称') return '摘要名称';
        if (key === '日期' || key === '时间') return '日期';
        if (key === '内容' || key === '摘要内容' || key === '总结内容') return '摘要内容';
        return String(field || '').trim();
    }

    function parsePlotValues(source = '', fallbackTitle = '') {
        const values = {};
        if (fallbackTitle) values['摘要名称'] = fallbackTitle;
        splitSegments(String(source || '').replace(/^[|:：]\s*/, '')).forEach((segment) => {
            const parsed = parseFieldSegment(segment);
            if (!parsed || !parsed.field) return;
            values[normalizePlotField(parsed.field)] = parsed.value;
        });

        const loosePattern = /(摘要名称|标题|名称|日期|时间|摘要内容|总结内容|内容)\s*[:：]\s*([\s\S]*?)(?=(?:[|，,；;]\s*)?(?:摘要名称|标题|名称|日期|时间|摘要内容|总结内容|内容)\s*[:：]|$)/g;
        let match;
        while ((match = loosePattern.exec(String(source || ''))) !== null) {
            const field = normalizePlotField(match[1]);
            const value = String(match[2] || '').replace(/^[|，,；;\s]+|[|，,；;\s]+$/g, '').trim();
            if (value) values[field] = value;
        }
        return values;
    }

    function splitPlotSummaryEntries(source = '') {
        const text = String(source || '').trim();
        if (!text) return [];
        const entries = [];
        const pattern = /\[[^\]]+\]\s*\|\s*内容\s*[:：][\s\S]*?(?=(?:[;；]\s*)?\[[^\]]+\]\s*\|\s*内容\s*[:：]|$)/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const value = String(match[0] || '').replace(/^[;；]\s*/, '').trim();
            if (value) entries.push(value);
        }
        if (entries.length) return entries;
        return text.split(/[;；](?=\s*\[[^\]]+\]\s*\|)/).map((entry) => entry.trim()).filter(Boolean);
    }

    function expandPlotRows(kind, source = '', fallbackTitle = '') {
        const normalizedKind = kind === 'branch' ? 'branch' : 'main';
        const entries = splitPlotSummaryEntries(source);
        if (!entries.length) return [createPlotRow(normalizedKind, source, fallbackTitle)];
        const rows = [];
        let lastDate = '';
        entries.forEach((entry) => {
            const bracketMatch = entry.match(/^\[([^\]]+)\]\s*\|\s*(?:内容|摘要内容|总结内容)\s*[:：]\s*([\s\S]*)$/);
            if (!bracketMatch) {
                rows.push(createPlotRow(normalizedKind, entry, fallbackTitle));
                return;
            }
            const rawTime = bracketMatch[1].trim();
            const content = bracketMatch[2].trim();
            const dateMatch = rawTime.match(/(?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
            if (dateMatch) lastDate = dateMatch[0].replace(/\s+/g, '');
            const time = !dateMatch && lastDate ? `${lastDate},${rawTime}` : rawTime;
            rows.push(createPlotRow(normalizedKind, `日期:${time}|内容:${content}`, fallbackTitle));
        });
        return rows;
    }

    function createPlotRow(kind, source = '', fallbackTitle = '') {
        const normalizedKind = kind === 'branch' ? 'branch' : 'main';
        const values = parsePlotValues(source, fallbackTitle);
        if (!values['摘要内容'] && String(source || '').trim() && !Object.keys(values).length) {
            values['摘要内容'] = String(source || '').trim();
        }
        return {
            table: '剧情摘要',
            primaryValue: normalizedKind === 'branch' ? '支线摘要' : '主线摘要',
            values,
        };
    }

    function splitPlotTimeAndContent(text = '') {
        const source = String(text || '').trim();
        if (!source) return { time: '', content: '' };
        const pattern = /^(.+?(?:\d{1,2}[:：]\d{2})(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?)\s*[，,、:：\s]\s*([\s\S]+)$/;
        const match = source.match(pattern);
        if (!match) return { time: '', content: source };
        const time = match[1].replace(/：/g, ':').trim();
        const content = match[2].trim();
        return { time, content };
    }

    function parseMemoryText(text) {
        const cleanText = String(text || '').replace(COMMENT_PATTERN, '\n');
        const rows = [];
        let currentTable = '';
        let currentPlotKind = '';
        const knownTableNames = [
            '剧情摘要',
            '主线摘要',
            '支线摘要',
            '角色档案',
            '物品追踪',
            '世界设定',
            '记忆总结',
        ];
        const parseInlineTableLine = (line) => {
            const parts = splitSegments(line);
            if (parts.length < 2) return false;
            const tableToken = parts[0].replace(/^#+/, '').trim();
            const matchedTable = knownTableNames.find((name) => normalizeName(name) === normalizeName(tableToken));
            if (!matchedTable) return false;
            const keyPartIndex = parts.findIndex((part, index) => index > 0 && /^\[[^\]]+\]$/.test(part.trim()));
            if (keyPartIndex < 0) return false;
            const primaryValue = parts[keyPartIndex].trim().replace(/^\[|\]$/g, '').trim();
            const body = parts.slice(keyPartIndex + 1).join('|').trim().replace(/^内容\s*[:：]\s*/, '');
            const plotKind = getPlotKind(matchedTable) || getPlotKind(primaryValue);
            if (plotKind || normalizeName(matchedTable) === normalizeName('剧情摘要')) {
                rows.push(...expandPlotRows(plotKind || 'main', body, primaryValue));
                return true;
            }
            const values = {};
            splitSegments(body).forEach((segment) => {
                const parsed = parseFieldSegment(segment);
                if (!parsed || !parsed.field) return;
                const fieldName = parsed.field.replace(/^#/, '').trim();
                values[fieldName] = parsed.value;
            });
            rows.push({
                table: matchedTable,
                primaryValue,
                values,
            });
            return true;
        };
        cleanText.split(/\r?\n/).forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line) return;
            if (parseInlineTableLine(line)) return;
            if (line.startsWith('#')) {
                const plotHeaderMatch = line.match(/^#+\s*(主线摘要|支线摘要)([\s\S]*)$/);
                if (plotHeaderMatch) {
                    currentTable = '剧情摘要';
                    currentPlotKind = getPlotKind(plotHeaderMatch[1]);
                    const rest = String(plotHeaderMatch[2] || '').trim();
                    if (rest) rows.push(...expandPlotRows(currentPlotKind, rest));
                    return;
                }
                currentTable = line.replace(/^#+/, '').trim();
                currentPlotKind = getPlotKind(currentTable);
                return;
            }
            if (normalizeName(currentTable) === normalizeName('剧情摘要')) {
                const keyMatch = line.match(/^\[([^\]]+)\]\s*(?:\||$)([\s\S]*)$/);
                const bracketValue = keyMatch ? keyMatch[1].trim() : '';
                const bracketIsPlotTime = isPlotTimeBracket(bracketValue);
                const linePlotKind = !bracketIsPlotTime ? getPlotKind(bracketValue) : '';
                const targetKind = linePlotKind || currentPlotKind;
                if (targetKind) {
                    const source = keyMatch && !bracketIsPlotTime ? keyMatch[2] : line;
                    const fallbackTitle = keyMatch && !linePlotKind && !bracketIsPlotTime ? bracketValue : '';
                    rows.push(...expandPlotRows(targetKind, source, fallbackTitle));
                    return;
                }
            }
            const keyMatch = line.match(/^\[([^\]]+)\]\s*(?:\||$)([\s\S]*)$/);
            if (!keyMatch || !currentTable) return;
            const primaryValue = keyMatch[1].trim();
            const values = {};
            splitSegments(keyMatch[2]).forEach((segment) => {
                const parsed = parseFieldSegment(segment);
                if (!parsed || !parsed.field) return;
                const fieldName = parsed.field.replace(/^#/, '').trim();
                values[fieldName] = parsed.value;
            });
            rows.push({
                table: currentTable,
                primaryValue,
                values,
            });
        });
        return rows;
    }

    function extractMemoryRows(text) {
        const rows = [];
        let match;
        MEMORY_TAG_PATTERN.lastIndex = 0;
        while ((match = MEMORY_TAG_PATTERN.exec(String(text || ''))) !== null) {
            rows.push(...parseMemoryText(match[2]));
        }
        return rows;
    }

    function createRecord(table, values = {}) {
        return {
            id: `record_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            hidden: false,
            values: Object.fromEntries((table?.columns || []).map((column) => [cleanColumnName(column), String(values[cleanColumnName(column)] ?? '')])),
        };
    }

    function appendCellValue(current, next) {
        const currentText = String(current || '').trim();
        const nextText = String(next || '').trim();
        if (!nextText) return currentText;
        if (!currentText) return nextText;
        return `${currentText}；${nextText}`;
    }

    function appendMultilineValue(current, next) {
        const currentText = String(current || '').trim();
        const nextText = String(next || '').trim();
        if (!nextText) return currentText;
        if (!currentText) return nextText;
        return `${currentText}\n${nextText}`;
    }

    function getPlotDateFromTimeText(timeText = '') {
        const normalized = String(timeText || '').trim();
        if (!normalized) return '';
        const match = normalized.match(/(?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
        return match ? match[0].replace(/\s+/g, '') : '';
    }

    function getPlotClockSortValue(timeText = '') {
        const match = String(timeText || '').match(/(\d{1,2})[:：](\d{2})/);
        if (!match) return 999999;
        return Number(match[1]) * 60 + Number(match[2]);
    }

    function movePlotDatePrefixFromContent(time = '', content = '') {
        const normalizedTime = String(time || '').trim();
        let normalizedContent = String(content || '').trim();
        if (getPlotDateFromTimeText(normalizedTime) || !normalizedContent) {
            return { time: normalizedTime, content: normalizedContent };
        }
        const date = getPlotDateFromTimeText(normalizedContent);
        if (!date) return { time: normalizedTime, content: normalizedContent };
        const contentClocks = [...normalizedContent.matchAll(/\d{1,2}[:：]\d{2}/g)].map((match) => match[0].replace('：', ':'));
        const contentTimeRange = contentClocks.length
            ? `${contentClocks[0]}${contentClocks[1] ? `-${contentClocks[1]}` : ''}`
            : '';
        normalizedContent = normalizedContent
            .replace(new RegExp(`^\\s*${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[，,、:：\\s-]*`), '')
            .replace(/^\d{1,2}[:：]\d{2}(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?\s*[，,、:：\s-]*/, '')
            .trim();
        return {
            time: normalizedTime ? `${date},${normalizedTime}` : (contentTimeRange ? `${date},${contentTimeRange}` : date),
            content: normalizedContent,
        };
    }

    function normalizePlotStoredLines(lines = []) {
        let lastDate = '';
        const items = lines
            .map((line, index) => {
                const parsed = splitPlotTimeAndContent(line);
                const text = parsed.time ? `${parsed.time}\t${parsed.content}` : String(line || '').trim();
                const tabIndex = text.indexOf('\t');
                const fixed = movePlotDatePrefixFromContent(
                    (tabIndex > -1 ? text.slice(0, tabIndex) : '').replace(/：/g, ':').trim(),
                    (tabIndex > -1 ? text.slice(tabIndex + 1) : text).trim()
                );
                if (!fixed.time || !fixed.content) return null;
                const date = getPlotDateFromTimeText(fixed.time) || lastDate;
                if (date) lastDate = date;
                const fullTime = getPlotDateFromTimeText(fixed.time) ? fixed.time : (date ? `${date},${fixed.time}` : fixed.time);
                return {
                    raw: `${fullTime}\t${fixed.content}`,
                    date: getPlotDateFromTimeText(fullTime) || '',
                    sort: getPlotClockSortValue(fullTime),
                    content: fixed.content,
                    index,
                };
            })
            .filter(Boolean);
        const seen = new Set();
        return items
            .filter((item) => {
                const key = `${item.date}|${item.sort}|${item.content}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => String(a.date).localeCompare(String(b.date), 'zh-Hans-CN', { numeric: true }) || a.sort - b.sort || a.index - b.index)
            .map((item) => item.raw)
            .join('\n');
    }

    function plotRowToText(row) {
        const values = row?.values || {};
        let title = String(values['摘要名称'] || values['标题'] || '').trim();
        if (/^(主线|支线)摘要$/.test(title)) title = '';
        let date = String(values['日期'] || values['时间'] || '').replace(/：/g, ':').trim();
        let content = String(values['摘要内容'] || values['内容'] || values['总结内容'] || '').trim();
        if (!date && content) {
            const parsed = splitPlotTimeAndContent(content);
            date = parsed.time;
            content = parsed.content;
        }
        const fixed = movePlotDatePrefixFromContent(date, content);
        date = fixed.time;
        content = fixed.content;
        const body = [title, content].filter(Boolean).join('：');
        return [date, body].filter(Boolean).join('\t').trim();
    }

    function applyMemoryRow(state, row) {
        const table = findTable(state, row.table);
        if (!table || table.id === FIXED_SUMMARY_TABLE_ID) return false;

        if (table.id === PLOT_SUMMARY_TABLE_ID) {
            const field = getPlotKind(row.primaryValue) === 'branch' ? '支线' : '主线';
            const text = plotRowToText(row);
            if (!text) return false;
            state.records = state.records && typeof state.records === 'object' ? state.records : {};
            state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
            let record = state.records[table.id][0];
            if (!record) {
                record = createRecord(table, {});
                state.records[table.id].push(record);
            }
            record.values = record.values && typeof record.values === 'object' ? record.values : {};
            record.values[field] = normalizePlotStoredLines([
                ...String(record.values[field] || '').split(/\n+/).map((line) => line.trim()).filter(Boolean),
                text,
            ]);
            return true;
        }

        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        const records = state.records[table.id];
        const primaryName = getPrimaryColumnName(table);
        const primaryValue = String(row.primaryValue || '').trim();
        if (!primaryValue) return false;
        const validUpdates = Object.entries(row.values || {})
            .map(([field, value]) => {
                const column = findColumn(table, field);
                if (!column) return null;
                const nextValue = String(value || '').trim();
                if (!nextValue) return null;
                return { column, value: nextValue };
            })
            .filter(Boolean);
        if (!validUpdates.length) return false;

        let record = records.find((entry) => String(entry?.values?.[primaryName] || '').trim() === primaryValue);
        if (!record) {
            record = createRecord(table, { [primaryName]: primaryValue });
            records.push(record);
        }
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        record.values[primaryName] = primaryValue;

        validUpdates.forEach(({ column, value }) => {
            const columnName = cleanColumnName(column);
            const shouldAppend = isAppendColumn(column);
            record.values[columnName] = shouldAppend
                ? appendCellValue(record.values[columnName], value)
                : value;
        });
        return true;
    }

    function applyRowsToState(state, rows = []) {
        let count = 0;
        (Array.isArray(rows) ? rows : []).forEach((row) => {
            if (applyMemoryRow(state, row)) count += 1;
        });
        return count;
    }

    function getRecordCounts(state) {
        const records = state?.records && typeof state.records === 'object' ? state.records : {};
        return Object.fromEntries(Object.entries(records).map(([tableId, tableRecords]) => [
            tableId,
            Array.isArray(tableRecords) ? tableRecords.length : 0,
        ]));
    }

    function applyMemoryText(text, options = {}) {
        const rows = extractMemoryRows(text);
        const hasMemoryTag = MEMORY_TAG_PATTERN.test(String(text || ''));
        MEMORY_TAG_PATTERN.lastIndex = 0;
        if (!rows.length || applying) {
            console.info('[yuzuki-Memory Realtime] apply skipped', {
                floor: options.floor,
                textLength: String(text || '').length,
                hasMemoryTag,
                rows: rows.length,
                applying,
            });
            return { success: false, count: 0 };
        }
        const state = YuzukiMemory.Storage?.loadState?.(createDefaultState()) || createDefaultState();
        const chat = getContext()?.chat;
        const floor = Number.isFinite(Number(options.floor))
            ? Math.round(Number(options.floor))
            : (Array.isArray(chat) ? chat.length - 1 : -1);
        YuzukiMemory.BranchSnapshot?.captureBaseSnapshotBeforeMessage?.(floor, { state });
        let count = 0;
        applying = true;
        try {
            count = applyRowsToState(state, rows);
            if (count) {
                const saved = YuzukiMemory.Storage?.saveState?.(state, createDefaultState(), undefined, {
                    allowDuringSwitch: true,
                    force: true,
                    saveOrigin: 'auto',
                });
                const storedState = YuzukiMemory.Storage?.loadState?.(createDefaultState());
                console.info('[yuzuki-Memory Realtime] memory rows applied', {
                    floor,
                    rows: rows.length,
                    applied: count,
                    saved: !!saved,
                    stateCounts: getRecordCounts(state),
                    storedCounts: getRecordCounts(storedState),
                });
                if (!saved) {
                    console.warn('[yuzuki-Memory Realtime] save failed after applying memory rows', {
                        floor,
                        rows: rows.length,
                        applied: count,
                    });
                    return { success: false, count: 0, saveFailed: true };
                }
                YuzukiMemory.BranchSnapshot?.captureMessageSnapshot?.(floor, { state });
                if (options.dispatch !== false) {
                    window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', { detail: { source: 'memory-tag-parser', count } }));
                }
            } else {
                console.info('[yuzuki-Memory Realtime] parsed rows but nothing applied', {
                    floor,
                    rows: rows.length,
                });
            }
            return { success: count > 0, count };
        } finally {
            applying = false;
        }
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        const swipeId = Number(message.swipe_id ?? 0);
        const primary = String(message.mes || message.content || message.text || '');
        if (primary) return primary;
        if (Array.isArray(message.swipes) && message.swipes.length > swipeId) return String(message.swipes[swipeId] || '');
        return '';
    }

    function isAssistantMessage(message) {
        return !!message && (message.is_user === false || message.role === 'assistant') && !message.is_system;
    }

    function getTextSignature(text = '') {
        const source = String(text || '');
        let hash = 0;
        for (let index = 0; index < source.length; index += 1) {
            hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
        }
        return `${source.length}:${hash}`;
    }

    function hasProcessedText(text = '') {
        const signature = getTextSignature(text);
        if (processedSignatures.has(signature)) return true;
        processedSignatures.add(signature);
        processedSignatureQueue.push(signature);
        while (processedSignatureQueue.length > 50) {
            processedSignatures.delete(processedSignatureQueue.shift());
        }
        return false;
    }

    function getMessageProcessSignature(message) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = Number(message.swipe_id ?? 0);
        const swipesLength = Array.isArray(message.swipes) ? message.swipes.length : 0;
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            swipeId,
            swipesLength,
            getTextSignature(getMessageText(message)),
            String(extra.gen_id ?? extra.generation_id ?? extra.swipe_generation_id ?? ''),
            String(message.send_date ?? message.gen_started ?? extra.send_date ?? ''),
        ].join('|');
    }

    function shouldSkipMessage(floor, message, options = {}) {
        if (options.force === true) return false;
        const snapshot = YuzukiMemory.BranchSnapshot?.getProcessedMessageSignature?.(floor);
        const signature = getMessageProcessSignature(message);
        if (!signature) return false;
        if (snapshot === signature) return true;
        return false;
    }

    function processMessage(floor, options = {}) {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) return;
        const rawFloor = Number(floor);
        const target = Number.isFinite(rawFloor) && rawFloor >= 0 ? Math.round(rawFloor) : chat.length - 1;
        const message = chat[target];
        if (!isAssistantMessage(message)) return;
        if (shouldSkipMessage(target, message, options)) return;
        const shouldRollbackBeforeApply = options.rollbackBeforeApply === true
            || YuzukiMemory.BranchSnapshot?.consumeApplyRollbackFloor?.(target) === true;
        if (shouldRollbackBeforeApply && YuzukiMemory.BranchSnapshot?.isRealtimeEnabled?.()) {
            YuzukiMemory.BranchSnapshot?.rollbackBeforeMessage?.(target, { force: options.force === true });
        }
        const text = getMessageText(message);
        console.info('[yuzuki-Memory Realtime] process message', {
            floor: target,
            textLength: text.length,
            hasMemoryTag: /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>[\s\S]*?<\/\1>/i.test(text),
            hasMes: typeof message?.mes === 'string' && message.mes.length > 0,
            swipesLength: Array.isArray(message?.swipes) ? message.swipes.length : 0,
            swipeId: Number(message?.swipe_id ?? 0),
        });
        const result = applyMemoryText(text, { floor: target, force: options.force === true });
        if (result?.success) {
            YuzukiMemory.BranchSnapshot?.setProcessedMessageSignature?.(target, getMessageProcessSignature(message));
        }
    }

    function scheduleProcessMessage(floor, options = {}) {
        const rawFloor = Number(floor);
        const key = String(Number.isFinite(rawFloor) && rawFloor >= 0 ? Math.round(rawFloor) : 'latest');
        window.clearTimeout(pendingTimers[key]);
        pendingTimers[key] = window.setTimeout(() => {
            delete pendingTimers[key];
            processMessage(floor, options);
        }, Math.max(0, Math.round(Number(options.delay) || 500)));
    }

    function clearPendingMessage(floor) {
        const rawFloor = Number(floor);
        const key = String(Number.isFinite(rawFloor) && rawFloor >= 0 ? Math.round(rawFloor) : 'latest');
        window.clearTimeout(pendingTimers[key]);
        delete pendingTimers[key];
    }

    function bind() {
        if (bound) return;
        const ctx = getContext();
        const eventSource = ctx?.eventSource || window.eventSource;
        const eventTypes = ctx?.event_types || window.event_types;
        if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
            window.clearTimeout(bindRetryTimer);
            bindRetryTimer = window.setTimeout(bind, 1000);
            return;
        }
        const latestHandler = () => scheduleProcessMessage(-1);
        const renderedHandler = (id) => scheduleProcessMessage(id);
        [
            [eventTypes?.CHARACTER_MESSAGE_RENDERED, renderedHandler],
            [eventTypes?.MESSAGE_RECEIVED, latestHandler],
            [eventTypes?.GENERATION_ENDED, latestHandler],
        ].filter(([eventName]) => Boolean(eventName)).forEach(([eventName, handler]) => {
            if (typeof eventSource?.on === 'function') eventSource.on(eventName, handler);
        });
        bound = true;
        window.clearTimeout(bindRetryTimer);
    }

    YuzukiMemory.MemoryTagParser = Object.assign(YuzukiMemory.MemoryTagParser || {}, {
        bind,
        createDefaultState,
        extractMemoryRows,
        parseMemoryText,
        applyMemoryText,
        processMessage,
        clearPendingMessage,
        applyRowsToState,
        cleanColumnName,
        isAppendColumn,
    });

    bind();
})();
