// ============================================================================
// yuzuki-Memory character relationship graph data layer.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CHARACTER_TABLE_ID = 'character_profile';
    const DEFAULT_MAX_NODES = 30;

    function cleanColumnName(value) {
        return String(value || '').trim().replace(/^[#*]+/, '').trim();
    }

    function cleanRelationshipPart(value) {
        return String(value || '')
            .trim()
            .replace(/^[〔［\[{（(【]+/, '')
            .replace(/[〕］\]}）)】]+$/, '')
            .trim();
    }

    function getCharacterTable(state) {
        return (Array.isArray(state?.tables) ? state.tables : [])
            .find((table) => table?.id === CHARACTER_TABLE_ID) || null;
    }

    function getCharacterRecords(state) {
        return (Array.isArray(state?.records?.[CHARACTER_TABLE_ID])
            ? state.records[CHARACTER_TABLE_ID]
            : [])
            .filter((record) => record && typeof record === 'object');
    }

    function getPrimaryColumn(table) {
        return (Array.isArray(table?.columns) ? table.columns : [])
            .find((column) => cleanColumnName(column) === '角色名')
            || table?.columns?.[0]
            || '角色名';
    }

    function getRecordValue(record, fieldName) {
        const target = cleanColumnName(fieldName);
        const match = Object.entries(record?.values || {})
            .find(([column]) => cleanColumnName(column) === target);
        return match ? String(match[1] ?? '').trim() : '';
    }

    function getRecordName(table, record) {
        return getRecordValue(record, getPrimaryColumn(table))
            || getRecordValue(record, '角色名')
            || getRecordValue(record, '姓名');
    }

    function parseRelationships(text = '') {
        const source = String(text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/[；;]/g, '\n')
            .trim();
        if (!source) return [];

        return source
            .split(/\n+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                const match = entry.match(/^\s*[〔［\[{（(【]?\s*([^〕］\]}）)】:：\n]+?)\s*[〕］\]}）)】}]?\s*[:：]\s*(.*?)\s*$/);
                if (!match) return null;
                const targetName = cleanRelationshipPart(match[1]);
                const parts = String(match[2] || '').trim().split(/[·・•]/, 2);
                return targetName ? {
                    targetName,
                    relation: cleanRelationshipPart(parts[0]),
                    emotion: cleanRelationshipPart(parts[1]),
                    raw: entry,
                } : null;
            })
            .filter(Boolean);
    }

    function classifyRelationship(relation = '') {
        const value = String(relation || '');
        if (/(父|母|兄|弟|姐|妹|祖|孙|叔|伯|姑|姨|舅|侄|甥|亲属|亲戚|家人|家族|养父|养母|继父|继母|异母|异父)/.test(value)) return 'family';
        if (/(恋|爱|婚|夫|妻|情侣|伴侣|未婚|情人|暗恋|亲密|前任)/.test(value)) return 'intimate';
        if (/(敌|仇|宿敌|竞争|对手|冲突|敌对|嫌疑|警惕)/.test(value)) return 'hostile';
        if (/(同事|同学|朋友|好友|上司|下属|老师|学生|师父|徒弟|合作|盟友|搭档|邻居|校友|秘书|助理|雇主|雇员)/.test(value)) return 'social';
        return 'other';
    }

    function createCharacterEntries(state) {
        const table = getCharacterTable(state);
        const matcher = YuzukiMemory.CharacterNameMatcher;
        const usedIds = new Set();
        return getCharacterRecords(state).map((record, index) => {
            const rawName = getRecordName(table, record);
            const displayName = matcher?.getDisplayName?.(rawName) || rawName || `未命名角色${index + 1}`;
            let id = String(record?.id || `character-${index + 1}`).trim() || `character-${index + 1}`;
            while (usedIds.has(id)) id = `${id}-${index + 1}`;
            usedIds.add(id);
            return {
                id,
                record,
                rawName,
                displayName,
                aliases: matcher?.parseNames?.(rawName) || [displayName],
            };
        });
    }

    function findEntryByName(entries, table, targetName) {
        const matchedRecord = YuzukiMemory.CharacterNameMatcher?.findMatchingRecord?.(
            entries.map((entry) => entry.record),
            getPrimaryColumn(table),
            targetName,
        );
        if (matchedRecord) return entries.find((entry) => entry.record === matchedRecord) || null;

        const normalizeName = YuzukiMemory.CharacterNameMatcher?.normalizeName
            || ((value) => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase());
        const targetKey = normalizeName(targetName);
        return entries.find((entry) => entry.aliases.some((alias) => normalizeName(alias) === targetKey)) || null;
    }

    function createRelationshipIndex(state) {
        const table = getCharacterTable(state);
        const entries = createCharacterEntries(state);
        const entryById = new Map(entries.map((entry) => [entry.id, entry]));
        const links = [];
        const unmatched = [];

        entries.forEach((source) => {
            parseRelationships(getRecordValue(source.record, '人际关系')).forEach((relationship) => {
                const target = findEntryByName(entries, table, relationship.targetName);
                if (!target || target.id === source.id) {
                    if (!target) unmatched.push({ sourceId: source.id, ...relationship });
                    return;
                }
                links.push({
                    sourceId: source.id,
                    targetId: target.id,
                    relation: relationship.relation,
                    emotion: relationship.emotion,
                    category: classifyRelationship(relationship.relation),
                    raw: relationship.raw,
                });
            });
        });
        return { table, entries, entryById, links, unmatched };
    }

    function resolveCenterEntry(index, centerId) {
        if (!index.entries.length) return null;
        return index.entryById.get(String(centerId || ''))
            || (centerId ? findEntryByName(index.entries, index.table, centerId) : null)
            || index.entries[0];
    }

    function mergeVisibleEdges(links, visibleIds) {
        const merged = new Map();
        links.forEach((link) => {
            if (!visibleIds.has(link.sourceId) || !visibleIds.has(link.targetId)) return;
            const pair = [link.sourceId, link.targetId].sort();
            const key = pair.join('::');
            const edge = merged.get(key) || {
                id: key,
                sourceId: pair[0],
                targetId: pair[1],
                categories: [],
                relations: [],
                emotions: [],
                directions: [],
            };
            if (link.category && !edge.categories.includes(link.category)) edge.categories.push(link.category);
            if (link.relation && !edge.relations.includes(link.relation)) edge.relations.push(link.relation);
            if (link.emotion && !edge.emotions.includes(link.emotion)) edge.emotions.push(link.emotion);
            edge.directions.push({ ...link });
            merged.set(key, edge);
        });
        return Array.from(merged.values()).map((edge) => ({
            ...edge,
            category: edge.categories[0] || 'other',
            label: edge.relations.join(' / ') || '关系',
            emotionLabel: edge.emotions.join(' / '),
        }));
    }

    function getCharacterDetails(entry, index) {
        if (!entry) return null;
        const relationshipMap = new Map();
        index.links
            .filter((link) => link.sourceId === entry.id || link.targetId === entry.id)
            .forEach((link) => {
                const outgoing = link.sourceId === entry.id;
                const counterpart = index.entryById.get(outgoing ? link.targetId : link.sourceId);
                if (!counterpart) return;
                const item = relationshipMap.get(counterpart.id) || {
                    characterId: counterpart?.id || '',
                    characterName: counterpart?.displayName || '',
                    category: link.category,
                    relations: [],
                    emotions: [],
                    directions: [],
                };
                if (link.relation && !item.relations.includes(link.relation)) item.relations.push(link.relation);
                if (link.emotion && !item.emotions.includes(link.emotion)) item.emotions.push(link.emotion);
                const direction = outgoing ? 'outgoing' : 'incoming';
                if (!item.directions.includes(direction)) item.directions.push(direction);
                relationshipMap.set(counterpart.id, item);
            });
        const relationships = Array.from(relationshipMap.values()).map((item) => ({
            ...item,
            relation: item.relations.join(' / '),
            emotion: item.emotions.join(' / '),
            direction: item.directions.length > 1 ? 'both' : item.directions[0],
        }));

        return {
            id: entry.id,
            name: entry.displayName,
            rawName: entry.rawName,
            aliases: [...entry.aliases],
            record: entry.record,
            identity: getRecordValue(entry.record, '身份'),
            age: getRecordValue(entry.record, '年龄'),
            gender: getRecordValue(entry.record, '性别'),
            location: getRecordValue(entry.record, '当前位置'),
            physiology: getRecordValue(entry.record, '生理'),
            personality: getRecordValue(entry.record, '性格'),
            clothing: getRecordValue(entry.record, '着装'),
            todoText: getRecordValue(entry.record, '待办事项'),
            relationships,
            unmatchedRelationshipCount: index.unmatched.filter((item) => item.sourceId === entry.id).length,
        };
    }

    function createAdjacency(index) {
        const adjacency = new Map(index.entries.map((entry) => [entry.id, new Set()]));
        index.links.forEach((link) => {
            adjacency.get(link.sourceId)?.add(link.targetId);
            adjacency.get(link.targetId)?.add(link.sourceId);
        });
        return adjacency;
    }

    function countReachable(adjacency, centerId) {
        const visited = new Set([centerId]);
        const queue = [centerId];
        while (queue.length) {
            const currentId = queue.shift();
            for (const nextId of adjacency.get(currentId) || []) {
                if (visited.has(nextId)) continue;
                visited.add(nextId);
                queue.push(nextId);
            }
        }
        return visited.size;
    }

    function buildGraph(state, options = {}) {
        const mode = options.mode === 'all' ? 'all' : 'first';
        const maxNodes = Math.max(1, Number(options.maxNodes) || DEFAULT_MAX_NODES);
        const index = createRelationshipIndex(state || {});
        const center = resolveCenterEntry(index, options.centerId);
        if (!center) {
            return {
                mode,
                centerId: '',
                nodes: [],
                edges: [],
                characters: [],
                centerDetails: null,
                unmatched: index.unmatched,
                truncated: false,
            };
        }

        const adjacency = createAdjacency(index);
        const distanceById = new Map([[center.id, 0]]);
        const queue = [center.id];
        while (queue.length && distanceById.size < maxNodes) {
            const currentId = queue.shift();
            const distance = distanceById.get(currentId) || 0;
            if (mode === 'first' && distance >= 1) continue;
            for (const nextId of adjacency.get(currentId) || []) {
                if (distanceById.has(nextId)) continue;
                distanceById.set(nextId, distance + 1);
                queue.push(nextId);
                if (distanceById.size >= maxNodes) break;
            }
        }

        const visibleIds = new Set(distanceById.keys());
        const nodes = Array.from(visibleIds)
            .map((id) => index.entryById.get(id))
            .filter(Boolean)
            .map((entry) => ({
                ...getCharacterDetails(entry, index),
                distance: distanceById.get(entry.id) || 0,
            }))
            .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name, 'zh-CN'));

        return {
            mode,
            centerId: center.id,
            nodes,
            edges: mergeVisibleEdges(index.links, visibleIds),
            characters: index.entries.map((entry) => getCharacterDetails(entry, index)),
            centerDetails: getCharacterDetails(center, index),
            unmatched: index.unmatched,
            truncated: mode === 'all' && countReachable(adjacency, center.id) > visibleIds.size,
        };
    }

    function loadCurrentState() {
        const fallback = YuzukiMemory.MemoryTagParser?.createDefaultState?.() || { tables: [], records: {} };
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.();
        return YuzukiMemory.Storage?.loadState?.(fallback, sessionId) || fallback;
    }

    function searchCharacters(state, query = '') {
        const normalizedQuery = String(query || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        const index = createRelationshipIndex(state || {});
        return index.entries
            .filter((entry) => !normalizedQuery || entry.aliases.some((alias) => (
                String(alias || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase().includes(normalizedQuery)
            )))
            .map((entry) => getCharacterDetails(entry, index));
    }

    YuzukiMemory.CharacterGraph = Object.assign(YuzukiMemory.CharacterGraph || {}, {
        CHARACTER_TABLE_ID,
        DEFAULT_MAX_NODES,
        cleanColumnName,
        getCharacterTable,
        getCharacterRecords,
        getRecordValue,
        parseRelationships,
        classifyRelationship,
        buildGraph,
        loadCurrentState,
        searchCharacters,
    });
})();
