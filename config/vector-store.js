(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const STORAGE_BOOK_NAME = 'Yuzuki_Memory_Vector_Library';
    const ACTIVE_BOOKS_KEY = 'yzm_memory_active_vector_books';
    const BACKUP_HEADER = '=== Yuzuki Memory Vector Library ===';
    const DEFAULT_SEPARATOR = '===';

    class VectorStore {
        constructor() {
            this.library = {};
            this.selectedBookId = '';
            this.isLoaded = false;
            this.hideObserver = null;
            this.vectorCache = new Map();
            this.pendingEmbeddings = new Map();
            this.ready = this.loadLibrary().finally(() => {
                this.isLoaded = true;
                this.hideStorageBookFromUI();
            });
        }

        async whenReady() {
            await this.ready;
            return this;
        }

        getContext() {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
            return null;
        }

        async getCsrfToken() {
            if (typeof window.getRequestHeaders === 'function') {
                const headers = window.getRequestHeaders();
                if (headers?.['X-CSRF-Token']) return headers['X-CSRF-Token'];
            }

            try {
                const response = await fetch('/csrf-token', { credentials: 'include' });
                if (!response.ok) return '';
                const data = await response.json();
                return data?.token || '';
            } catch (_error) {
                return '';
            }
        }

        createId(prefix = 'yzm_book') {
            const random = Math.random().toString(36).slice(2, 9);
            return `${prefix}_${Date.now()}_${random}`;
        }

        normalizeBook(book, fallbackName = '未命名书籍') {
            const chunks = Array.isArray(book?.chunks) ? book.chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean) : [];
            const vectors = Array.isArray(book?.vectors) ? book.vectors : [];
            const vectorized = Array.isArray(book?.vectorized) ? book.vectorized : [];
            return {
                name: String(book?.name || fallbackName).trim() || fallbackName,
                chunks,
                vectors: chunks.map((_chunk, index) => vectors[index] || null),
                vectorized: chunks.map((_chunk, index) => Boolean(vectorized[index])),
                createTime: Number(book?.createTime) || Date.now(),
                updateTime: Number(book?.updateTime) || Date.now(),
            };
        }

        normalizeLibrary(rawLibrary) {
            if (!rawLibrary || typeof rawLibrary !== 'object') return {};
            return Object.fromEntries(Object.entries(rawLibrary)
                .filter(([_id, book]) => book && typeof book === 'object')
                .map(([id, book]) => [String(id), this.normalizeBook(book)]));
        }

        getWorldPayload() {
            return {
                name: STORAGE_BOOK_NAME,
                data: {
                    name: STORAGE_BOOK_NAME,
                    entries: {
                        0: {
                            uid: 0,
                            key: ['DO_NOT_USE'],
                            keysecondary: [],
                            comment: 'Yuzuki Memory 向量数据库，请勿编辑或启用',
                            content: JSON.stringify(this.library),
                            constant: false,
                            vectorized: false,
                            enabled: false,
                            disable: true,
                            position: 0,
                            order: 0,
                            extensions: {
                                position: 0,
                                exclude_recursion: true,
                                display_index: 0,
                                probability: 0,
                                useProbability: false,
                            },
                        },
                    },
                },
            };
        }

        async fetchWorldInfo(path, payload) {
            const token = await this.getCsrfToken();
            return fetch(path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify(payload),
                credentials: 'include',
            });
        }

        async loadLibrary(explicitData = null) {
            if (explicitData && typeof explicitData === 'object') {
                this.library = this.normalizeLibrary(explicitData);
                this.selectedBookId = Object.keys(this.library)[0] || '';
                return this.library;
            }

            try {
                const response = await this.fetchWorldInfo('/api/worldinfo/get', { name: STORAGE_BOOK_NAME });
                if (!response.ok) {
                    this.library = {};
                    return this.library;
                }

                const text = await response.text();
                const bookData = text ? JSON.parse(text) : null;
                const content = bookData?.entries?.['0']?.content || bookData?.entries?.[0]?.content || '';
                this.library = this.normalizeLibrary(content ? JSON.parse(content) : {});
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to load vector library.', error);
                this.library = {};
            }

            this.selectedBookId = Object.keys(this.library)[0] || '';
            return this.library;
        }

        async saveLibrary() {
            try {
                const response = await this.fetchWorldInfo('/api/worldinfo/edit', this.getWorldPayload());
                if (!response.ok) throw new Error(`worldinfo/edit ${response.status}`);
                return true;
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to save vector library.', error);
                return false;
            }
        }

        hideStorageBookFromUI() {
            if (!document.getElementById('yzm-hide-vector-library')) {
                const style = document.createElement('style');
                style.id = 'yzm-hide-vector-library';
                style.textContent = `
                    option[value="${STORAGE_BOOK_NAME}"],
                    li[data-value="${STORAGE_BOOK_NAME}"],
                    [data-name="${STORAGE_BOOK_NAME}"],
                    [data-uid="${STORAGE_BOOK_NAME}"] {
                        display: none !important;
                    }
                `;
                document.head.appendChild(style);
            }

            const hideMatches = () => {
                document.querySelectorAll('option, li, .world_info_entry, label').forEach((node) => {
                    let shouldHide = false;

                    if (
                        node.value === STORAGE_BOOK_NAME ||
                        node.getAttribute('data-uid') === STORAGE_BOOK_NAME ||
                        node.getAttribute('data-name') === STORAGE_BOOK_NAME ||
                        node.getAttribute('data-value') === STORAGE_BOOK_NAME ||
                        node.title === STORAGE_BOOK_NAME
                    ) {
                        shouldHide = true;
                    } else if ((node.textContent || '').includes(STORAGE_BOOK_NAME)) {
                        if (
                            node.classList.contains('inline-drawer-header') ||
                            node.classList.contains('binder-header')
                        ) {
                            return;
                        }

                        if (node.querySelector('ul, ol')) {
                            return;
                        }

                        shouldHide = true;
                    }

                    if (shouldHide && node.style.display !== 'none') {
                        node.style.display = 'none';
                        node.style.setProperty('display', 'none', 'important');
                    }
                });
            };

            hideMatches();
            if (this.hideObserver || !document.body) return;
            this.hideObserver = new MutationObserver(hideMatches);
            this.hideObserver.observe(document.body, { childList: true, subtree: true });
        }

        getActiveBooks() {
            const metadata = this.getContext()?.chatMetadata;
            const activeBooks = metadata?.[ACTIVE_BOOKS_KEY] || [];
            return [...new Set(Array.isArray(activeBooks) ? activeBooks.filter((id) => this.library[id]) : [])];
        }

        setActiveBooks(bookIds) {
            const context = this.getContext();
            if (!context) return false;
            context.chatMetadata = context.chatMetadata || {};
            context.chatMetadata[ACTIVE_BOOKS_KEY] = [...new Set(Array.isArray(bookIds) ? bookIds : [])].filter((id) => this.library[id]);

            if (typeof context.saveMetadata === 'function') {
                context.saveMetadata();
            } else if (typeof window.saveMetadataDebounced === 'function') {
                window.saveMetadataDebounced();
            } else if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
            return true;
        }

        selectBook(bookId) {
            this.selectedBookId = this.library[bookId] ? bookId : '';
            return this.selectedBookId;
        }

        toggleActiveBook(bookId, isActive) {
            const activeBooks = this.getActiveBooks();
            const nextBooks = isActive
                ? [...activeBooks, bookId]
                : activeBooks.filter((id) => id !== bookId);
            this.setActiveBooks(nextBooks);
        }

        getBook(bookId = this.selectedBookId) {
            return this.library[bookId] || null;
        }

        getBookStats(book) {
            const total = Array.isArray(book?.chunks) ? book.chunks.length : 0;
            const done = Array.isArray(book?.vectorized) ? book.vectorized.filter(Boolean).length : 0;
            const progress = total ? Math.round((done / total) * 100) : 0;
            const status = total === 0 ? 'pending' : (done >= total ? 'done' : (done > 0 ? 'running' : 'pending'));
            return { total, done, progress, status };
        }

        listBooks() {
            const activeBooks = this.getActiveBooks();
            return Object.entries(this.library).map(([id, book]) => {
                const stats = this.getBookStats(book);
                return {
                    id,
                    name: book.name,
                    entries: stats.total,
                    vectorizedCount: stats.done,
                    progress: stats.progress,
                    status: stats.status,
                    selected: id === this.selectedBookId,
                    active: activeBooks.includes(id),
                    createTime: book.createTime,
                    updateTime: book.updateTime,
                };
            }).sort((a, b) => b.updateTime - a.updateTime);
        }

        async createBook(name = '未命名书籍') {
            const id = this.createId();
            this.library[id] = this.normalizeBook({ name, chunks: [] }, name);
            this.selectedBookId = id;
            await this.saveLibrary();
            return id;
        }

        async renameBook(bookId, name) {
            const book = this.library[bookId];
            const nextName = String(name || '').trim();
            if (!book || !nextName) return false;
            book.name = nextName;
            book.updateTime = Date.now();
            await this.saveLibrary();
            return true;
        }

        splitText(text, separator = DEFAULT_SEPARATOR) {
            const source = String(text || '');
            const parts = separator === '\\n' || separator === '\n'
                ? source.split(/\n+/)
                : source.split(separator);
            return parts.map((part) => part.trim()).filter(Boolean);
        }

        async setBookChunks(bookId, chunks) {
            const book = this.library[bookId];
            if (!book) return false;
            const nextChunks = chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean);
            const previousVectors = new Map();
            book.chunks.forEach((chunk, index) => {
                if (book.vectorized[index] && Array.isArray(book.vectors[index])) {
                    previousVectors.set(chunk, book.vectors[index]);
                }
            });
            book.chunks = nextChunks;
            book.vectors = nextChunks.map((chunk) => previousVectors.get(chunk) || null);
            book.vectorized = nextChunks.map((chunk) => previousVectors.has(chunk));
            book.updateTime = Date.now();
            await this.saveLibrary();
            return true;
        }

        async importBook(file, customName = '') {
            const text = await this.readFile(file);
            const chunks = this.splitText(text);
            const name = String(customName || file?.name || '未命名书籍').replace(/\.[^.]+$/, '').trim() || '未命名书籍';
            const id = this.createId();
            this.library[id] = this.normalizeBook({ name, chunks }, name);
            this.selectedBookId = id;
            await this.saveLibrary();
            return { success: true, bookId: id, count: chunks.length };
        }

        async syncSummaryToBook(chunks, sessionId = 'default') {
            const normalizedChunks = Array.isArray(chunks) ? chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean) : [];
            if (!normalizedChunks.length) return { success: false, count: 0, error: '总结内容为空' };

            const id = `yzm_summary_book_${String(sessionId || 'default').replace(/[^\w-]/g, '_')}`;
            const oldBook = this.library[id];
            const oldVectors = new Map();
            if (oldBook) {
                oldBook.chunks.forEach((chunk, index) => {
                    if (oldBook.vectorized[index] && oldBook.vectors[index]) oldVectors.set(chunk, oldBook.vectors[index]);
                });
            }

            const vectors = [];
            const vectorized = [];
            normalizedChunks.forEach((chunk) => {
                if (oldVectors.has(chunk)) {
                    vectors.push(oldVectors.get(chunk));
                    vectorized.push(true);
                } else {
                    vectors.push(null);
                    vectorized.push(false);
                }
            });

            this.library[id] = this.normalizeBook({
                name: oldBook?.name || '剧情总结归档',
                chunks: normalizedChunks,
                vectors,
                vectorized,
                createTime: oldBook?.createTime || Date.now(),
                updateTime: Date.now(),
            }, '剧情总结归档');
            this.selectedBookId = id;
            await this.saveLibrary();
            this.toggleActiveBook(id, true);
            return { success: true, bookId: id, count: normalizedChunks.length };
        }

        hashText(text) {
            const source = String(text || '');
            let hash = 0;
            for (let index = 0; index < source.length; index += 1) {
                hash = ((hash << 5) - hash) + source.charCodeAt(index);
                hash |= 0;
            }
            return `${source.length}_${hash.toString(36)}`;
        }

        async getEmbedding(text) {
            const source = String(text || '').trim();
            if (!source) throw new Error('向量化文本为空');
            const cacheKey = this.hashText(source);
            if (this.vectorCache.has(cacheKey)) return this.vectorCache.get(cacheKey);
            if (this.pendingEmbeddings.has(cacheKey)) return this.pendingEmbeddings.get(cacheKey);
            const request = YuzukiMemory.EmbeddingClient.embed(source);
            this.pendingEmbeddings.set(cacheKey, request);
            try {
                const vector = await request;
                this.vectorCache.set(cacheKey, vector);
                return vector;
            } finally {
                this.pendingEmbeddings.delete(cacheKey);
            }
        }

        async vectorizeBook(bookId = this.selectedBookId, progressCallback = null) {
            await this.whenReady();
            const book = this.library[bookId];
            if (!book) throw new Error('向量书不存在');
            const pending = book.chunks
                .map((chunk, index) => ({ chunk, index }))
                .filter(({ index }) => !book.vectorized[index] || !Array.isArray(book.vectors[index]));
            if (!pending.length) return { success: true, count: 0, errors: 0 };

            let success = 0;
            let errors = 0;
            let batchSize = 10;
            for (let cursor = 0; cursor < pending.length; cursor += batchSize) {
                const batchStart = cursor;
                const batch = pending.slice(cursor, cursor + batchSize);
                try {
                    progressCallback?.(Math.min(cursor + batch.length, pending.length), pending.length);
                    const vectors = await YuzukiMemory.EmbeddingClient.embed(batch.map((item) => item.chunk));
                    batch.forEach((item, offset) => {
                        const vector = vectors[offset];
                        if (Array.isArray(vector)) {
                            book.vectors[item.index] = vector;
                            book.vectorized[item.index] = true;
                            success += 1;
                        } else {
                            errors += 1;
                        }
                    });
                    if (success % 50 === 0) await this.saveLibrary();
                } catch (error) {
                    const message = String(error?.message || error || '');
                    if (/429|rate|limit/i.test(message) && batchSize > 1) {
                        batchSize = Math.max(1, Math.floor(batchSize / 2));
                        cursor = batchStart - batchSize;
                        await new Promise((resolve) => setTimeout(resolve, 10000));
                        continue;
                    }
                    errors += batch.length;
                    console.warn('[yuzuki-Memory] Vectorize batch failed.', error);
                }
            }
            book.updateTime = Date.now();
            await this.saveLibrary();
            return { success: true, count: success, errors };
        }

        cosineSimilarity(vecA, vecB) {
            if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
            let dot = 0;
            let normA = 0;
            let normB = 0;
            for (let index = 0; index < vecA.length; index += 1) {
                dot += vecA[index] * vecB[index];
                normA += vecA[index] * vecA[index];
                normB += vecB[index] * vecB[index];
            }
            if (!normA || !normB) return 0;
            return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        }

        searchEntityBoost(query, text) {
            const source = String(text || '');
            const pattern = /(?:姓名|名字|角色|Name|地点|位置|场景|Location|Place|物品|道具|装备|Item|Object|组织|势力|Organization|Group|设定|概念|Concept)[:：]\s*([^\s\n，,。.;；]+)/ig;
            let match;
            while ((match = pattern.exec(source)) !== null) {
                const entity = String(match[1] || '').trim();
                if (entity.length > 1 && query.includes(entity)) return 0.15;
            }
            if (query.length < 15 && source.includes(query)) return 0.15;
            return 0;
        }

        async search(query, allowedBookIds = null) {
            await this.whenReady();
            const settings = YuzukiMemory.EmbeddingClient.loadSettings();
            if (!settings.enabled) return [];
            const rerankSettings = YuzukiMemory.RerankClient?.loadSettings?.() || { enabled: false };
            const sourceQuery = String(query || '').trim();
            if (!sourceQuery) return [];
            const bookIds = Array.isArray(allowedBookIds) ? allowedBookIds : this.getActiveBooks();
            if (!bookIds.length) return [];
            const targetCount = Math.max(1, Number.parseInt(settings.recallLimit, 10) || 6);
            const recallCount = rerankSettings.enabled ? targetCount * 2 : targetCount;
            const initialThreshold = rerankSettings.enabled ? 0.1 : settings.threshold;

            const queryVector = await this.getEmbedding(sourceQuery.slice(-6000));
            const seen = new Set();
            const results = [];
            bookIds.forEach((bookId) => {
                const book = this.library[bookId];
                if (!book) return;
                book.chunks.forEach((chunk, index) => {
                    const vector = book.vectors[index];
                    if (!book.vectorized[index] || !Array.isArray(vector) || seen.has(chunk)) return;
                    seen.add(chunk);
                    const score = this.cosineSimilarity(queryVector, vector) + this.searchEntityBoost(sourceQuery, chunk);
                    if (score >= initialThreshold) {
                        results.push({
                            text: chunk,
                            score,
                            source: `${book.name} #${index + 1}`,
                        });
                    }
                });
            });
            const candidates = results
                .sort((a, b) => b.score - a.score)
                .slice(0, recallCount);

            if (rerankSettings.enabled && candidates.length && YuzukiMemory.RerankClient?.rerank) {
                try {
                    const scores = await YuzukiMemory.RerankClient.rerank(
                        sourceQuery,
                        candidates.map((item) => item.text),
                        rerankSettings,
                        { topN: targetCount }
                    );
                    if (Array.isArray(scores) && scores.length === candidates.length) {
                        candidates.forEach((item, index) => {
                            item.originalScore = item.score;
                            item.rerankScore = scores[index];
                            item.score = scores[index];
                        });
                        candidates.sort((a, b) => b.score - a.score);
                    }
                } catch (error) {
                    console.warn('[yuzuki-Memory] Rerank skipped, using vector order.', error);
                }
            }

            const finalThreshold = rerankSettings.enabled ? 0.001 : settings.threshold;
            return candidates
                .filter((item) => item.score >= finalThreshold)
                .slice(0, targetCount);
        }

        async deleteBook(bookId) {
            if (!this.library[bookId]) return false;
            delete this.library[bookId];
            this.setActiveBooks(this.getActiveBooks().filter((id) => id !== bookId));
            if (this.selectedBookId === bookId) this.selectedBookId = Object.keys(this.library)[0] || '';
            await this.saveLibrary();
            return true;
        }

        async clearAllBooks() {
            this.library = {};
            this.selectedBookId = '';
            this.setActiveBooks([]);
            await this.saveLibrary();
        }

        readFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (event) => resolve(String(event.target?.result || ''));
                reader.onerror = reject;
                reader.readAsText(file, 'UTF-8');
            });
        }

        exportLibrary(bookIds = null) {
            const ids = Array.isArray(bookIds) && bookIds.length ? bookIds : Object.keys(this.library);
            const data = Object.fromEntries(ids.filter((id) => this.library[id]).map((id) => [id, this.library[id]]));
            return [
                BACKUP_HEADER,
                JSON.stringify({
                    version: 1,
                    exportedAt: Date.now(),
                    storage: STORAGE_BOOK_NAME,
                    library: data,
                }, null, 2),
            ].join('\n');
        }

        async importLibrary(fileOrText) {
            const text = typeof fileOrText === 'string' ? fileOrText : await this.readFile(fileOrText);
            const jsonText = text.startsWith(BACKUP_HEADER) ? text.slice(BACKUP_HEADER.length).trim() : text.trim();
            const parsed = JSON.parse(jsonText);
            const nextLibrary = this.normalizeLibrary(parsed.library || parsed);
            Object.assign(this.library, nextLibrary);
            this.selectedBookId = Object.keys(nextLibrary)[0] || this.selectedBookId;
            await this.saveLibrary();
            return { success: true, bookCount: Object.keys(nextLibrary).length };
        }

        downloadBackup(bookIds = null) {
            const content = this.exportLibrary(bookIds);
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `yuzuki_vector_library_${Date.now()}.txt`;
            anchor.click();
            URL.revokeObjectURL(url);
        }
    }

    YuzukiMemory.VectorStore = new VectorStore();
})();
