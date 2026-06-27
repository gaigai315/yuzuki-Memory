// ============================================================================
// yuzuki-Memory task runner.
// Handles plugin-owned trace/summary tasks without touching SillyTavern chat text.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const TAG_PRESETS_STORAGE_KEY = 'yzm_memory_global_tag_presets';
    const TAG_ACTIVE_PRESET_STORAGE_KEY = 'yzm_memory_global_tag_active_preset';
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
    const AI_TAG_DIAGNOSTIC_PROMPT = `你是一个剧情记录系统的标签过滤专家。你的任务是分析 AI 的回复文本，制定最优的标签过滤方案（黑名单或白名单）。

【系统过滤机制说明】
- 黑名单 (blacklist)：列出的标签及其内部内容会被删除，保留剩下的所有内容（包括裸文本和其他未列出的标签）。
- 白名单 (whitelist)：仅提取并保留列出的标签内部的内容，其他所有内容（包括裸文本和其他标签）都会被删除。

【核心决策逻辑】
你必须首先寻找“剧情正文”（即角色的对话、动作描写、时间状态栏等核心可见内容）所在的位置：
1. 如果正文是裸文本（即正文没有被任何特定标签包裹）：
   绝对不能使用白名单，因为白名单会删除不在标签内的裸文本正文。
   只能使用黑名单，将需要剔除的后台标签（如 think、system、Memory 等）填入 blacklist。
2. 如果正文或时间被特定标签包裹（例如 <content>正文</content> 或 [时间]正文[/时间]）：
   可以使用白名单。
   如果干扰后台标签很多，而有用正文标签只有一两个，优先使用 whitelist。
   白名单中必须同时包含正文标签和时间标签（如 time、globalTime、[时间] 等），缺一不可。

【标签格式提取要求】
- 方括号标签：必须包含方括号，如 "[歌曲]"、"[动作]"。
- 尖括号标签：只提取标签名，不带括号，如 "think"、"Memory"、"globalTime"。
- HTML 注释：用 "!--" 表示。

【分析任务】
请分析以下 AI 回复的原始文本，判断正文的位置，并给出最简洁的过滤方案。
文本内容：
---
{{RAW_TEXT}}
---

【输出要求】
请仅输出纯 JSON 格式，严格遵循以下结构：
{
  "reasoning": "简述正文是裸文本还是被标签包裹，以及为什么选择黑名单或白名单",
  "blacklist": ["需要删除的标签1", "需要删除的标签2"],
  "whitelist": ["需要保留的标签"]
}`;
    let autoSummaryBound = false;
    let autoSummaryTimer = null;
    let autoSummaryRunning = false;
    let autoSummaryPromptOpen = false;
    let autoTaskArmed = false;
    let autoTaskSessionId = '';
    let autoTaskBaselineChatLength = 0;
    let autoTaskLastGenerationAt = 0;
    let autoTaskSessionPollTimer = null;
    const CHAT_REQUEST_COOLDOWN_MS = 1500;
    const AUTO_TASK_BACKFILL_RETRY_MS = 15000;
    const AUTO_TASK_BACKFILL_NEXT_MS = 2500;

    function isGenerationBusy() {
        const ctx = getContext();
        return window.is_send_press === true
            || window.isStreaming === true
            || window.isGenerating === true
            || ctx?.is_send_press === true
            || ctx?.isStreaming === true
            || ctx?.generationStarted === true;
    }

    function isChatRequestBusy() {
        const state = YuzukiMemory.RequestProbe?.getChatRequestState?.() || {};
        const activeCount = Math.max(
            0,
            Number(state.activeCount ?? window.yzmMemoryChatRequestActiveCount) || 0
        );
        if (activeCount > 0) return true;
        const lastFinishedAt = Number(state.lastFinishedAt ?? window.yzmMemoryLastChatRequestFinishedAt) || 0;
        return lastFinishedAt > 0 && Date.now() - lastFinishedAt < CHAT_REQUEST_COOLDOWN_MS;
    }

    function isPluginTaskBusy() {
        return window.isSummarizing === true
            || window.yzmMemoryManualTaskRunning === true
            || autoSummaryRunning
            || autoSummaryPromptOpen;
    }

    function isManualTaskBusy() {
        return window.yzmMemoryManualTaskRunning === true;
    }

    function notifyAutoTaskFailure(task = {}, error = '') {
        const taskTitle = String(task?.title || '自动记忆任务').trim();
        const message = String(error?.message || error || '未知错误').trim();
        const range = Number.isFinite(Number(task?.start)) && Number.isFinite(Number(task?.end))
            ? `（范围 ${task.start}-${task.end}，不含 ${task.end}）`
            : '';
        const retryHint = task?.type === 'trace' ? '填表指针未推进，后续正文结束后会继续尝试补跑。' : '总结指针未推进，后续正文结束后会继续尝试补跑。';
        const detail = message
            ? `${taskTitle}失败${range}：${message}\n${retryHint}`
            : `${taskTitle}失败${range}。\n${retryHint}`;
        try {
            if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') {
                toastr.error(detail, '柚月记忆', { timeOut: 8000 });
                return;
            }
        } catch (_error) {}
        console.warn(`[yuzuki-Memory] ${detail}`);
    }

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
        if (!Array.isArray(presets)) return null;
        const activeId = String(parseJsonStorage(TAG_ACTIVE_PRESET_STORAGE_KEY, '') || '').trim();
        const activePreset = activeId ? presets.find((preset) => preset?.id === activeId) : null;
        return activePreset || presets.find((preset) => preset && (preset.blacklist?.length || preset.whitelist?.length)) || null;
    }

    function getPluginSettings() {
        const settings = parseJsonStorage(PLUGIN_SETTINGS_STORAGE_KEY, {});
        return {
            fillMode: settings?.fillMode === 'batch' ? 'batch' : 'realtime',
            traceBatchEnabled: settings?.traceBatchEnabled !== false,
            traceBatchSize: Math.max(1, Math.round(Number(settings?.traceBatchSize) || 40)),
            traceBatchDelay: Math.max(0, Math.round(Number(settings?.traceBatchDelay ?? 2) || 0)),
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
            .replace(/\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\}\}/gi, '')
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

    function getCurrentSessionId() {
        const ctx = getContext() || {};
        const chatId = ctx.chatMetadata?.file_name || ctx.chatId || ctx.chat?.file_name || '';
        if (!chatId) return '';
        if (ctx.groupId) return `group:${ctx.groupId}:${chatId}`;
        const character = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const characterId = ctx.characterId || character?.avatar || character?.name || ctx.name2 || ctx.characterName;
        return characterId ? `char:${characterId}:${chatId}` : `chat:${chatId}`;
    }

    function getChatLength() {
        const chat = getContext()?.chat;
        return Array.isArray(chat) ? chat.length : 0;
    }

    function getLatestChatMessage() {
        const chat = getContext()?.chat;
        return Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
    }

    function getLatestAssistantChatMessage() {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) return null;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (!message || isPluginMessage(message)) continue;
            if (message.is_user === true || message.role === 'user' || message.role === 'system') continue;
            const text = getChatText(message);
            if (!String(text || '').trim()) continue;
            return { message, index, text };
        }
        return null;
    }

    function isLatestAssistantMessage() {
        const message = getLatestChatMessage();
        if (!message || isPluginMessage(message)) return false;
        if (message.is_user === true || message.role === 'user') return false;
        if (message.role === 'system') return false;
        return Boolean(stripMemoryTags(getChatText(message)).trim());
    }

    function refreshAutoTaskBaseline() {
        autoTaskSessionId = getCurrentSessionId();
        autoTaskBaselineChatLength = getChatLength();
        autoTaskArmed = false;
    }

    function cancelPendingAutoTask() {
        window.clearTimeout(autoSummaryTimer);
        autoTaskArmed = false;
        autoTaskBaselineChatLength = getChatLength();
    }

    function getRuntimeNames() {
        const ctx = getContext() || {};
        const character = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        return {
            user: String(ctx.name1 || ctx.userName || ctx.playerName || 'User'),
            char: String(character?.name || ctx.name2 || ctx.characterName || ctx.name || 'Character'),
        };
    }

    function getChatText(message) {
        const swipeId = Number(message?.swipe_id ?? 0);
        if (Array.isArray(message?.swipes) && message.swipes.length > swipeId) return String(message.swipes[swipeId] || '');
        return String(message?.mes || message?.content || '');
    }

    function isPluginMessage(message) {
        return !!(message?.isGaigaiData || message?.isGaigaiPrompt || message?.isPhoneMessage || message?.yzmMemoryInternal);
    }

    function isDialogueFloorMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        return role === 'user' || role === 'assistant';
    }

    function shouldSkipTaskRangeMessage(message) {
        if (!message || isPluginMessage(message)) return true;
        const role = String(message.role || '').toLowerCase();
        if (role !== 'system') return false;
        return !isDialogueFloorMessage(message);
    }

    function chatMessagesFromRange(start, end, options = {}) {
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const names = getRuntimeNames();
        const userName = names.user;
        const charName = names.char;
        const from = Math.max(0, Math.min(Number(start) || 0, chat.length));
        const to = Math.max(from, Math.min(Number(end) || chat.length, chat.length));
        const tagPreset = options.tagPreset === false ? null : getActiveTagPreset();
        const messages = [];

        chat.slice(from, to).forEach((message, offset) => {
            if (shouldSkipTaskRangeMessage(message)) return;
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

    function compactField(label, value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const normalized = text.replace(/\r\n/g, '\n').trim();
        return `${label}：${normalized}`;
    }

    function firstTextValue(source, keys = []) {
        if (!source || typeof source !== 'object') return '';
        for (const key of keys) {
            const value = source[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    }

    function getRuntimeCharacter() {
        const ctx = getContext() || {};
        return Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    }

    function buildRuntimeBackgroundText(options = {}) {
        const ctx = getContext() || {};
        const names = getRuntimeNames();
        const character = getRuntimeCharacter() || {};
        const persona = ctx.persona || ctx.userPersona || ctx.persona_description || ctx.user_description || ctx.power_user?.persona_description || '';
        const chatMetadata = ctx.chatMetadata && typeof ctx.chatMetadata === 'object' ? ctx.chatMetadata : {};
        const chatMetadataKeys = options.includeChatSummary === false
            ? ['note_prompt', 'scenario', 'description']
            : ['note_prompt', 'scenario', 'summary', 'description'];
        const lines = [
            '【背景资料】',
            `角色：${names.char}`,
            `用户：${names.user}`,
            compactField('用户信息', persona),
            compactField('角色描述', firstTextValue(character, ['description', 'desc'])),
            compactField('角色性格', firstTextValue(character, ['personality'])),
            compactField('场景/故事背景', firstTextValue(character, ['scenario', 'world_scenario'])),
            compactField('开场消息', firstTextValue(character, ['first_mes', 'first_message', 'firstMessage'])),
            compactField('对话示例', firstTextValue(character, ['mes_example', 'example_dialogue'])),
            compactField('角色备注', firstTextValue(character, ['creatorcomment', 'creator_comment', 'comment', 'notes'])),
            compactField('聊天备注', firstTextValue(chatMetadata, chatMetadataKeys)),
        ];
        return compactLines(lines);
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
                return compactLines([`【当前世界状态参考—${table.name}】`, rows.length ? rows.join('\n') : '（当前暂无数据）']);
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
                if (table.id === PLOT_SUMMARY_TABLE_ID) {
                    return '#剧情摘要：包含 #主线摘要：摘要名称，日期，摘要内容；#支线摘要：日期，摘要内容';
                }
                const columns = (table.columns || []).map(cleanColumnName).filter(Boolean);
                const fields = columns.map((column, index) => index === 0 ? `${column}(主键)` : column).join(', ');
                return `#${table.name}：包含 ${fields}`;
            })
            .filter(Boolean);
        return compactLines(lines);
    }

    function buildBranchSummaryNamesText(state) {
        if (YuzukiMemory.VariableInjector?.buildBranchSummaryNamesText) {
            return YuzukiMemory.VariableInjector.buildBranchSummaryNamesText(state);
        }
        const records = stateRecords(state, FIXED_SUMMARY_TABLE_ID);
        const names = [];
        records.forEach((record) => {
            const values = record?.values || {};
            const title = String(values.总结标题 || values.title || '').trim();
            if (!/支线/.test(title)) return;
            const name = String(values.核心角色 || values.character || values.角色名 || values.主视角 || '').trim();
            if (name && !names.includes(name)) names.push(name);
        });
        return names.length ? names.join('、') : '（当前暂无已有支线核心角色）';
    }

    function resolveTaskPromptVariables(text, state, options = {}) {
        const names = getRuntimeNames();
        const suppressMemoryTables = options.suppressMemoryTables === true;
        return String(text || '')
            .replace(/\{\{user\}\}/g, names.user)
            .replace(/\{\{char\}\}/g, names.char)
            .replace(/\{\{BRANCH_SUMMARY_NAMES\}\}/gi, () => buildBranchSummaryNamesText(state))
            .replace(/\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS)\}\}/gi, () => suppressMemoryTables ? '' : buildDatabaseSchemaText(state, options))
            .replace(/\{\{MEMORY_TABLE_(.+?)\}\}/gi, (_match, tableName) => suppressMemoryTables ? '' : (YuzukiMemory.VariableInjector?.buildSpecificTableText?.(state, tableName) || ''))
            .replace(/\{\{MEMORY_SUMMARY_(.+?)\}\}/gi, (_match, summaryKey) => suppressMemoryTables ? '' : (YuzukiMemory.VariableInjector?.buildSpecificSummaryText?.(state, summaryKey) || ''))
            .replace(/\{\{MEMORY_TABLE\}\}/gi, () => suppressMemoryTables ? '' : (YuzukiMemory.VariableInjector?.buildAllTablesText?.(state) || tablesToReferenceText(state, options)))
            .replace(/\{\{MEMORY_SUMMARY\}\}/gi, () => suppressMemoryTables ? '' : (YuzukiMemory.VariableInjector?.buildSummaryText?.(state) || ''))
            .replace(/\{\{MEMORY_PROMPT\}\}/gi, '')
            .replace(/\{\{MEMORY\}\}/gi, () => suppressMemoryTables ? '' : (YuzukiMemory.VariableInjector?.buildMemoryText?.(state) || compactLines([YuzukiMemory.VariableInjector?.buildSummaryText?.(state), tablesToReferenceText(state, options)])));
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
                    summary: String(prompts.summary ?? ''),
                    summaryOptimize: String(prompts.summaryOptimize ?? ''),
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

    function buildTaskRequestMeta(options = {}) {
        return {
            kind: String(options.kind || options.autoTaskType || 'manual'),
            range: {
                start: Math.max(0, Math.round(Number(options.start) || 0)),
                end: Math.max(0, Math.round(Number(options.end) || 0)),
            },
        };
    }

    function captureTaskRequest(messages, options = {}) {
        if (!YuzukiMemory.RequestProbe?.captureFromBody) return;
        const mode = getLlmMode();
        const preset = mode === 'custom' ? getActiveLlmPreset() : null;
        const body = {
            model: mode === 'custom' ? String(preset?.model || '') : 'SillyTavern',
            messages,
            yzmMemoryTask: buildTaskRequestMeta(options),
            yzmMemoryInternalApi: true,
        };
        YuzukiMemory.RequestProbe.captureFromBody(body, 'yuzuki-memory://task');
    }

    async function generate(messages, options = {}) {
        if (!YuzukiMemory.LlmClient) return { success: false, error: 'LLM 客户端尚未加载。' };
        const previousSummarizing = window.isSummarizing;
        window.isSummarizing = true;
        try {
            captureTaskRequest(messages, options);
            const taskOptions = {
                ...options,
                yzmMemoryTask: buildTaskRequestMeta(options),
                yzmMemoryInternalApi: true,
            };
            if (getLlmMode() === 'custom') {
                const preset = getActiveLlmPreset();
                if (!preset) return { success: false, error: '未选择可用的 LLM API 预设。' };
                return YuzukiMemory.LlmClient.generateWithCustom(preset, messages, { stream: preset.stream !== false, ...taskOptions });
            }
            return YuzukiMemory.LlmClient.generateWithTavern(messages, { stream: true, ...taskOptions });
        } finally {
            window.isSummarizing = previousSummarizing;
        }
    }

    function parseJsonBlock(text = '') {
        const blocks = parseJsonBlocks(text);
        if (blocks.length) return blocks[0];
        throw new Error('未找到可解析的 JSON 结果。');
    }

    function parseJsonBlocks(text = '') {
        const source = String(text || '').trim();
        if (!source) return [];

        try {
            return [JSON.parse(source)];
        } catch {
            // Continue with tolerant extraction below.
        }

        return extractJsonValues(source)
            .map((block) => {
                try {
                    return JSON.parse(block);
                } catch (_error) {
                    return null;
                }
            })
            .filter((block) => block !== null);
    }

    function extractJsonValues(text = '') {
        const source = String(text || '');
        const values = [];
        let cursor = 0;

        while (cursor < source.length) {
            const start = findJsonStart(source, cursor);
            if (start < 0) break;

            const end = findJsonEnd(source, start);
            if (end > start) {
                values.push(source.slice(start, end + 1));
                cursor = end + 1;
            } else {
                cursor = start + 1;
            }
        }

        return values;
    }

    function findJsonStart(text, fromIndex = 0) {
        const objectIndex = text.indexOf('{', fromIndex);
        const arrayIndex = text.indexOf('[', fromIndex);
        if (objectIndex < 0) return arrayIndex;
        if (arrayIndex < 0) return objectIndex;
        return Math.min(objectIndex, arrayIndex);
    }

    function findJsonEnd(text, startIndex) {
        const stack = [text[startIndex]];
        let inString = false;
        let escaped = false;

        for (let index = startIndex + 1; index < text.length; index += 1) {
            const char = text[index];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{' || char === '[') {
                stack.push(char);
                continue;
            }

            if (char !== '}' && char !== ']') continue;

            const opener = stack[stack.length - 1];
            const expected = opener === '{' ? '}' : ']';
            if (char !== expected) return -1;

            stack.pop();
            if (!stack.length) return index;
        }

        return -1;
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
            const parsedBlocks = parseJsonBlocks(text);
            if (!parsedBlocks.length) throw new Error('未找到可解析的 JSON 结果。');
            if (parsedBlocks.length === 1) return parsedBlocks[0];
            const records = parsedBlocks.flatMap((block) => Array.isArray(block?.records) ? block.records : (Array.isArray(block) ? block : []));
            const memoryRows = parsedBlocks.flatMap((block) => Array.isArray(block?.memoryRows) ? block.memoryRows : []);
            if (records.length) return { records };
            if (memoryRows.length) return { memoryRows };
            return parsedBlocks[0];
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
        let title = String(source.title || source['总结标题'] || source.name || '').trim();
        const titleMatch = title.match(/^【?支线总结[-－—:： ]+(.+?)】?$/);
        const branchCharacterFromTitle = titleMatch ? titleMatch[1].trim() : '';
        if (branchCharacterFromTitle) title = '';
        if (/^(总结标题|标题|主线总结|支线总结)$/.test(title)) title = '';
        const kindSource = String(source.kind || source.type || title || '').trim();
        const kind = kindSource.includes('branch') || kindSource.includes('支线') || !!branchCharacterFromTitle ? 'branch' : 'main';
        const summary = normalizeSummaryText(source.summary ?? source['总结内容']);
        return {
            kind,
            title,
            character: String(source.character || source.pov || source.npc || source['核心角色'] || source['角色名'] || source['主视角'] || branchCharacterFromTitle || '').trim(),
            summary,
            unresolved: Array.isArray(source.unresolved) ? source.unresolved.join('\n') : String(source.unresolved || source['未解决问题'] || '').trim(),
            remark: String(source.remark || source.note || source['备注'] || '').trim(),
        };
    }

    function normalizeSummaryText(value) {
        if (Array.isArray(value)) {
            return value.map((entry) => {
                if (entry && typeof entry === 'object') {
                    const time = String(entry.time || entry.date || entry.range || entry['时间'] || entry['日期'] || '').trim();
                    const event = String(entry.event || entry.content || entry.summary || entry['事件'] || entry['内容'] || '').trim();
                    return [time, event].filter(Boolean).join(' ');
                }
                return String(entry || '').trim();
            }).filter(Boolean).join('\n');
        }
        return String(value || '').trim();
    }

    function parseSummaryResponse(text = '') {
        const parsedBlocks = parseJsonBlocks(text);
        if (!parsedBlocks.length) throw new Error('未找到可解析的 JSON 结果。');
        const payloads = parsedBlocks.flatMap((parsed) => Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.summaries) ? parsed.summaries : (Array.isArray(parsed?.records) ? parsed.records : [parsed])));
        return payloads.map(normalizeSummaryPayload).filter((payload) => payload.summary);
    }

    function getSummaryPreview(payload) {
        if (!payload) return '';
        return compactLines([
            payload.title ? `标题：${payload.title}` : '',
            payload.kind ? `类型：${payload.kind === 'branch' ? '支线' : '主线'}` : '',
            payload.character ? `核心角色：${payload.character}` : '',
            payload.summary ? `内容：${payload.summary}` : '',
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
        if (/主线摘要|支线摘要|剧情摘要/.test(key)) {
            return tables.find((table) => table.id === PLOT_SUMMARY_TABLE_ID || table.name === '剧情摘要') || null;
        }
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

    function getPlotKind(value = '') {
        return /支线/.test(String(value || '')) ? 'branch' : 'main';
    }

    function splitPlotTimeAndContent(text = '') {
        const source = String(text || '').trim();
        if (!source) return { time: '', content: '' };
        const pattern = /^(.+?(?:\d{1,2}[:：]\d{2})(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?)\s*[，,、:：\s]\s*([\s\S]+)$/;
        const match = source.match(pattern);
        if (!match) return { time: '', content: source };
        return {
            time: match[1].replace(/：/g, ':').trim(),
            content: match[2].trim(),
        };
    }

    function plotValuesToText(values = {}, fallbackTitle = '') {
        let title = String(values['摘要名称'] || values['标题'] || values.name || values.title || '').trim();
        if (/^(主线|支线)摘要$/.test(title)) title = '';
        let date = String(values['日期'] || values['时间'] || values.date || values.time || '').replace(/：/g, ':').trim();
        let content = String(values['摘要内容'] || values['内容'] || values['总结内容'] || values.content || values.summary || '').trim();
        if (!date && content) {
            const parsed = splitPlotTimeAndContent(content);
            date = parsed.time;
            content = parsed.content;
        }
        const body = [title, content].filter(Boolean).join('：');
        return [date, body].filter(Boolean).join('\t').trim();
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

    function getRangeFloorValue(range) {
        const normalized = getRangeMeta(range);
        return normalized ? `${normalized.start}-${normalized.end}` : '';
    }

    function appendMultilineValue(current, next) {
        const currentText = String(current || '').trim();
        const nextText = String(next || '').trim();
        if (!nextText) return currentText;
        if (!currentText) return nextText;
        return `${currentText}\n${nextText}`;
    }

    function splitMultilineValue(value) {
        return String(value || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
    }

    function normalizeBranchCharacterName(value) {
        return String(value || '').trim().toLowerCase();
    }

    function findBranchSummaryByCharacter(records = [], character = '') {
        const key = normalizeBranchCharacterName(character);
        if (!key) return null;
        return (Array.isArray(records) ? records : []).find((record) => {
            const values = record?.values || {};
            const title = String(values.总结标题 || values.title || '').trim();
            const recordCharacter = normalizeBranchCharacterName(values.核心角色 || values.character || values.角色名 || values.主视角);
            return /支线/.test(title) && recordCharacter === key;
        }) || null;
    }

    function syncSummarySegmentsToValues(record) {
        const segments = Array.isArray(record?.summarySegments) ? record.summarySegments : [];
        if (!segments.length) return;
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        record.values.楼层数 = segments.map((segment) => String(segment.floor || '').trim()).filter(Boolean).join('\n');
        record.values.总结内容 = segments.map((segment) => String(segment.summary || '').trim()).filter(Boolean).join('\n');
        record.values.未解决问题 = segments.map((segment) => String(segment.unresolved || '').trim()).filter(Boolean).join('\n');
        record.values.备注 = segments.map((segment) => String(segment.remark || '').trim()).filter(Boolean).join('\n');
    }

    function appendSummarySegment(record, values, meta = {}) {
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        const nextFloor = String(values.楼层数 || '').trim();
        const nextSummary = String(values.总结内容 || '').trim();
        record.summarySegments = Array.isArray(record.summarySegments) ? record.summarySegments : [];
        const range = getRangeMeta(meta.range);
        const segment = {
            floor: nextFloor,
            summary: nextSummary,
            unresolved: String(values.未解决问题 || '').trim(),
            remark: String(values.备注 || '').trim(),
            range,
            summaryType: meta.autoTaskType || 'manual',
            createdAt: Date.now(),
        };
        if (nextFloor) {
            const duplicateIndex = record.summarySegments.findIndex((entry) => String(entry?.floor || '').trim() === nextFloor);
            if (duplicateIndex > -1) {
                record.summarySegments[duplicateIndex] = { ...record.summarySegments[duplicateIndex], ...segment };
            } else {
                record.summarySegments.push(segment);
            }
        } else {
            record.summarySegments.push(segment);
        }
        syncSummarySegmentsToValues(record);
    }

    function isBlankSummaryRecord(record) {
        const values = record?.values || {};
        return !String(values.总结内容 || values.summary || '').trim()
            && !String(values.未解决问题 || values.unresolved || '').trim()
            && !String(values.备注 || values.remark || '').trim()
            && !String(values.楼层数 || values.range || '').trim();
    }

    function findReusableSummaryPlaceholder(records = [], primary = '总结标题', label = '主线总结') {
        return (Array.isArray(records) ? records : []).find((record) => {
            const title = String(record?.values?.[primary] || '').trim();
            return title === label && isBlankSummaryRecord(record) && !record?.meta?.yzmMemoryTask;
        }) || null;
    }

    function getSummaryRecordTaskMeta(record) {
        const task = record?.meta?.yzmMemoryTask;
        return task && typeof task === 'object' ? task : null;
    }

    function getSummaryRecordFloorRange(record) {
        const values = record?.values || {};
        const rawRange = String(values.楼层数 || values.range || values['楼层范围'] || values['楼层'] || '').trim();
        const match = rawRange.match(/(\d+)\s*(?:-|~|－|—|至|到)\s*(\d+)/);
        if (!match) return null;
        const start = Math.max(0, Math.round(Number(match[1]) || 0));
        const end = Math.max(start, Math.round(Number(match[2]) || 0));
        return end > start ? { start, end } : null;
    }

    function getSummarySegmentRange(segment) {
        const range = getRangeMeta(segment?.range);
        if (range) return range;
        const rawRange = String(segment?.floor || segment?.楼层数 || segment?.rangeLabel || '').trim();
        const match = rawRange.match(/(\d+)\s*(?:-|~|－|—|至|到)\s*(\d+)/);
        if (!match) return null;
        const start = Math.max(0, Math.round(Number(match[1]) || 0));
        const end = Math.max(start, Math.round(Number(match[2]) || 0));
        return end > start ? { start, end } : null;
    }

    function isSmallSummaryRecord(record, table, task) {
        if (task?.summaryType === 'history' || task?.summaryType === 'optimize') return false;
        return Boolean(getSummaryRecordFloorRange(record));
    }

    function isSummaryCoveredByRange(record, table, targetRange) {
        const recordRange = getRangeMeta(getSummaryRecordTaskMeta(record)?.range) || getSummaryRecordFloorRange(record);
        return isSmallSummaryRecord(record, table, getSummaryRecordTaskMeta(record))
            && recordRange
            && recordRange.start >= targetRange.start
            && recordRange.end <= targetRange.end;
    }

    function getTitleRecordsForSummary(records = [], table = null, meta = {}) {
        if (meta.autoTaskType !== 'history') return records;
        const targetRange = getRangeMeta(meta.range);
        if (!targetRange) return records;
        return (Array.isArray(records) ? records : []).filter((record) => !isSummaryCoveredByRange(record, table, targetRange));
    }

    function getSummaryRecordTitle(payload, records = [], table = null, meta = {}) {
        const label = payload.kind === 'branch' ? '支线总结' : '主线总结';
        return getNextSummaryTitle(table, getTitleRecordsForSummary(records, table, meta), label);
    }

    function upsertSummaryRecord(state, payload, meta = {}) {
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table) return null;
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        const records = state.records[table.id];
        const title = getSummaryRecordTitle(payload, records, table, meta);
        const rangeLabel = getRangeLabel(meta.range);
        const floorValue = getRangeFloorValue(meta.range);
        const isAutoSummaryRecord = meta.autoTaskType === 'summary' || meta.autoTaskType === 'history';
        const values = {
            [getPrimaryColumn(table)]: title,
            核心角色: payload.kind === 'branch' ? payload.character : '',
            楼层数: floorValue,
            总结内容: payload.summary,
            未解决问题: payload.unresolved,
            备注: payload.remark,
        };
        const primary = getPrimaryColumn(table);
        const shouldGroupBranch = payload.kind === 'branch' && values.核心角色;
        let record = shouldGroupBranch ? findBranchSummaryByCharacter(records, values.核心角色) : null;
        if (!record) record = records.find((entry) => String(entry?.values?.[primary] || '').trim() === title);
        if (!record) {
            const label = payload.kind === 'branch' ? '支线总结' : '主线总结';
            record = findReusableSummaryPlaceholder(records, primary, label);
        }
        if (record) {
            record.values = record.values && typeof record.values === 'object' ? record.values : {};
            record.values[primary] = shouldGroupBranch ? (record.values[primary] || title) : title;
            if (isAutoSummaryRecord && !shouldGroupBranch) {
                record.values.核心角色 = values.核心角色;
                record.values.楼层数 = values.楼层数;
                record.values.总结内容 = values.总结内容;
                record.values.未解决问题 = values.未解决问题;
                record.values.备注 = values.备注;
            } else {
                record.values.核心角色 = values.核心角色 || record.values.核心角色 || '';
                appendSummarySegment(record, values, meta);
            }
        } else {
            record = createRecord(table, values);
            if (shouldGroupBranch) {
                record.values.楼层数 = '';
                record.values.总结内容 = '';
                record.values.未解决问题 = '';
                record.values.备注 = '';
                record.summarySegments = [];
                appendSummarySegment(record, values, meta);
            }
            records.push(record);
        }
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
        return record;
    }

    function getNextSummaryTitle(table, records = [], label = '主线总结') {
        const primary = getPrimaryColumn(table);
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numberedTitlePattern = new RegExp(`^${escapedLabel}（(\\d+)）$`);
        const maxIndex = (Array.isArray(records) ? records : []).reduce((max, record) => {
            const title = String(record?.values?.[primary] || '').trim();
            const numberedMatch = title.match(numberedTitlePattern);
            if (numberedMatch) return Math.max(max, Number(numberedMatch[1]) || 0);
            if (title === label && !isBlankSummaryRecord(record)) return Math.max(max, 1);
            return max;
        }, 0);
        return `${label}（${maxIndex + 1}）`;
    }

    function getSummaryRecordKind(record) {
        const values = record?.values || {};
        const title = String(values.总结标题 || values.title || '').trim();
        return /支线/.test(title) ? 'branch' : 'main';
    }

    function getSummaryRecordPayload(table, record) {
        const values = record?.values || {};
        return {
            kind: getSummaryRecordKind(record),
            title: String(values[getPrimaryColumn(table)] || values.总结标题 || '').trim(),
            character: String(values.核心角色 || values.character || '').trim(),
            summary: String(values.总结内容 || values.summary || '').trim(),
            unresolved: String(values.未解决问题 || values.unresolved || '').trim(),
            remark: String(values.备注 || values.remark || '').trim(),
        };
    }

    function summaryRecordToOptimizeText(table, record, index = 0) {
        const payload = getSummaryRecordPayload(table, record);
        const floorText = String(record?.values?.楼层数 || '').trim();
        return compactLines([
            `【目标 ${index + 1}】`,
            `recordId: ${record?.id || ''}`,
            `类型: ${payload.kind === 'branch' ? '支线' : '主线'}`,
            payload.title ? `标题: ${payload.title}` : '',
            payload.character ? `核心角色: ${payload.character}` : '',
            floorText ? `楼层: ${floorText}` : '',
            payload.summary ? `总结内容:\n${payload.summary}` : '',
            payload.unresolved ? `未解决问题:\n${payload.unresolved}` : '',
            payload.remark ? `备注:\n${payload.remark}` : '',
        ]);
    }

    function getSummaryOptimizeTargets(state, options = {}) {
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table) return { table: null, records: [] };
        const selectedIds = new Set((Array.isArray(options.summaryRecordIds) ? options.summaryRecordIds : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean));
        const targetKind = String(options.summaryTarget || options.tableId || 'all');
        const records = stateRecords(state, FIXED_SUMMARY_TABLE_ID)
            .filter((record) => record && !record.hidden)
            .filter((record) => String(record?.values?.总结内容 || record?.values?.summary || '').trim())
            .filter((record) => !selectedIds.size || selectedIds.has(String(record.id || '')))
            .filter((record) => selectedIds.size || targetKind === 'all' || getSummaryRecordKind(record) === targetKind);
        return { table, records };
    }

    function cleanupSmallAutoSummaries(state, range, keepRecordIds = []) {
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        const records = stateRecords(state, FIXED_SUMMARY_TABLE_ID);
        if (!table || !records.length) return 0;
        const target = getRangeMeta(range);
        if (!target) return 0;
        const keepIds = new Set((Array.isArray(keepRecordIds) ? keepRecordIds : [keepRecordIds]).filter(Boolean).map(String));
        let cleanupCount = 0;
        const nextRecords = records.filter((record) => {
            if (keepIds.has(String(record?.id || ''))) return true;
            if (Array.isArray(record?.summarySegments) && record.summarySegments.length) {
                const before = record.summarySegments.length;
                record.summarySegments = record.summarySegments.filter((segment) => {
                    const segmentRange = getSummarySegmentRange(segment);
                    const isCovered = segmentRange
                        && segmentRange.start >= target.start
                        && segmentRange.end <= target.end
                        && segment.summaryType !== 'history'
                        && segment.summaryType !== 'optimize';
                    return !isCovered;
                });
                cleanupCount += before - record.summarySegments.length;
                if (record.summarySegments.length) {
                    syncSummarySegmentsToValues(record);
                    return true;
                }
                if (before !== record.summarySegments.length) return false;
            }
            const task = getSummaryRecordTaskMeta(record);
            const recordRange = getRangeMeta(task?.range) || getSummaryRecordFloorRange(record);
            if (!isSmallSummaryRecord(record, table, task) || !recordRange) return true;
            const covered = recordRange.start >= target.start && recordRange.end <= target.end;
            if (covered) cleanupCount += 1;
            return !covered;
        });
        state.records[table.id] = nextRecords;
        return cleanupCount;
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
            if (table.id === PLOT_SUMMARY_TABLE_ID) {
                const text = plotValuesToText(row.values, row.values?.[getPrimaryColumn(table)] || row.values?.primaryValue || row.table);
                if (!text) return;
                appendPlotSummary(state, text, getPlotKind([row.table, row.values?.kind, row.values?.type, row.values?.分类, row.values?.类别, row.values?.[getPrimaryColumn(table)]].filter(Boolean).join(' ')));
                count += 1;
                return;
            }
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
        const payloads = Array.isArray(result?.payloads) ? result.payloads : [result?.payload].filter(Boolean);
        const validPayloads = payloads.filter((payload) => payload?.summary);
        if (!validPayloads.length) return { ...result, success: false, error: '总结结果缺少 summary/总结内容。' };
        const records = validPayloads.map((payload) => upsertSummaryRecord(state, payload, result?.meta)).filter(Boolean);
        return { ...result, success: true, count: records.length, record: records[0] || null, records };
    }

    function overwriteSummaryRecord(table, record, payload) {
        if (!table || !record || !payload?.summary) return null;
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        const primary = getPrimaryColumn(table);
        record.values[primary] = record.values[primary] || payload.title || (payload.kind === 'branch' ? '支线总结' : '主线总结');
        record.values.核心角色 = payload.kind === 'branch' ? (payload.character || record.values.核心角色 || '') : '';
        record.values.总结内容 = payload.summary;
        record.values.未解决问题 = payload.unresolved || '';
        record.values.备注 = payload.remark || '';
        return record;
    }

    function commitSummaryOptimizeResult(state, result) {
        const targets = Array.isArray(result?.targets) ? result.targets : [];
        const payloads = (Array.isArray(result?.payloads) ? result.payloads : [result?.payload].filter(Boolean)).filter((payload) => payload?.summary);
        if (!payloads.length) return { ...result, success: false, error: '优化结果缺少 summary/总结内容。' };
        const table = stateTables(state).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table) return { ...result, success: false, error: '未找到记忆总结表。' };
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        const records = stateRecords(state, FIXED_SUMMARY_TABLE_ID);
        if (targets.length <= 1) {
            const targetId = String(targets[0]?.id || '');
            const record = records.find((entry) => String(entry?.id || '') === targetId);
            if (!record) return { ...result, success: false, error: '未找到要覆盖的原总结。' };
            const updated = overwriteSummaryRecord(table, record, {
                ...payloads[0],
                kind: payloads[0].kind || targets[0]?.kind || getSummaryRecordKind(record),
            });
            return { ...result, success: true, count: updated ? 1 : 0, record: updated, records: updated ? [updated] : [] };
        }

        const removeIds = new Set(targets.map((target) => String(target?.id || '')).filter(Boolean));
        state.records[FIXED_SUMMARY_TABLE_ID] = records.filter((record) => !removeIds.has(String(record?.id || '')));
        const created = payloads.map((payload) => upsertSummaryRecord(state, payload, { autoTaskType: 'optimize' })).filter(Boolean);
        return { ...result, success: true, count: created.length, record: created[0] || null, records: created, removedCount: removeIds.size };
    }

    function getDefaultTracePrompt(state, options = {}) {
        return `你是记忆表格追溯助手。请阅读聊天记录，提取应该写入记忆表格的信息。
只输出 JSON，不要解释。格式：
{"records":[{"table":"表名或表ID","values":{"字段名":"字段值"}}]}

{{DATABASE_SCHEMA}}`;
    }

    function getDefaultSummaryPrompt() {
        return `你是剧情总结助手。请总结给定聊天范围。
只输出 JSON，不要解释，不要 Markdown。格式：
{"summaries":[{"kind":"main","title":"","summary":"YYYY年MM月DD日,HH:mm-HH:mm [地点] 事件闭环描述","unresolved":"未解决问题","remark":"备注"},{"kind":"branch","title":"","character":"角色名","summary":"YYYY年MM月DD日,HH:mm-HH:mm [地点] 事件闭环描述","unresolved":"未解决问题","remark":"备注"}]}
规则：
1. summaries 可以包含多个对象，用于同时输出主线和多个支线。
2. summary 是记忆总结详情页唯一展示内容；多段剧情用换行分隔，或用字符串数组。
3. 同一天内多段内容只在第一段写 YYYY年MM月DD日，后续同日段落只写 HH:mm-HH:mm；跨天时再写新的日期。
4. kind 只能是 main 或 branch；主线对象不要输出 character 字段。
5. 支线对象必须输出 character，且只能填写一个具体角色名；不要写组织名、势力名、事件名、分类名或多个角色名。
6. 已有支线核心角色：{{BRANCH_SUMMARY_NAMES}}。如果新增支线剧情的核心角色已经在此列表中，character 必须复用列表里的原名字，不要改写成别名、称号或其他近似名字；只有确实是其他具体角色时，才新增新的支线核心角色名。
7. 主线和支线不要记录同一事件。`;
    }

    function getTracePromptFromScheme(scheme) {
        const prompts = scheme?.prompts || {};
        return String(prompts.traceBatch || '');
    }

    function getDefaultOptimizePrompt(kind = 'trace') {
        if (kind === 'summary') {
            return `你是总结优化助手。请整理现有总结，合并重复、修正冲突、补全内容脉络。
只输出 JSON，不要解释，不要 Markdown。
格式：
{"summaries":[{"kind":"main","title":"","summary":"优化后的主线总结正文","unresolved":"未解决问题","remark":"备注"},{"kind":"branch","title":"","character":"角色名","summary":"优化后的支线总结正文","unresolved":"未解决问题","remark":"备注"}]}
规则：
1. 单条优化只输出一个 summaries 对象，kind 必须与原总结一致。
2. 多条合并优化可输出一个或多个 summaries 对象，但必须覆盖被选中旧总结里的关键事实，不要只输出增量差异。
3. 主线对象不要输出 character。
4. 支线对象必须输出 character，且只能填写一个具体角色名；不要写组织名、势力名、事件名、分类名或多个角色名。
5. summary 必须是最终可直接落盘的正文。`;
        }
        return `你是记忆表格优化助手。请整理现有表格内容，合并重复、修正冲突。只输出 JSON，格式同追溯任务。`;
    }

    function getSummaryOptimizeResponseFormatPrompt() {
        return `请按以下格式回复，且只输出 JSON，不要解释，不要 Markdown：
{"summaries":[{"kind":"main","title":"","summary":"优化后的总结正文","unresolved":"未解决问题","remark":"备注"}]}
或：
{"summaries":[{"kind":"branch","title":"","character":"角色名","summary":"优化后的支线总结正文","unresolved":"未解决问题","remark":"备注"}]}
单条优化只输出一个对象；多条合并优化可输出一个或多个对象。summary 必须是最终可直接落盘的正文。支线对象的 character 只能填写一个具体角色名，不要写组织名、势力名、事件名、分类名或多个角色名。`;
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
        const historianPrompt = resolveTaskPromptVariables(scheme?.prompts?.historian || '', state, options);
        const tracePrompt = resolveTaskPromptVariables(getTracePromptFromScheme(scheme) || getDefaultTracePrompt(state, options), state, options);
        const messages = [
            { role: 'system', content: historianPrompt },
            { role: 'system', content: buildRuntimeBackgroundText() },
            { role: 'system', content: `【已归档记忆，仅供参考】\n${tablesToReferenceText(state, options) || '（暂无）'}` },
            { role: 'system', content: buildTaskRangeText(range, 'trace') },
            ...range.messages,
            { role: 'system', content: tracePrompt },
            { role: 'user', content: '请立即根据以上待追溯聊天内容和批量追溯填表提示词执行任务。' },
        ].filter((message) => message.content && message.content.trim());
        return { messages, range };
    }

    function buildSummaryMessages(state, options = {}) {
        const scheme = getActivePromptScheme(state);
        const range = chatMessagesFromRange(options.start, options.end);
        const historianPrompt = resolveTaskPromptVariables(scheme?.prompts?.historian || '', state, {
            ...options,
            suppressMemoryTables: true,
        });
        const summaryPrompt = resolveTaskPromptVariables(scheme?.prompts?.summary || getDefaultSummaryPrompt(), state, {
            ...options,
            suppressMemoryTables: true,
        });
        const messages = [
            { role: 'system', content: historianPrompt },
            { role: 'system', content: buildTaskRangeText(range, 'summary') },
            { role: 'system', content: buildRuntimeBackgroundText({ includeChatSummary: false }) },
            ...range.messages,
            { role: 'system', content: summaryPrompt },
            { role: 'user', content: '请立即根据以上待总结聊天内容和总结提示词执行任务。' },
        ].filter((message) => message.content && message.content.trim());
        return { messages, range };
    }

    async function runTrace(state, options = {}) {
        const built = buildTraceMessages(state, options);
        if (!built.range.messages.length) return { success: false, error: '范围内无有效聊天内容。' };
        const response = await generate(built.messages, { ...options, kind: 'trace' });
        if (!response.success) return response;
        const parsed = parseTraceResponse(response.text);
        const result = { success: true, kind: 'trace', parsed, preview: getTracePreview(parsed), text: response.text, range: built.range };
        return options.previewOnly ? result : commitTraceResult(state, result);
    }

    async function runSummary(state, options = {}) {
        const built = buildSummaryMessages(state, options);
        if (!built.range.messages.length) return { success: false, error: '范围内无有效聊天内容。' };
        const response = await generate(built.messages, { ...options, kind: 'summary' });
        if (!response.success) return response;
        const payloads = parseSummaryResponse(response.text);
        if (!payloads.length) return { success: false, error: '总结结果缺少 summary/总结内容。', text: response.text };
        const result = {
            success: true,
            kind: 'summary',
            payload: payloads[0],
            payloads,
            preview: payloads.map((payload) => getSummaryPreview(payload)).filter(Boolean).join('\n\n'),
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
        const response = await generate(messages, { ...options, kind: 'traceOptimize' });
        if (!response.success) return response;
        const parsed = parseTraceResponse(response.text);
        const result = { success: true, kind: 'trace', parsed, preview: getTracePreview(parsed), text: response.text };
        return options.previewOnly ? result : commitTraceResult(state, result);
    }

    async function runSummaryOptimize(state, options = {}) {
        const targetInfo = getSummaryOptimizeTargets(state, options);
        if (!targetInfo.records.length) return { success: false, error: '没有可优化的总结内容。' };
        const summaries = targetInfo.records
            .map((record, index) => summaryRecordToOptimizeText(targetInfo.table, record, index))
            .filter(Boolean)
            .join('\n\n');
        const note = String(options.note || '').trim();
        const scheme = getActivePromptScheme(state);
        const historianPrompt = resolveTaskPromptVariables(scheme?.prompts?.historian || '', state, {
            ...options,
            suppressMemoryTables: true,
        });
        const schemePrompt = scheme?.prompts?.summaryOptimize;
        const promptSource = note
            ? compactLines([`【本次重点优化建议】\n${note}`, getSummaryOptimizeResponseFormatPrompt()])
            : (schemePrompt || getDefaultOptimizePrompt('summary'));
        const prompt = resolveTaskPromptVariables(promptSource, state, options);
        const messages = [
            { role: 'system', content: historianPrompt },
            { role: 'user', content: `【待优化总结】\n${summaries || '（暂无）'}` },
            { role: 'system', content: prompt },
            { role: 'user', content: '请立即根据以上待优化总结和优化要求输出优化后的 JSON。' },
        ].filter((message) => message.content && message.content.trim());
        const response = await generate(messages, { ...options, kind: 'summaryOptimize' });
        if (!response.success) return response;
        const payloads = parseSummaryResponse(response.text);
        if (!payloads.length) return { success: false, error: '优化结果缺少 summary/总结内容。', text: response.text };
        const result = {
            success: true,
            kind: 'summary',
            payload: payloads[0],
            payloads,
            preview: payloads.map((payload) => getSummaryPreview(payload)).filter(Boolean).join('\n\n'),
            text: response.text,
            targets: targetInfo.records.map((record) => ({
                id: record.id,
                kind: getSummaryRecordKind(record),
                title: String(record?.values?.[getPrimaryColumn(targetInfo.table)] || record?.values?.总结标题 || '').trim(),
                oldPayload: getSummaryRecordPayload(targetInfo.table, record),
                oldText: summaryRecordToOptimizeText(targetInfo.table, record, 0),
            })),
            meta: { autoTaskType: '' },
        };
        return options.previewOnly ? result : commitSummaryOptimizeResult(state, result);
    }

    async function runTagDiagnostic(options = {}) {
        const latest = getLatestAssistantChatMessage();
        if (!latest) return { success: false, error: '未找到聊天记录中的 assistant 回复。' };

        const rawText = String(latest.text || '');
        if (!rawText.includes('<') && !rawText.includes('[')) {
            return {
                success: true,
                noTags: true,
                floor: latest.index,
                rawText,
                blacklist: [],
                whitelist: [],
                reasoning: '最后一条 assistant 回复中未检测到明显的 XML (<>) 或方括号 ([]) 标签格式。',
            };
        }

        const prompt = AI_TAG_DIAGNOSTIC_PROMPT.replace('{{RAW_TEXT}}', rawText);
        const response = await generate([{ role: 'user', content: prompt }], {
            ...options,
            kind: 'tagDiagnostic',
            silent: true,
        });
        if (!response.success) return response;

        const parsed = parseJsonBlock(response.text);
        return {
            success: true,
            floor: latest.index,
            rawText,
            text: response.text,
            reasoning: String(parsed?.reasoning || '').trim(),
            blacklist: normalizeTagList(parsed?.blacklist),
            whitelist: normalizeTagList(parsed?.whitelist),
        };
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
            autoVectorizeAfterHistory: typeof source.autoVectorizeAfterHistory === 'boolean' ? source.autoVectorizeAfterHistory : false,
            hideSummaryFloors: typeof source.hideSummaryFloors === 'boolean' ? source.hideSummaryFloors : false,
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

    function buildAutoTraceTask(pointers, chatLength, settings) {
        if (settings.fillMode !== 'batch' || !settings.traceBatchEnabled) return null;
        const lastIndex = Math.max(0, Number(pointers.trace) || 0);
        const interval = Math.max(1, Number(settings.traceBatchSize) || 40);
        const delay = Math.max(0, Number(settings.traceBatchDelay) || 0);
        const threshold = interval + delay;
        if (chatLength - lastIndex < threshold) return null;
        return {
            type: 'trace',
            pointerKey: 'trace',
            title: '自动批量填表',
            lastIndex,
            currentCount: chatLength,
            interval,
            delay,
            threshold,
            start: lastIndex,
            end: Math.min(lastIndex + interval, chatLength),
        };
    }

    function buildPendingAutoTask(pointers, chatLength, settings, pluginSettings) {
        const traceTask = buildAutoTraceTask(pointers, chatLength, pluginSettings);
        if (traceTask) return traceTask;
        const historyTask = buildAutoTask('history', pointers, chatLength, settings);
        if (historyTask) return historyTask;
        return buildAutoTask('summary', pointers, chatLength, settings);
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
        return window.confirm(`${task?.title || '任务'}已生成结果，是否写入记忆？\n\n${String(result.text || result.preview || '').slice(0, 1000)}`);
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
        if (settings.hideSummaryFloors) {
            committed.hideResult = await YuzukiMemory.FloorHider?.applySummaryPointerHiding?.({
                force: true,
                summaryPointer: pointers.summary,
            });
        }
        if (task.type === 'history') {
            committed.cleanupCount = cleanupSmallAutoSummaries(
                state,
                { start: task.start, end: task.end },
                (Array.isArray(committed.records) ? committed.records : [committed.record]).map((record) => record?.id).filter(Boolean)
            );
            callbacks.saveState?.();
            if (settings.autoVectorizeAfterHistory === true && typeof callbacks.syncSummaryToVectorBook === 'function') {
                try {
                    committed.vectorSyncResult = await callbacks.syncSummaryToVectorBook({ vectorize: true });
                } catch (error) {
                    committed.vectorSyncResult = { success: false, error: String(error?.message || error || '总结同步向量化失败') };
                    console.warn('[yuzuki-Memory] Auto history summary vector sync failed:', error);
                }
            }
        }
        callbacks.saveState?.();
        callbacks.onUpdate?.(committed);
        return committed;
    }

    async function runAutoTraceTask(state, task, callbacks = {}) {
        const result = await runTrace(state, {
            start: task.start,
            end: task.end,
            silent: true,
            previewOnly: false,
            autoTaskType: 'trace',
        });
        if (!result.success) return { ...result, range: result.range || { start: task.start, end: task.end } };

        const pointers = normalizePointers(state);
        pointers.trace = result.range?.end || task.end;
        callbacks.saveState?.();
        callbacks.onUpdate?.(result);
        return result;
    }

    function scheduleAutoSummary(callbacks = {}, delayMs = 800) {
        if (!autoTaskArmed) return;
        window.clearTimeout(autoSummaryTimer);
        autoSummaryTimer = window.setTimeout(async () => {
            if (!autoTaskArmed) return;
            const currentSessionId = getCurrentSessionId();
            const chatLength = getChatLength();
            if (!currentSessionId || currentSessionId !== autoTaskSessionId) {
                refreshAutoTaskBaseline();
                return;
            }
            if (chatLength <= autoTaskBaselineChatLength) {
                autoTaskArmed = false;
                autoTaskBaselineChatLength = chatLength;
                return;
            }
            if (isManualTaskBusy()) {
                autoTaskArmed = false;
                autoTaskBaselineChatLength = chatLength;
                return;
            }
            if (isPluginTaskBusy() || isGenerationBusy() || isChatRequestBusy()) {
                scheduleAutoSummary(callbacks, 2000);
                return;
            }
            const state = callbacks.getState?.();
            if (!state) {
                scheduleAutoSummary(callbacks, 2000);
                return;
            }
            const settings = getAutoSummarySettings();
            const pluginSettings = getPluginSettings();
            const pointers = normalizePointers(state);
            const task = buildPendingAutoTask(pointers, chatLength, settings, pluginSettings);
            if (!task) {
                autoTaskArmed = false;
                autoTaskBaselineChatLength = chatLength;
                return;
            }

            autoSummaryRunning = true;
            let shouldContinueBackfill = false;
            let continueDelay = AUTO_TASK_BACKFILL_NEXT_MS;
            try {
                autoSummaryPromptOpen = task.type === 'trace' ? false : (!settings.directTrigger || !settings.autoSave);
                const result = task.type === 'trace'
                    ? await runAutoTraceTask(state, task, callbacks)
                    : await runAutoSummaryTask(state, task, settings, callbacks);
                if (result?.success === false) {
                    console.warn('[yuzuki-Memory] Auto task skipped:', result.error);
                    notifyAutoTaskFailure(task, result.error);
                    shouldContinueBackfill = true;
                    continueDelay = AUTO_TASK_BACKFILL_RETRY_MS;
                } else if (result?.skipped || result?.postponed) {
                    shouldContinueBackfill = false;
                } else {
                    const latestState = callbacks.getState?.() || state;
                    const latestPointers = normalizePointers(latestState);
                    shouldContinueBackfill = !!buildPendingAutoTask(latestPointers, getChatLength(), settings, pluginSettings);
                }
            } catch (error) {
                console.warn('[yuzuki-Memory] Auto task failed:', error);
                notifyAutoTaskFailure(task, error);
                shouldContinueBackfill = true;
                continueDelay = AUTO_TASK_BACKFILL_RETRY_MS;
            } finally {
                autoSummaryRunning = false;
                autoSummaryPromptOpen = false;
                autoTaskBaselineChatLength = getChatLength();
                if (shouldContinueBackfill) {
                    autoTaskArmed = true;
                    autoTaskBaselineChatLength = Math.max(0, getChatLength() - 1);
                    scheduleAutoSummary(callbacks, continueDelay);
                } else {
                    autoTaskArmed = false;
                }
            }
        }, delayMs);
    }

    function armAutoTaskAfterGeneration(callbacks = {}) {
        const currentSessionId = getCurrentSessionId();
        const chatLength = getChatLength();
        if (!currentSessionId) return;
        if (currentSessionId !== autoTaskSessionId) {
            autoTaskSessionId = currentSessionId;
            autoTaskBaselineChatLength = Math.max(0, chatLength - 1);
        }
        if (chatLength <= autoTaskBaselineChatLength) return;
        if (!isLatestAssistantMessage()) return;
        autoTaskArmed = true;
        scheduleAutoSummary(callbacks);
    }

    function bindAutoSummary(callbacks = {}) {
        if (autoSummaryBound) return;
        autoSummaryBound = true;
        refreshAutoTaskBaseline();
        const ctx = getContext();
        const eventSource = ctx?.eventSource;
        const eventTypes = ctx?.event_types;
        if (eventSource && eventTypes) {
            const onGenerationEnded = () => {
                autoTaskLastGenerationAt = Date.now();
                window.setTimeout(() => armAutoTaskAfterGeneration(callbacks), 300);
            };
            const onCharacterRendered = () => {
                if (Date.now() - autoTaskLastGenerationAt > 10000) return;
                armAutoTaskAfterGeneration(callbacks);
            };
            if (eventTypes.GENERATION_ENDED) eventSource.on?.(eventTypes.GENERATION_ENDED, onGenerationEnded);
            if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on?.(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
        }
        autoTaskSessionPollTimer = window.setInterval(() => {
            const currentSessionId = getCurrentSessionId();
            if (currentSessionId && currentSessionId !== autoTaskSessionId) refreshAutoTaskBaseline();
        }, 1500);
    }

    YuzukiMemory.TaskRunner = Object.assign(YuzukiMemory.TaskRunner || {}, {
        filterContentByTags,
        runTrace,
        runSummary,
        runTraceOptimize,
        runSummaryOptimize,
        runTagDiagnostic,
        commitTraceResult,
        commitSummaryResult,
        commitSummaryOptimizeResult,
        cleanupSmallAutoSummaries,
        bindAutoSummary,
        cancelPendingAutoTask,
    });
})();
