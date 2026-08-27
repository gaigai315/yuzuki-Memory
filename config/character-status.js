// ============================================================================
// yuzuki-Memory character status structure helpers.
// Keeps AI-updatable status columns consistent across prompt and write paths.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const TABLE_ID = 'character_status';
    const ATTRIBUTE_NAMES = new Set(['力量', '敏捷', '智力', '魅力', '幸运']);
    const TRANSACTION_PATTERN = /(奇遇|剧情|事务|规划|计划|事件|线索|目标|走向)/;
    const HEADER_PATTERN = /(住址|地址|住所|居所|驻地)/;
    const OVERVIEW_PATTERN = /(好感|亲密|疲劳|体力|生命|法力|魔力|理智|心情|饥饿|压力|健康|状态)/;
    const GROWTH_COMPLETION_TAG_PATTERN = /<角色任务完成>([\s\S]*?)<\/角色任务完成>/gi;

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^[#*]+/, '').trim();
    }

    function normalizeColumnKey(column) {
        return cleanColumnName(column).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    }

    function getBreaks(table, columnCount = table?.columns?.length || 0) {
        const rawBreaks = Array.isArray(table?.characterStatusBreaks)
            ? table.characterStatusBreaks.map(Number)
            : [];
        const breaks = rawBreaks.length === 2 ? [1, ...rawBreaks] : rawBreaks;
        if (breaks.length !== 3 || !breaks.every(Number.isInteger)) return null;
        const [headerEnd, overviewEnd, attributeEnd] = breaks;
        if (headerEnd < 1 || overviewEnd < headerEnd || attributeEnd < overviewEnd || attributeEnd > columnCount) return null;
        return [headerEnd, overviewEnd, attributeEnd];
    }

    function inferLayout(table) {
        const definitions = (Array.isArray(table?.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter(Boolean);
        const primaryColumn = definitions[0] || '';
        const columns = definitions.slice(1).filter((column, index, items) => items.indexOf(column) === index);
        const headerColumns = columns.filter((column) => HEADER_PATTERN.test(column)).slice(0, 3);
        const transactionColumns = columns.filter((column) => !headerColumns.includes(column) && TRANSACTION_PATTERN.test(column));
        const overviewColumns = columns.filter((column) => (
            !headerColumns.includes(column)
            && !transactionColumns.includes(column)
            && !ATTRIBUTE_NAMES.has(column)
            && (OVERVIEW_PATTERN.test(column) || /(度|值|率)$/.test(column))
        ));
        const attributeColumns = columns.filter((column) => (
            !headerColumns.includes(column)
            && !transactionColumns.includes(column)
            && !overviewColumns.includes(column)
        ));
        return { primaryColumn, headerColumns, overviewColumns, attributeColumns, transactionColumns };
    }

    function getColumnLayout(table) {
        const definitions = (Array.isArray(table?.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter(Boolean);
        const primaryColumn = definitions[0] || '';
        const breaks = getBreaks(table, definitions.length);
        if (!breaks) return inferLayout(table);
        const [headerEnd, overviewEnd, attributeEnd] = breaks;
        return {
            primaryColumn,
            headerColumns: definitions.slice(1, headerEnd).slice(0, 3),
            overviewColumns: definitions.slice(headerEnd, overviewEnd),
            attributeColumns: definitions.slice(overviewEnd, attributeEnd),
            transactionColumns: definitions.slice(attributeEnd),
        };
    }

    function getAiUpdateColumns(table) {
        if (table?.id !== TABLE_ID) {
            return (Array.isArray(table?.columns) ? table.columns : []).map(cleanColumnName).filter(Boolean);
        }
        // This limits schema/writeback only; character-status records stay fully injected as context.
        const layout = getColumnLayout(table);
        return [layout.primaryColumn, ...layout.headerColumns, ...layout.overviewColumns].filter(Boolean);
    }

    function filterAiUpdateValues(table, values = {}) {
        if (table?.id !== TABLE_ID || !values || typeof values !== 'object') return values;
        const allowedColumns = getAiUpdateColumns(table);
        const allowedByKey = new Map(allowedColumns.map((column) => [normalizeColumnKey(column), column]));
        return Object.fromEntries(Object.entries(values).map(([field, value]) => {
            const column = allowedByKey.get(normalizeColumnKey(field));
            return column ? [column, value] : null;
        }).filter(Boolean));
    }

    function findLayoutColumn(columns, value) {
        const key = normalizeColumnKey(value);
        if (!key) return '';
        return (Array.isArray(columns) ? columns : []).find((column) => normalizeColumnKey(column) === key) || '';
    }

    function parseGrowthTaskReward(table, taskText) {
        if (table?.id !== TABLE_ID) return null;
        const text = String(taskText || '').trim();
        if (!text) return null;
        const rewardMatch = text.match(/奖励\s*[:：]\s*([^；;\n]+?)\s*[+＋]\s*(\d+(?:\.\d+)?)(?=\s*(?:[；;\n]|$))/);
        if (!rewardMatch) return null;
        const layout = getColumnLayout(table);
        const attribute = findLayoutColumn(layout.attributeColumns, rewardMatch[1]);
        const increase = Number(rewardMatch[2]);
        if (!attribute || !Number.isFinite(increase) || increase <= 0) return null;
        const titleMatch = text.match(/^〔([^〕]+)〕/);
        const content = text.slice(titleMatch?.[0]?.length || 0).trim();
        const completionMatch = content.match(/(?:^|[；;])\s*完成条件\s*[:：]\s*([^；;\n]+)(?=\s*(?:[；;]|$))/);
        const description = content
            .replace(completionMatch?.[0] || '', '')
            .replace(rewardMatch[0], '')
            .replace(/^[\s；;]+|[\s；;]+$/g, '')
            .trim();
        return {
            text,
            title: String(titleMatch?.[1] || '成长任务').trim(),
            description,
            completion: String(completionMatch?.[1] || '').trim(),
            attribute,
            increase,
        };
    }

    function getTransactionItems(table, record) {
        if (table?.id !== TABLE_ID || !record) return [];
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const layout = getColumnLayout(table);
        return layout.transactionColumns.flatMap((column) => {
            const value = String(values[column] ?? values[cleanColumnName(column)] ?? '').trim();
            return value.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean).map((text, index) => {
                const growthTask = parseGrowthTaskReward(table, text);
                const titleMatch = text.match(/^〔([^〕]+)〕/);
                const description = text.slice(titleMatch?.[0]?.length || 0).trim();
                return {
                    id: `${normalizeColumnKey(column)}_${index}`,
                    column,
                    text,
                    title: growthTask?.title || String(titleMatch?.[1] || column).trim(),
                    description: growthTask?.description || description || text,
                    growthTask,
                };
            });
        });
    }

    function getCharacterDisplayName(value) {
        return YuzukiMemory.CharacterNameMatcher?.getDisplayName?.(value)
            || String(value || '').trim();
    }

    function parseGrowthTaskCompletionTags(text) {
        const updates = [];
        const pattern = new RegExp(GROWTH_COMPLETION_TAG_PATTERN.source, 'gi');
        let tagMatch;
        while ((tagMatch = pattern.exec(String(text || ''))) !== null) {
            const body = String(tagMatch[1] || '').replace(/<!--|-->/g, '').trim();
            body.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
                let characterName = '';
                let transactionColumn = '';
                let taskTitle = '';
                try {
                    const parsed = JSON.parse(line.replace(/^\s*[-•]\s*/, ''));
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        characterName = String(parsed.角色 ?? parsed.角色名 ?? parsed.character ?? '').trim();
                        transactionColumn = String(parsed.事务 ?? parsed.事务字段 ?? parsed.column ?? '').trim();
                        taskTitle = String(parsed.任务 ?? parsed.任务名称 ?? parsed.task ?? '').trim();
                    }
                } catch (_error) {
                    const named = line.match(/^角色(?:名)?\s*[:：]\s*(.+?)\s*[｜|]\s*事务(?:字段)?\s*[:：]\s*(.+?)\s*[｜|]\s*任务(?:名称)?\s*[:：]\s*(.+)$/);
                    const plain = named ? null : line.match(/^(.+?)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$/);
                    characterName = String(named?.[1] ?? plain?.[1] ?? '').trim();
                    transactionColumn = String(named?.[2] ?? plain?.[2] ?? '').trim();
                    taskTitle = String(named?.[3] ?? plain?.[3] ?? '').trim();
                }
                if (characterName && transactionColumn && taskTitle) {
                    updates.push({ characterName, transactionColumn, taskTitle });
                }
            });
        }
        const seen = new Set();
        return updates.filter((update) => {
            const key = [
                YuzukiMemory.CharacterNameMatcher?.normalizeName?.(update.characterName) || update.characterName,
                normalizeColumnKey(update.transactionColumn),
                update.taskTitle,
            ].join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function applyGrowthTaskCompletionUpdates(state, updates = []) {
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry?.id === TABLE_ID);
        const records = Array.isArray(state?.records?.[TABLE_ID]) ? state.records[TABLE_ID] : [];
        const completions = [];
        const ignored = [];
        if (!table) return { completions, ignored: (Array.isArray(updates) ? updates : []).map((update) => ({ update, reason: 'missing_table' })) };
        const primary = getColumnLayout(table).primaryColumn;

        (Array.isArray(updates) ? updates : []).forEach((update) => {
            const record = YuzukiMemory.CharacterNameMatcher?.findMatchingRecord
                ? YuzukiMemory.CharacterNameMatcher.findMatchingRecord(records, primary, update?.characterName)
                : records.find((entry) => String(entry?.values?.[primary] || '').trim() === String(update?.characterName || '').trim());
            if (!record || record.hidden) {
                ignored.push({ update, reason: 'character_not_found' });
                return;
            }
            const layout = getColumnLayout(table);
            const transactionColumn = findLayoutColumn(layout.transactionColumns, update?.transactionColumn);
            if (!transactionColumn) {
                ignored.push({ update, reason: 'transaction_not_found' });
                return;
            }
            const matches = getTransactionItems(table, record).filter((item) => (
                normalizeColumnKey(item.column) === normalizeColumnKey(transactionColumn)
                && item.growthTask
                && item.growthTask.title === String(update?.taskTitle || '').trim()
            ));
            if (matches.length !== 1) {
                ignored.push({ update, reason: matches.length ? 'ambiguous_task' : 'task_not_found' });
                return;
            }
            const completed = completeGrowthTask(state, {
                tableId: table.id,
                recordId: record.id,
                column: transactionColumn,
                taskText: matches[0].text,
            });
            if (!completed.success) {
                ignored.push({ update, reason: completed.error || 'completion_failed' });
                return;
            }
            completions.push({
                ...completed,
                characterName: getCharacterDisplayName(record?.values?.[primary]),
                recordId: String(record.id || ''),
            });
        });
        return { completions, ignored };
    }

    function applyGrowthTaskCompletionText(state, text) {
        const updates = parseGrowthTaskCompletionTags(text);
        return {
            updates,
            ...applyGrowthTaskCompletionUpdates(state, updates),
        };
    }

    function parseNumericAttribute(value) {
        const text = String(value ?? '').trim();
        if (!text || /^[-—–]+$/.test(text)) return { success: true, value: 0 };
        if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
            return { success: false, error: `基础属性当前值“${text}”不是纯数字，无法自动结算。` };
        }
        const number = Number(text);
        return Number.isFinite(number)
            ? { success: true, value: number }
            : { success: false, error: '基础属性当前值无效，无法自动结算。' };
    }

    function formatAttributeNumber(value) {
        const normalized = Math.round(Number(value) * 1000000) / 1000000;
        return Number.isInteger(normalized) ? String(normalized) : String(normalized);
    }

    function completeGrowthTask(state, options = {}) {
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const table = tables.find((entry) => entry?.id === String(options.tableId || TABLE_ID));
        const records = Array.isArray(state?.records?.[table?.id]) ? state.records[table.id] : [];
        const record = records.find((entry) => String(entry?.id || '') === String(options.recordId || ''));
        if (!table || !record) return { success: false, error: '角色状态记录已变化，请重新操作。' };

        const layout = getColumnLayout(table);
        const transactionColumn = findLayoutColumn(layout.transactionColumns, options.column);
        if (!transactionColumn) return { success: false, error: '未找到任务所在的事务字段。' };
        const taskText = String(options.taskText || '').trim();
        const reward = parseGrowthTaskReward(table, taskText);
        if (!reward) return { success: false, error: '该任务没有可识别的基础属性奖励。' };

        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        const lines = String(record.values[transactionColumn] || '')
            .split(/\r?\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
        const taskIndex = lines.findIndex((line) => line === taskText);
        if (taskIndex < 0) return { success: false, error: '该任务已被修改或清理，请刷新后重试。' };

        const current = parseNumericAttribute(record.values[reward.attribute]);
        if (!current.success) return current;
        const nextValue = formatAttributeNumber(current.value + reward.increase);
        lines.splice(taskIndex, 1);
        record.values[reward.attribute] = nextValue;
        record.values[transactionColumn] = lines.join('\n');
        return {
            success: true,
            record,
            title: reward.title,
            attribute: reward.attribute,
            increase: reward.increase,
            previousValue: String(current.value),
            nextValue,
            transactionColumn,
        };
    }

    YuzukiMemory.CharacterStatus = Object.assign(YuzukiMemory.CharacterStatus || {}, {
        TABLE_ID,
        cleanColumnName,
        normalizeColumnKey,
        getBreaks,
        getColumnLayout,
        getAiUpdateColumns,
        filterAiUpdateValues,
        parseGrowthTaskReward,
        getTransactionItems,
        parseGrowthTaskCompletionTags,
        applyGrowthTaskCompletionUpdates,
        applyGrowthTaskCompletionText,
        completeGrowthTask,
    });
})();
