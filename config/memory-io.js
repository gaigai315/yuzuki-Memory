(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const FORMAT = 'yuzuki-memory-table-backup';
    const VERSION = 2;

    function clone(value) {
        return JSON.parse(JSON.stringify(value ?? null));
    }

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^[#*]+/, '').trim();
    }

    function normalizeColumnDefinition(column) {
        const value = String(column || '').trim();
        if (!value) return '';
        const match = value.match(/^([#*]+)\s*(.*)$/);
        if (!match) return value;
        const modifiers = Array.from(new Set(match[1].split(''))).join('');
        const name = match[2].trim();
        return name ? `${modifiers}${name}` : '';
    }

    function uniqueColumns(columns) {
        const seen = new Set();
        return (Array.isArray(columns) ? columns : [])
            .map(normalizeColumnDefinition)
            .filter(Boolean)
            .filter((column) => {
                const key = cleanColumnName(column);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function sanitizeId(value, fallback = 'table') {
        const text = String(value || '').trim()
            .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return text || fallback;
    }

    function uniqueId(base, usedIds) {
        let id = sanitizeId(base);
        let index = 2;
        while (usedIds.has(id)) {
            id = `${sanitizeId(base)}_${index}`;
            index += 1;
        }
        usedIds.add(id);
        return id;
    }

    function createRecordId(tableId, rowIndex = 0) {
        return `${sanitizeId(tableId, 'table')}_${Date.now()}_${rowIndex}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeRecordValues(values, columns) {
        const source = values && typeof values === 'object' ? values : {};
        return Object.fromEntries((columns || []).map((column) => {
            const name = cleanColumnName(column);
            return [name, String(source[name] ?? source[column] ?? '')];
        }));
    }

    function getStorage() {
        return YuzukiMemory.Storage;
    }

    function isFloorScopedTable(tableId) {
        return tableId === 'memory_summary' || tableId === 'plot_summary';
    }

    function normalizeFloorScope(scope, fallback = null) {
        return getStorage()?.normalizeFloorScope?.(scope, fallback) || scope || fallback || null;
    }

    function getCurrentFloorScope(state = {}) {
        return normalizeFloorScope(
            state?.currentFloorScope,
            getStorage()?.getCurrentFloorScope?.(state?.sessionId)
        );
    }

    function formatImportScopeTime(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) return '历史导入';
        const pad = (part) => String(part).padStart(2, '0');
        return `导入于${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function getImportFloorScope(raw = {}, currentState = {}) {
        const explicit = normalizeFloorScope(raw?.sourceScope || raw?.floorScope);
        if (explicit) return explicit;
        const exportedAt = String(raw?.exportedAt || raw?.t || '').trim();
        const seed = exportedAt || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return getStorage()?.createFloorScope?.(`import:${seed}`, {
            label: formatImportScopeTime(exportedAt),
            kind: 'import',
        }) || {
            id: `import:${seed}`,
            label: formatImportScopeTime(exportedAt),
            kind: 'import',
        };
    }

    function normalizeRecord(record, tableId, columns, rowIndex = 0, floorScope = null) {
        const sourceValues = record?.values && typeof record.values === 'object' ? record.values : record;
        const normalized = {
            ...(record && typeof record === 'object' ? clone(record) : {}),
            id: String(record?.id || createRecordId(tableId, rowIndex)),
            hidden: !!record?.hidden,
            values: normalizeRecordValues(sourceValues, columns),
        };
        return isFloorScopedTable(tableId)
            ? (getStorage()?.ensureRecordFloorScope?.(normalized, floorScope) || normalized)
            : normalized;
    }

    function normalizeDirectBackup(raw, currentState = {}) {
        const tables = Array.isArray(raw?.tables) ? raw.tables : [];
        const importFloorScope = getImportFloorScope(raw, currentState);
        const usedIds = new Set();
        const normalizedTables = tables.map((table, index) => {
            const id = uniqueId(table?.id || table?.name || `table_${index + 1}`, usedIds);
            return {
                id,
                name: String(table?.name || `未命名表${index + 1}`),
                icon: String(table?.icon || (id === 'memory_summary' ? 'memory_book' : 'note')),
                columns: uniqueColumns(table?.columns).length ? uniqueColumns(table.columns) : ['名称', '内容'],
                hidden: !!table?.hidden,
            };
        });
        const idMap = new Map(tables.map((table, index) => [String(table?.id || ''), normalizedTables[index]?.id]));
        const records = {};
        normalizedTables.forEach((table, index) => {
            const originalId = String(tables[index]?.id || '');
            const rawRecords = Array.isArray(raw?.records?.[originalId])
                ? raw.records[originalId]
                : (Array.isArray(raw?.records?.[table.id]) ? raw.records[table.id] : []);
            records[table.id] = rawRecords.map((record, rowIndex) => normalizeRecord(record, table.id, table.columns, rowIndex, importFloorScope));
        });
        const activeRecordIds = {};
        Object.entries(raw?.activeRecordIds || {}).forEach(([tableId, recordId]) => {
            const nextTableId = idMap.get(String(tableId)) || tableId;
            if (records[nextTableId]?.some((record) => record.id === recordId)) activeRecordIds[nextTableId] = recordId;
        });
        return {
            tables: normalizedTables,
            records,
            activeTableId: idMap.get(String(raw?.activeTableId || '')) || normalizedTables[0]?.id || '',
            activeRecordIds,
            sourceScope: importFloorScope,
        };
    }

    function legacySheetToTable(sheet, index, usedIds, currentTables = []) {
        const name = String(sheet?.n || sheet?.name || `表格${index + 1}`).trim() || `表格${index + 1}`;
        const matched = currentTables.find((table) => String(table?.name || '').trim() === name);
        const isSummary = name === '记忆总结' || index === currentTables.findIndex((table) => table?.id === 'memory_summary');
        const id = matched?.id || (isSummary ? 'memory_summary' : uniqueId(`import_${name}`, usedIds));
        usedIds.add(id);
        const columns = uniqueColumns(sheet?.c || sheet?.columns);
        return {
            id,
            name,
            icon: matched?.icon || (id === 'memory_summary' ? 'memory_book' : 'note'),
            columns: columns.length ? columns : ['名称', '内容'],
            hidden: !!matched?.hidden,
        };
    }

    function legacyRowsToRecords(rows, columns, tableId, summarizedRows = [], floorScope = null) {
        return (Array.isArray(rows) ? rows : []).map((row, rowIndex) => {
            const values = {};
            if (Array.isArray(row)) {
                columns.forEach((column, colIndex) => {
                    values[cleanColumnName(column)] = String(row[colIndex] ?? '');
                });
            } else if (row && typeof row === 'object') {
                Object.assign(values, normalizeRecordValues(row.values || row, columns));
            }
            const record = {
                id: createRecordId(tableId, rowIndex),
                hidden: summarizedRows.includes(rowIndex),
                values,
            };
            return isFloorScopedTable(tableId)
                ? (getStorage()?.ensureRecordFloorScope?.(record, floorScope) || record)
                : record;
        });
    }

    function normalizeLegacyBackup(raw, currentState = {}) {
        const sheets = Array.isArray(raw?.s) ? raw.s : (Array.isArray(raw) ? raw : []);
        const importFloorScope = getImportFloorScope(raw, currentState);
        const currentTables = Array.isArray(currentState.tables) ? currentState.tables : [];
        const usedIds = new Set();
        const tables = sheets
            .filter((sheet) => sheet && typeof sheet === 'object')
            .map((sheet, index) => legacySheetToTable(sheet, index, usedIds, currentTables));
        const records = {};
        tables.forEach((table, index) => {
            const rows = sheets[index]?.r || sheets[index]?.records || [];
            const summarizedRows = Array.isArray(raw?.summarized?.[index]) ? raw.summarized[index] : [];
            records[table.id] = legacyRowsToRecords(rows, table.columns, table.id, summarizedRows, importFloorScope);
        });
        return {
            tables,
            records,
            activeTableId: tables.find((table) => table.id !== 'memory_summary')?.id || tables[0]?.id || '',
            activeRecordIds: {},
            sourceScope: importFloorScope,
        };
    }

    function parseHumanReadableTxt(text) {
        const result = {
            v: 'legacy-txt',
            t: new Date().toISOString(),
            s: [],
        };
        let currentIndex = -1;
        let currentName = '';
        let currentColumns = new Set();
        let currentRows = [];

        const finalize = () => {
            if (currentIndex < 0) return;
            const columns = Array.from(currentColumns);
            result.s[currentIndex] = {
                n: currentName || `表格${currentIndex + 1}`,
                c: columns,
                r: currentRows.filter(Boolean).map((rowMap) => columns.map((column) => rowMap.get(column) || '')),
            };
        };

        String(text || '').split(/\r?\n/).forEach((line) => {
            const header = line.match(/===\s*(.+?)\s*\(表索引:\s*(\d+)\)\s*===/);
            if (header) {
                finalize();
                currentName = header[1].trim();
                currentIndex = Number(header[2]);
                currentColumns = new Set();
                currentRows = [];
                return;
            }
            if (currentIndex < 0) return;

            const rowMatch = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
            if (!rowMatch) return;

            const rowIndex = Number(rowMatch[1]);
            const rowMap = new Map();
            rowMatch[2].split('|').map((part) => part.trim()).forEach((part) => {
                const colonIndex = part.indexOf(':');
                if (colonIndex < 0) return;
                const key = part.slice(0, colonIndex).trim();
                const value = part.slice(colonIndex + 1).trim()
                    .replace(/\\n/g, '\n')
                    .replace(/\{\{PIPE\}\}/g, '|');
                if (!key) return;
                currentColumns.add(key);
                rowMap.set(key, value);
            });
            currentRows[rowIndex] = rowMap;
        });
        finalize();
        return result;
    }

    function parseText(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) throw new Error('导入文件为空。');
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
        if (trimmed.includes('表索引') && trimmed.includes('===')) return parseHumanReadableTxt(trimmed);
        throw new Error('无法识别的记忆表格备份格式。');
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
            reader.onerror = () => reject(new Error('文件读取失败。'));
            reader.readAsText(file);
        });
    }

    function normalizeImport(raw, currentState = {}) {
        if (raw?.format === FORMAT || (Array.isArray(raw?.tables) && raw?.records && typeof raw.records === 'object')) {
            return normalizeDirectBackup(raw, currentState);
        }
        if (Array.isArray(raw?.s) || Array.isArray(raw)) {
            return normalizeLegacyBackup(raw, currentState);
        }
        throw new Error('备份文件不包含可导入的表格数据。');
    }

    function exportState(state) {
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const records = state?.records && typeof state.records === 'object' ? state.records : {};
        const activeRecordIds = state?.activeRecordIds && typeof state.activeRecordIds === 'object' ? state.activeRecordIds : {};
        const sourceScope = getCurrentFloorScope(state);
        return {
            format: FORMAT,
            version: VERSION,
            exportedAt: new Date().toISOString(),
            sourceScope,
            tables: tables.map((table) => ({
                id: String(table?.id || ''),
                name: String(table?.name || ''),
                icon: String(table?.icon || ''),
                columns: Array.isArray(table?.columns) ? [...table.columns] : [],
                hidden: !!table?.hidden,
            })),
            records: Object.fromEntries(tables.map((table) => [
                table.id,
                (Array.isArray(records[table.id]) ? records[table.id] : []).map((record) => {
                    const exportedRecord = clone(record);
                    return isFloorScopedTable(table.id)
                        ? (getStorage()?.ensureRecordFloorScope?.(exportedRecord, sourceScope) || exportedRecord)
                        : exportedRecord;
                }),
            ])),
            activeTableId: String(state?.activeTableId || ''),
            activeRecordIds: Object.fromEntries(Object.entries(activeRecordIds)
                .filter(([tableId]) => tables.some((table) => table.id === tableId))),
        };
    }

    function downloadBackup(state, filenamePrefix = 'yuzuki_memory_tables') {
        const content = JSON.stringify(exportState(state), null, 2);
        const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${filenamePrefix}_${Date.now()}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function importIntoState(currentState, rawImport) {
        const imported = normalizeImport(rawImport, currentState);
        if (!imported.tables.length) throw new Error('备份中没有表格。');
        return {
            ...currentState,
            tables: imported.tables,
            records: imported.records,
            activeTableId: imported.tables.some((table) => table.id === imported.activeTableId)
                ? imported.activeTableId
                : imported.tables[0].id,
            activeRecordIds: imported.activeRecordIds || {},
        };
    }

    function getStats(state) {
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const records = state?.records && typeof state.records === 'object' ? state.records : {};
        const tableCount = tables.length;
        const recordCount = tables.reduce((sum, table) => sum + (Array.isArray(records[table.id]) ? records[table.id].length : 0), 0);
        const summaryCount = Array.isArray(records.memory_summary) ? records.memory_summary.length : 0;
        return { tableCount, recordCount, summaryCount };
    }

    YuzukiMemory.MemoryIO = {
        FORMAT,
        exportState,
        downloadBackup,
        parseText,
        parseFile,
        normalizeImport,
        importIntoState,
        getStats,
    };
})();
