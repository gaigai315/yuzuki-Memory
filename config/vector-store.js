(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const STORAGE_BOOK_NAME = 'Yuzuki_Memory_Vector_Library';
    const LEGACY_STORAGE_BOOK_NAME = 'Memory_Vector_Database';
    const STORAGE_BOOK_NAMES = [STORAGE_BOOK_NAME, LEGACY_STORAGE_BOOK_NAME];
    const STORAGE_EXTENSION_KEY = 'yuzuki_memory_vector_library';
    const STORAGE_FORMAT_VERSION = 2;
    const STORAGE_ENTRY_CONTENT = 'Yuzuki Memory 内部向量数据存储，请勿启用或编辑。';
    const VECTOR_STORAGE_ENCODING = 'float32-base64';
    const ACTIVE_BOOKS_KEY = 'yzm_memory_active_vector_books';
    const LEGACY_ACTIVE_BOOKS_KEY = 'gaigai_activeBooks';
    const BACKUP_HEADER = '=== Yuzuki Memory Vector Library ===';
    const LEGACY_BACKUP_HEADER = '=== Gaigai 向量缓存文件 (图书馆版) ===';
    const LEGACY_LIBRARY_MARKER = '>>> 图书馆 <<<';
    const DEFAULT_SEPARATOR = '===';
    const BOOK_KIND_SUMMARY = 'summary';
    const BOOK_KIND_CHARACTER_PROFILE = 'character_profile';
    const BOOK_KIND_WORLD_SETTING = 'world_setting';
    const MAX_VECTOR_CHUNK_CHARS = 4000;
    const VECTOR_CHUNK_OVERLAP_CHARS = 180;
    const MAX_VECTOR_BATCH_CHARS = 16000;
    const MAX_QUERY_VECTOR_CACHE_ENTRIES = 96;
    const HELPER_API_SHIELD_KEY = '__yzmMemoryStorageBookShield';
    const HELPER_API_SHIELD_SOURCE_KEY = '__yzmMemoryStorageBookShieldSource';
    const HELPER_API_SHIELD_POLL_MS = 5000;

    class VectorStore {
        constructor() {
            this.library = {};
            this.selectedBookId = '';
            this.storageBookName = STORAGE_BOOK_NAME;
            this.storageMigrationPending = false;
            this.isLoaded = false;
            this.hideObserver = null;
            this.helperApiShieldTimer = null;
            this.vectorCache = new Map();
            this.encodedVectorCache = new WeakMap();
            this.pendingEmbeddings = new Map();
            this.saveRequestedSerial = 0;
            this.saveCompletedSerial = 0;
            this.saveLoopRunning = false;
            this.saveWaiters = [];
            this.installStorageBookApiShield();
            this.ready = this.loadLibrary()
                .then(async (library) => {
                    if (this.storageMigrationPending) {
                        const migrated = await this.saveLibrary();
                        if (migrated) {
                            this.storageMigrationPending = false;
                            console.info('[yuzuki-Memory] Vector library storage upgraded to compact worldbook metadata.');
                        }
                    }
                    return library;
                })
                .finally(() => {
                    this.isLoaded = true;
                    this.hideStorageBookFromUI();
                    this.installStorageBookApiShield();
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

        getChatMetadataForWrite(context = this.getContext()) {
            if (!context) return null;
            const metadata = context.chatMetadata;
            if (metadata && typeof metadata === 'object') return metadata;
            if (window.chat_metadata && typeof window.chat_metadata === 'object') return window.chat_metadata;

            try {
                context.chatMetadata = {};
                return context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : null;
            } catch (error) {
                console.warn('[yuzuki-Memory] Chat metadata is not assignable in this SillyTavern build.', error);
                return null;
            }
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

        encodeVectorForStorage(vector) {
            if (!Array.isArray(vector) || !vector.length) return null;
            const cached = this.encodedVectorCache.get(vector);
            if (cached) return cached;

            const buffer = new ArrayBuffer(vector.length * Float32Array.BYTES_PER_ELEMENT);
            const view = new DataView(buffer);
            vector.forEach((value, index) => {
                view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, Number(value) || 0, true);
            });
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const batchSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += batchSize) {
                binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize));
            }
            const encoded = {
                encoding: VECTOR_STORAGE_ENCODING,
                dimension: vector.length,
                data: btoa(binary),
            };
            this.encodedVectorCache.set(vector, encoded);
            return encoded;
        }

        decodeStoredVector(value) {
            if (Array.isArray(value)) return value;
            if (!value || typeof value !== 'object' || value.encoding !== VECTOR_STORAGE_ENCODING || !value.data) return null;
            try {
                const binary = atob(String(value.data));
                const byteLength = binary.length - (binary.length % Float32Array.BYTES_PER_ELEMENT);
                const bytes = new Uint8Array(byteLength);
                for (let index = 0; index < byteLength; index += 1) bytes[index] = binary.charCodeAt(index);
                const view = new DataView(bytes.buffer);
                const vector = Array.from(
                    { length: byteLength / Float32Array.BYTES_PER_ELEMENT },
                    (_unused, index) => view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true)
                );
                const expectedDimension = Math.max(0, Number.parseInt(value.dimension, 10) || 0);
                return expectedDimension && vector.length !== expectedDimension ? null : vector;
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to decode stored vector.', error);
                return null;
            }
        }

        normalizeBook(book, fallbackName = '未命名书籍') {
            const chunks = Array.isArray(book?.chunks) ? book.chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean) : [];
            const vectors = Array.isArray(book?.vectors) ? book.vectors : [];
            const vectorized = Array.isArray(book?.vectorized) ? book.vectorized : [];
            const normalizedVectors = chunks.map((_chunk, index) => this.decodeStoredVector(vectors[index]));
            return {
                name: String(book?.name || fallbackName).trim() || fallbackName,
                kind: String(book?.kind || '').trim(),
                sessionId: String(book?.sessionId || '').trim(),
                chunks,
                vectors: normalizedVectors,
                vectorized: chunks.map((_chunk, index) => Boolean(vectorized[index] && Array.isArray(normalizedVectors[index]))),
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

        encodeLibraryForStorage() {
            return Object.fromEntries(Object.entries(this.library).map(([id, book]) => [id, {
                ...book,
                vectors: Array.isArray(book?.vectors)
                    ? book.vectors.map((vector) => this.encodeVectorForStorage(vector))
                    : [],
            }]));
        }

        readLibraryFromWorldbook(bookData) {
            const extensionPayload = bookData?.extensions?.[STORAGE_EXTENSION_KEY]
                ?? bookData?.[STORAGE_EXTENSION_KEY];
            if (extensionPayload && typeof extensionPayload === 'object') {
                const rawLibrary = extensionPayload.library && typeof extensionPayload.library === 'object'
                    ? extensionPayload.library
                    : extensionPayload;
                return { library: rawLibrary, legacy: false };
            }

            const content = bookData?.entries?.['0']?.content || bookData?.entries?.[0]?.content || '';
            if (!content) return { library: {}, legacy: false };
            return { library: JSON.parse(content), legacy: true };
        }

        getWorldPayload() {
            const storageBookName = this.storageBookName || STORAGE_BOOK_NAME;
            return {
                name: storageBookName,
                data: {
                    name: storageBookName,
                    // Worldbook helper tools fingerprint entry content; keep vectors in namespaced metadata.
                    entries: {
                        0: {
                            uid: 0,
                            key: ['DO_NOT_USE'],
                            keysecondary: [],
                            comment: 'Yuzuki Memory 向量数据库，请勿编辑或启用',
                            content: STORAGE_ENTRY_CONTENT,
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
                    extensions: {
                        [STORAGE_EXTENSION_KEY]: {
                            format: STORAGE_EXTENSION_KEY,
                            version: STORAGE_FORMAT_VERSION,
                            library: this.encodeLibraryForStorage(),
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

        getKnownWorldbookNames() {
            const names = new Set();
            const add = (value) => {
                const text = String(value || '').trim().replace(/\.json$/i, '');
                if (text) names.add(text);
            };
            try {
                if (Array.isArray(window.world_names)) window.world_names.forEach(add);
                if (Array.isArray(window.worldNames)) window.worldNames.forEach(add);
                if (window.world_info && typeof window.world_info === 'object') Object.keys(window.world_info).forEach(add);
                document.querySelectorAll('#world_info option, #world_editor_select option').forEach((option) => {
                    add(option?.value);
                    add(option?.textContent);
                });
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to inspect worldbook names before vector library load.', error);
            }
            return names;
        }

        getExistingStorageBookName() {
            const names = this.getKnownWorldbookNames();
            return STORAGE_BOOK_NAMES.find((name) => names.has(name)) || '';
        }

        async loadLibrary(explicitData = null) {
            if (explicitData && typeof explicitData === 'object') {
                this.library = this.normalizeLibrary(explicitData);
                this.selectedBookId = Object.keys(this.library)[0] || '';
                return this.library;
            }

            try {
                const detectedBookName = this.getExistingStorageBookName();
                const candidates = [...new Set([detectedBookName, ...STORAGE_BOOK_NAMES].filter(Boolean))];
                let loaded = false;
                for (const storageBookName of candidates) {
                    try {
                        const response = await this.fetchWorldInfo('/api/worldinfo/get', { name: storageBookName });
                        if (!response.ok) continue;
                        const text = await response.text();
                        const bookData = text ? JSON.parse(text) : null;
                        const stored = this.readLibraryFromWorldbook(bookData);
                        this.storageBookName = storageBookName;
                        this.library = this.normalizeLibrary(stored.library);
                        this.storageMigrationPending = stored.legacy;
                        loaded = true;
                        break;
                    } catch (error) {
                        console.warn(`[yuzuki-Memory] Failed to inspect vector storage book: ${storageBookName}`, error);
                    }
                }

                if (!loaded) {
                    this.storageBookName = STORAGE_BOOK_NAME;
                    this.library = {};
                    this.selectedBookId = '';
                    return this.library;
                }
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to load vector library.', error);
                this.library = {};
            }

            this.selectedBookId = Object.keys(this.library)[0] || '';
            return this.library;
        }

        async writeLibrarySnapshot() {
            try {
                const response = await this.fetchWorldInfo('/api/worldinfo/edit', this.getWorldPayload());
                if (!response.ok) throw new Error(`worldinfo/edit ${response.status}`);
                return true;
            } catch (error) {
                console.warn('[yuzuki-Memory] Failed to save vector library.', error);
                return false;
            }
        }

        resolveSaveWaiters(serial, success) {
            const pending = [];
            this.saveWaiters.forEach((waiter) => {
                if (waiter.serial <= serial) waiter.resolve(success);
                else pending.push(waiter);
            });
            this.saveWaiters = pending;
        }

        scheduleSaveLoop() {
            if (this.saveLoopRunning) return;
            this.saveLoopRunning = true;
            Promise.resolve().then(async () => {
                try {
                    while (this.saveCompletedSerial < this.saveRequestedSerial) {
                        const targetSerial = this.saveRequestedSerial;
                        const success = await this.writeLibrarySnapshot();
                        this.saveCompletedSerial = targetSerial;
                        this.resolveSaveWaiters(targetSerial, success);
                    }
                } finally {
                    this.saveLoopRunning = false;
                    if (this.saveCompletedSerial < this.saveRequestedSerial) this.scheduleSaveLoop();
                }
            }).catch((error) => {
                console.warn('[yuzuki-Memory] Vector library save queue failed.', error);
                const failedSerial = this.saveRequestedSerial;
                this.saveCompletedSerial = failedSerial;
                this.resolveSaveWaiters(failedSerial, false);
                this.saveLoopRunning = false;
            });
        }

        saveLibrary() {
            const serial = ++this.saveRequestedSerial;
            const result = new Promise((resolve) => {
                this.saveWaiters.push({ serial, resolve });
            });
            this.scheduleSaveLoop();
            return result;
        }

        isStorageBookName(value) {
            return STORAGE_BOOK_NAMES.includes(String(value || '').trim());
        }

        filterStorageBookNames(value) {
            if (Array.isArray(value)) return value.filter((name) => !this.isStorageBookName(name));
            if (value instanceof Set) return new Set([...value].filter((name) => !this.isStorageBookName(name)));
            return value;
        }

        markShieldedFunction(wrapper, source) {
            try {
                Object.defineProperty(wrapper, HELPER_API_SHIELD_KEY, { value: true, configurable: true });
                Object.defineProperty(wrapper, HELPER_API_SHIELD_SOURCE_KEY, { value: source, configurable: true });
            } catch (_error) {
                wrapper[HELPER_API_SHIELD_KEY] = true;
                wrapper[HELPER_API_SHIELD_SOURCE_KEY] = source;
            }
            return wrapper;
        }

        installFunctionShield(name, createWrapper) {
            const current = window[name];
            if (typeof current !== 'function' || current[HELPER_API_SHIELD_KEY]) return false;
            try {
                window[name] = this.markShieldedFunction(createWrapper(current), current);
                return window[name]?.[HELPER_API_SHIELD_KEY] === true;
            } catch (error) {
                console.warn(`[yuzuki-Memory] Failed to shield ${name} from storage vector book.`, error);
                return false;
            }
        }

        installStorageBookApiShield() {
            if (typeof window === 'undefined') return;
            const installedNames = this.installFunctionShield('getWorldbookNames', (original) => function yzmGetWorldbookNames(...args) {
                const result = original.apply(this, args);
                return YuzukiMemory.VectorStore?.filterStorageBookNames?.(result) || result;
            });
            const installedBook = this.installFunctionShield('getWorldbook', (original) => function yzmGetWorldbook(name, ...args) {
                if (YuzukiMemory.VectorStore?.isStorageBookName?.(name)) return [];
                return original.apply(this, [name, ...args]);
            });

            if (installedNames || installedBook) {
                console.info('[yuzuki-Memory] Hidden vector storage book from helper worldbook APIs.', {
                    names: STORAGE_BOOK_NAMES,
                    getWorldbookNames: window.getWorldbookNames?.[HELPER_API_SHIELD_KEY] === true,
                    getWorldbook: window.getWorldbook?.[HELPER_API_SHIELD_KEY] === true,
                });
            }

            if (this.helperApiShieldTimer) return;
            this.helperApiShieldTimer = window.setInterval(() => {
                this.installStorageBookApiShield();
            }, HELPER_API_SHIELD_POLL_MS);
        }

        hideStorageBookFromUI() {
            if (!document.getElementById('yzm-hide-vector-library')) {
                const style = document.createElement('style');
                style.id = 'yzm-hide-vector-library';
                style.textContent = STORAGE_BOOK_NAMES.map((name) => `
                    option[value="${name}"],
                    li[data-value="${name}"],
                    [data-name="${name}"],
                    [data-uid="${name}"] {
                        display: none !important;
                    }
                `).join('\n');
                document.head.appendChild(style);
            }

            const matchesStorageBookName = (value) => this.isStorageBookName(value);
            const hideMatches = () => {
                document.querySelectorAll('option, li, .world_info_entry, label').forEach((node) => {
                    let shouldHide = false;

                    if (
                        matchesStorageBookName(node.value) ||
                        matchesStorageBookName(node.getAttribute('data-uid')) ||
                        matchesStorageBookName(node.getAttribute('data-name')) ||
                        matchesStorageBookName(node.getAttribute('data-value')) ||
                        matchesStorageBookName(node.title)
                    ) {
                        shouldHide = true;
                    } else if (STORAGE_BOOK_NAMES.some((name) => (node.textContent || '').includes(name))) {
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
            const activeBooks = Array.isArray(metadata?.[ACTIVE_BOOKS_KEY])
                ? metadata[ACTIVE_BOOKS_KEY]
                : (metadata?.[LEGACY_ACTIVE_BOOKS_KEY] || []);
            return [...new Set(Array.isArray(activeBooks) ? activeBooks.filter((id) => this.library[id]) : [])];
        }

        setActiveBooks(bookIds) {
            const context = this.getContext();
            if (!context) return false;
            const metadata = this.getChatMetadataForWrite(context);
            if (!metadata) return false;
            metadata[ACTIVE_BOOKS_KEY] = [...new Set(Array.isArray(bookIds) ? bookIds : [])].filter((id) => this.library[id]);

            if (typeof context.saveChat === 'function') {
                context.saveChat();
            } else if (typeof context.saveMetadata === 'function') {
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
            const currentlyActive = activeBooks.includes(bookId);
            if (currentlyActive === Boolean(isActive)) return true;
            const nextBooks = isActive
                ? [...activeBooks, bookId]
                : activeBooks.filter((id) => id !== bookId);
            return this.setActiveBooks(nextBooks);
        }

        getBook(bookId = this.selectedBookId) {
            return this.library[bookId] || null;
        }

        getBookStats(book) {
            const total = Array.isArray(book?.chunks) ? book.chunks.length : 0;
            const done = Array.isArray(book?.vectorized) ? book.vectorized.filter(Boolean).length : 0;
            const dimension = Array.isArray(book?.vectors)
                ? (book.vectors.find((vector) => Array.isArray(vector) && vector.length)?.length || 0)
                : 0;
            const progress = total ? Math.round((done / total) * 100) : 0;
            const status = total === 0 ? 'pending' : (done >= total ? 'done' : (done > 0 ? 'running' : 'pending'));
            return { total, done, dimension, progress, status };
        }

        listBooks() {
            const activeBooks = this.getActiveBooks();
            const activeOrder = new Map(activeBooks.map((id, index) => [id, index]));
            return Object.entries(this.library).map(([id, book]) => {
                const stats = this.getBookStats(book);
                return {
                    id,
                    name: book.name,
                    entries: stats.total,
                    vectorizedCount: stats.done,
                    dimension: stats.dimension,
                    progress: stats.progress,
                    status: stats.status,
                    selected: id === this.selectedBookId,
                    active: activeBooks.includes(id),
                    kind: book.kind || '',
                    sessionId: book.sessionId || '',
                    createTime: book.createTime,
                    updateTime: book.updateTime,
                };
            }).sort((a, b) => {
                if (a.active !== b.active) return a.active ? -1 : 1;
                if (a.active && b.active) {
                    return (activeOrder.get(a.id) ?? 0) - (activeOrder.get(b.id) ?? 0);
                }
                return b.updateTime - a.updateTime;
            });
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
            if (book.name === nextName) return true;
            book.name = nextName;
            book.updateTime = Date.now();
            await this.saveLibrary();
            return true;
        }

        splitLongTextPart(text, maxChars = MAX_VECTOR_CHUNK_CHARS, overlapChars = VECTOR_CHUNK_OVERLAP_CHARS) {
            const source = String(text || '').trim();
            if (!source) return [];
            if (source.length <= maxChars) return [source];

            const chunks = [];
            let current = '';
            const paragraphs = source
                .replace(/\r\n/g, '\n')
                .split(/\n{2,}/)
                .map((part) => part.trim())
                .filter(Boolean);
            const units = paragraphs.length > 1
                ? paragraphs
                : source.replace(/([。！？!?；;])/g, '$1\n').split(/\n+/).map((part) => part.trim()).filter(Boolean);

            const pushCurrent = () => {
                const value = current.trim();
                if (value) chunks.push(value);
                current = '';
            };

            const appendUnit = (unit) => {
                const value = String(unit || '').trim();
                if (!value) return;
                if (value.length > maxChars) {
                    pushCurrent();
                    for (let cursor = 0; cursor < value.length; cursor += Math.max(1, maxChars - overlapChars)) {
                        chunks.push(value.slice(cursor, cursor + maxChars).trim());
                    }
                    return;
                }
                const separator = current ? '\n\n' : '';
                if ((current.length + separator.length + value.length) > maxChars) {
                    pushCurrent();
                }
                current = current ? `${current}${separator}${value}` : value;
            };

            units.forEach(appendUnit);
            pushCurrent();
            return chunks.filter(Boolean);
        }

        normalizeChunks(chunks) {
            const source = Array.isArray(chunks) ? chunks : [chunks];
            return source.flatMap((chunk) => this.splitLongTextPart(chunk)).filter(Boolean);
        }

        areChunksEqual(left, right) {
            if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
            return left.every((chunk, index) => chunk === right[index]);
        }

        splitText(text, separator = DEFAULT_SEPARATOR) {
            const source = String(text || '');
            const parts = separator === '\\n' || separator === '\n'
                ? source.split(/\n+/)
                : source.split(separator);
            return this.normalizeChunks(parts);
        }

        async setBookChunks(bookId, chunks) {
            const book = this.library[bookId];
            if (!book) return false;
            const nextChunks = this.normalizeChunks(chunks);
            if (this.areChunksEqual(book.chunks, nextChunks)) return true;
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

        async syncSummaryToBook(chunks, sessionId = 'default', bookName = '') {
            const normalizedChunks = this.normalizeChunks(chunks);
            if (!normalizedChunks.length) return { success: false, count: 0, error: '总结内容为空' };

            const id = `yzm_summary_book_${String(sessionId || 'default').replace(/[^\w-]/g, '_')}`;
            const oldBook = this.library[id];
            const normalizedName = String(bookName || '').trim() || '当前会话总结';
            const oldName = String(oldBook?.name || '').trim();
            const shouldUseSessionName = !oldName || oldName === '剧情总结归档' || oldName === '当前会话总结';
            const nextName = shouldUseSessionName ? normalizedName : oldName;
            const normalizedSessionId = String(sessionId || 'default');
            const unchanged = oldBook
                && oldBook.name === nextName
                && oldBook.kind === BOOK_KIND_SUMMARY
                && oldBook.sessionId === normalizedSessionId
                && this.areChunksEqual(oldBook.chunks, normalizedChunks);
            if (unchanged) {
                this.selectedBookId = id;
                this.toggleActiveBook(id, true);
                return { success: true, bookId: id, count: normalizedChunks.length, unchanged: true };
            }
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
                name: nextName,
                kind: BOOK_KIND_SUMMARY,
                sessionId: normalizedSessionId,
                chunks: normalizedChunks,
                vectors,
                vectorized,
                createTime: oldBook?.createTime || Date.now(),
                updateTime: Date.now(),
            }, normalizedName);
            this.selectedBookId = id;
            await this.saveLibrary();
            this.toggleActiveBook(id, true);
            return { success: true, bookId: id, count: normalizedChunks.length };
        }

        getCharacterProfileBookId(sessionId = 'default') {
            return `yzm_character_book_${String(sessionId || 'default').replace(/[^\w-]/g, '_')}`;
        }

        isCharacterProfileBook(bookId) {
            return this.library[bookId]?.kind === BOOK_KIND_CHARACTER_PROFILE
                || String(bookId || '').startsWith('yzm_character_book_');
        }

        getWorldSettingBookId(sessionId = 'default') {
            return `yzm_world_setting_book_${String(sessionId || 'default').replace(/[^\w-]/g, '_')}`;
        }

        isWorldSettingBook(bookId) {
            return this.library[bookId]?.kind === BOOK_KIND_WORLD_SETTING
                || String(bookId || '').startsWith('yzm_world_setting_book_');
        }

        isManagedTableVectorBook(bookId) {
            return this.isCharacterProfileBook(bookId) || this.isWorldSettingBook(bookId);
        }

        getActiveBooksByKind(kind = '') {
            const expected = String(kind || '').trim();
            return this.getActiveBooks().filter((bookId) => {
                const book = this.library[bookId];
                if (!book) return false;
                if (expected === BOOK_KIND_CHARACTER_PROFILE) return this.isCharacterProfileBook(bookId);
                if (expected === BOOK_KIND_WORLD_SETTING) return this.isWorldSettingBook(bookId);
                if (!expected) return !this.isManagedTableVectorBook(bookId);
                return book.kind === expected;
            });
        }

        async syncCharacterProfilesToBook(chunks, sessionId = 'default', bookName = '') {
            const normalizedChunks = this.normalizeChunks(chunks);
            const id = this.getCharacterProfileBookId(sessionId);
            const oldBook = this.library[id];
            const normalizedName = String(bookName || '').trim() || '当前会话角色档案';
            const normalizedSessionId = String(sessionId || 'default');
            const unchanged = oldBook
                && oldBook.name === normalizedName
                && oldBook.kind === BOOK_KIND_CHARACTER_PROFILE
                && oldBook.sessionId === normalizedSessionId
                && this.areChunksEqual(oldBook.chunks, normalizedChunks);
            if (unchanged) {
                this.selectedBookId = id;
                this.toggleActiveBook(id, true);
                return { success: true, bookId: id, count: normalizedChunks.length, unchanged: true };
            }
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
                name: normalizedName,
                kind: BOOK_KIND_CHARACTER_PROFILE,
                sessionId: normalizedSessionId,
                chunks: normalizedChunks,
                vectors,
                vectorized,
                createTime: oldBook?.createTime || Date.now(),
                updateTime: Date.now(),
            }, normalizedName);
            this.selectedBookId = id;
            await this.saveLibrary();
            this.toggleActiveBook(id, true);
            return { success: true, bookId: id, count: normalizedChunks.length };
        }

        async syncWorldSettingsToBook(chunks, sessionId = 'default', bookName = '') {
            const normalizedChunks = this.normalizeChunks(chunks);
            const id = this.getWorldSettingBookId(sessionId);
            const oldBook = this.library[id];
            const normalizedName = String(bookName || '').trim() || '当前会话世界设定';
            const normalizedSessionId = String(sessionId || 'default');
            const unchanged = oldBook
                && oldBook.name === normalizedName
                && oldBook.kind === BOOK_KIND_WORLD_SETTING
                && oldBook.sessionId === normalizedSessionId
                && this.areChunksEqual(oldBook.chunks, normalizedChunks);
            if (unchanged) {
                this.selectedBookId = id;
                this.toggleActiveBook(id, true);
                return { success: true, bookId: id, count: normalizedChunks.length, unchanged: true };
            }
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
                name: normalizedName,
                kind: BOOK_KIND_WORLD_SETTING,
                sessionId: normalizedSessionId,
                chunks: normalizedChunks,
                vectors,
                vectorized,
                createTime: oldBook?.createTime || Date.now(),
                updateTime: Date.now(),
            }, normalizedName);
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
            const settings = YuzukiMemory.EmbeddingClient?.loadSettings?.() || {};
            const cacheNamespace = [settings.provider, settings.baseUrl, settings.model].map((value) => String(value || '')).join('|');
            const cacheKey = `${cacheNamespace}|${this.hashText(source)}`;
            if (this.vectorCache.has(cacheKey)) {
                const cached = this.vectorCache.get(cacheKey);
                this.vectorCache.delete(cacheKey);
                this.vectorCache.set(cacheKey, cached);
                return cached;
            }
            if (this.pendingEmbeddings.has(cacheKey)) return this.pendingEmbeddings.get(cacheKey);
            const request = YuzukiMemory.EmbeddingClient.embed(source);
            this.pendingEmbeddings.set(cacheKey, request);
            try {
                const vector = await request;
                this.vectorCache.set(cacheKey, vector);
                while (this.vectorCache.size > MAX_QUERY_VECTOR_CACHE_ENTRIES) {
                    const oldestKey = this.vectorCache.keys().next().value;
                    if (oldestKey === undefined) break;
                    this.vectorCache.delete(oldestKey);
                }
                return vector;
            } finally {
                this.pendingEmbeddings.delete(cacheKey);
            }
        }

        async vectorizeBook(bookId = this.selectedBookId, progressCallback = null, options = {}) {
            await this.whenReady();
            const book = this.library[bookId];
            if (!book) throw new Error('向量书不存在');
            const force = options && typeof options === 'object' && options.force === true;
            if (Array.isArray(book.chunks) && book.chunks.some((chunk) => String(chunk || '').length > MAX_VECTOR_CHUNK_CHARS)) {
                await this.setBookChunks(bookId, book.chunks);
            }
            const pending = book.chunks
                .map((chunk, index) => ({ chunk, index }))
                .filter(({ index }) => force || !book.vectorized[index] || !Array.isArray(book.vectors[index]));
            if (!pending.length) return { success: true, count: 0, errors: 0 };

            if (force) {
                pending.forEach(({ index }) => {
                    book.vectors[index] = null;
                    book.vectorized[index] = false;
                });
            }

            let success = 0;
            let errors = 0;
            let batchSize = 10;
            for (let cursor = 0; cursor < pending.length;) {
                const batchStart = cursor;
                const batch = [];
                let batchChars = 0;
                while (cursor < pending.length && batch.length < batchSize) {
                    const item = pending[cursor];
                    const length = String(item.chunk || '').length;
                    if (batch.length && batchChars + length > MAX_VECTOR_BATCH_CHARS) break;
                    batch.push(item);
                    batchChars += length;
                    cursor += 1;
                }
                try {
                    progressCallback?.(Math.min(cursor, pending.length), pending.length);
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
                        cursor = batchStart;
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

        getBookVectorDimension(book) {
            if (!Array.isArray(book?.vectors)) return 0;
            const vector = book.vectors.find((item) => Array.isArray(item) && item.length);
            return Array.isArray(vector) ? vector.length : 0;
        }

        async search(query, allowedBookIds = null) {
            await this.whenReady();
            let pluginSettings = {};
            try {
                pluginSettings = YuzukiMemory.GlobalSettings?.get?.('yzm_memory_global_plugin_settings', {})
                    ?? JSON.parse(localStorage.getItem('yzm_memory_global_plugin_settings') || '{}');
            } catch (_error) {
                pluginSettings = {};
            }
            if (pluginSettings?.injectVectorMemory !== true) {
                console.info('[yuzuki-Memory Vector] 搜索跳过：注入向量记忆未启用');
                return [];
            }
            const settings = YuzukiMemory.EmbeddingClient.loadSettings();
            const rerankSettings = YuzukiMemory.RerankClient?.loadSettings?.() || { enabled: false };
            const sourceQuery = String(query || '').trim();
            if (!sourceQuery) {
                console.info('[yuzuki-Memory Vector] 搜索跳过：查询文本为空');
                return [];
            }
            const bookIds = Array.isArray(allowedBookIds) ? allowedBookIds : this.getActiveBooks();
            if (!bookIds.length) {
                console.info('[yuzuki-Memory Vector] 搜索跳过：当前会话没有绑定向量书');
                return [];
            }
            const targetCount = Math.max(1, Number.parseInt(settings.recallLimit, 10) || 6);
            const recallCount = rerankSettings.enabled ? targetCount * 2 : targetCount;
            const initialThreshold = rerankSettings.enabled ? 0.1 : settings.threshold;

            const queryVector = await this.getEmbedding(sourceQuery.slice(-6000));
            const queryDimension = Array.isArray(queryVector) ? queryVector.length : 0;
            if (!queryDimension) {
                console.warn('[yuzuki-Memory Vector] 搜索跳过：查询向量维度为空');
                return [];
            }
            const matchedBookIds = [];
            const mismatchedBooks = [];
            const emptyBooks = [];
            bookIds.forEach((bookId) => {
                const book = this.library[bookId];
                if (!book) return;
                const dimension = this.getBookVectorDimension(book);
                if (!dimension) {
                    emptyBooks.push(book.name || bookId);
                    return;
                }
                if (dimension !== queryDimension) {
                    mismatchedBooks.push(`${book.name || bookId}: ${dimension} != ${queryDimension}`);
                    return;
                }
                matchedBookIds.push(bookId);
            });
            if (!matchedBookIds.length) {
                console.warn('[yuzuki-Memory Vector] 搜索跳过：绑定向量书维度均与当前 Embedding API 不匹配', {
                    queryDimension,
                    mismatchedBooks,
                    emptyBooks,
                });
                return [];
            }
            if (mismatchedBooks.length || emptyBooks.length) {
                console.warn('[yuzuki-Memory Vector] 已跳过维度不匹配或未向量化的书', {
                    queryDimension,
                    matchedBooks: matchedBookIds.length,
                    mismatchedBooks,
                    emptyBooks,
                });
            }
            const seen = new Set();
            const results = [];
            matchedBookIds.forEach((bookId) => {
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
            console.info('[yuzuki-Memory Vector] 向量初筛完成', {
                books: matchedBookIds.length,
                skippedBooks: bookIds.length - matchedBookIds.length,
                queryDimension,
                candidates: candidates.length,
                rawMatches: results.length,
                initialThreshold,
                rerank: rerankSettings.enabled === true,
            });

            if (rerankSettings.enabled && candidates.length && YuzukiMemory.RerankClient?.rerank) {
                try {
                    console.info('[yuzuki-Memory Vector] 开始 rerank', {
                        candidates: candidates.length,
                        topN: targetCount,
                        model: rerankSettings.model || '',
                    });
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
                    console.info('[yuzuki-Memory Vector] rerank 完成', {
                        candidates: candidates.length,
                        topScore: Number(candidates[0]?.score || 0).toFixed(4),
                    });
                } catch (error) {
                    console.warn('[yuzuki-Memory Vector] rerank 失败，改用向量顺序', error);
                }
            } else if (rerankSettings.enabled && !candidates.length) {
                console.info('[yuzuki-Memory Vector] rerank 跳过：初筛没有候选内容');
            } else if (rerankSettings.enabled && !YuzukiMemory.RerankClient?.rerank) {
                console.warn('[yuzuki-Memory Vector] rerank 跳过：RerankClient 未加载');
            }

            const finalThreshold = rerankSettings.enabled ? null : settings.threshold;
            const finalResults = (rerankSettings.enabled
                ? candidates
                : candidates.filter((item) => item.score >= finalThreshold))
                .slice(0, targetCount);
            console.info('[yuzuki-Memory Vector] 搜索输出', {
                count: finalResults.length,
                finalThreshold,
                topScore: Number(finalResults[0]?.score || 0).toFixed(4),
            });
            return finalResults;
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

        importBooksAsNew(rawLibrary) {
            const normalizedLibrary = this.normalizeLibrary(rawLibrary);
            const imported = {};
            Object.entries(normalizedLibrary).forEach(([sourceId, book]) => {
                let nextId = this.createId('yzm_imported_book');
                while (this.library[nextId] || imported[nextId]) {
                    nextId = this.createId('yzm_imported_book');
                }
                imported[nextId] = {
                    ...book,
                    createTime: book.createTime || Date.now(),
                    updateTime: Date.now(),
                    sourceBookId: String(sourceId || ''),
                };
            });
            return imported;
        }

        async importLibrary(fileOrText) {
            const text = typeof fileOrText === 'string' ? fileOrText : await this.readFile(fileOrText);
            if (this.isLegacyLibraryBackup(text)) {
                return this.importLegacyLibrary(text);
            }
            const jsonText = text.startsWith(BACKUP_HEADER) ? text.slice(BACKUP_HEADER.length).trim() : text.trim();
            const parsed = JSON.parse(jsonText);
            const nextLibrary = this.importBooksAsNew(parsed.library || parsed);
            Object.assign(this.library, nextLibrary);
            this.selectedBookId = Object.keys(nextLibrary)[0] || this.selectedBookId;
            await this.saveLibrary();
            return { success: true, bookCount: Object.keys(nextLibrary).length };
        }

        isLegacyLibraryBackup(text) {
            const source = String(text || '');
            return source.includes(LEGACY_BACKUP_HEADER) ||
                source.includes(LEGACY_LIBRARY_MARKER) ||
                (/Gaigai/i.test(source) && source.includes('ID: ') && source.includes('---'));
        }

        decodeLegacyVector(base64Text) {
            const source = String(base64Text || '').trim();
            if (!source) return null;
            try {
                const binary = atob(source);
                let encoded = '';
                for (let index = 0; index < binary.length; index += 1) {
                    encoded += `%${binary.charCodeAt(index).toString(16).padStart(2, '0')}`;
                }
                const vector = JSON.parse(decodeURIComponent(encoded));
                return Array.isArray(vector) ? vector : null;
            } catch (error) {
                console.warn('[yuzuki-Memory] Legacy vector decode failed.', error);
                return null;
            }
        }

        parseLegacyLibraryBackup(text) {
            const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            const imported = {};
            let inLibrary = false;
            let mode = 'header';
            let currentBookId = '';
            let currentBook = null;
            let currentChunkIndex = -1;
            let vectorBuffer = '';

            const flushVector = () => {
                if (!currentBook || currentChunkIndex < 0 || !vectorBuffer.trim()) return;
                const vector = this.decodeLegacyVector(vectorBuffer);
                currentBook.vectors[currentChunkIndex] = vector;
                currentBook.vectorized[currentChunkIndex] = Array.isArray(vector);
                vectorBuffer = '';
            };

            const flushBook = () => {
                flushVector();
                if (!currentBookId || !currentBook?.name) return;
                imported[currentBookId] = this.normalizeBook(currentBook, currentBook.name);
            };

            lines.forEach((rawLine) => {
                const trimmed = rawLine.trim();
                const isLibraryMarker = trimmed === LEGACY_LIBRARY_MARKER || /^>>>.*<<<$/.test(trimmed);
                const isBookInfoMarker = trimmed === '=== 书籍信息 ===' || (/^===.*===$/.test(trimmed) && (trimmed.includes('书籍信息') || /book\s*info/i.test(trimmed)));
                const isSectionMarker = /^===.*===$/.test(trimmed);
                const isVectorMarker = trimmed === '--- 向量 (Base64) ---' || (/^---.*---$/.test(trimmed) && /Base64/i.test(trimmed));
                const isUnvectorizedMarker = trimmed === '--- 向量: 未向量化 ---' || (/^---.*---$/.test(trimmed) && (trimmed.includes('未向量化') || /unvectorized/i.test(trimmed)));
                const chunkMatch = (!isVectorMarker && !isUnvectorizedMarker)
                    ? trimmed.match(/^---.*?(\d+).*?---$/)
                    : null;

                if (isLibraryMarker) {
                    inLibrary = true;
                    mode = 'library';
                    return;
                }
                if (!inLibrary && (isBookInfoMarker || trimmed.startsWith('ID: '))) {
                    inLibrary = true;
                }
                if (!inLibrary) return;

                if (isBookInfoMarker || (isSectionMarker && mode !== 'chunk_text' && mode !== 'chunk_vector')) {
                    flushBook();
                    currentBookId = '';
                    currentBook = { chunks: [], vectors: [], vectorized: [], createTime: Date.now(), updateTime: Date.now() };
                    currentChunkIndex = -1;
                    mode = 'book_meta';
                    return;
                }

                if (!currentBook && trimmed.startsWith('ID: ')) {
                    currentBook = { chunks: [], vectors: [], vectorized: [], createTime: Date.now(), updateTime: Date.now() };
                    currentChunkIndex = -1;
                    mode = 'book_meta';
                }

                if (!currentBook) return;

                if (trimmed.startsWith('ID: ') && currentBookId && currentBook?.name) {
                    flushBook();
                    currentBook = { chunks: [], vectors: [], vectorized: [], createTime: Date.now(), updateTime: Date.now() };
                    currentChunkIndex = -1;
                    mode = 'book_meta';
                }

                if (chunkMatch) {
                    flushVector();
                    currentChunkIndex = Number.parseInt(chunkMatch[1], 10);
                    currentBook.chunks[currentChunkIndex] = '';
                    currentBook.vectors[currentChunkIndex] = null;
                    currentBook.vectorized[currentChunkIndex] = false;
                    mode = 'chunk_text';
                    return;
                }

                if (isVectorMarker) {
                    flushVector();
                    vectorBuffer = '';
                    mode = 'chunk_vector';
                    return;
                }

                if (isUnvectorizedMarker) {
                    flushVector();
                    currentBook.vectors[currentChunkIndex] = null;
                    currentBook.vectorized[currentChunkIndex] = false;
                    mode = 'chunk_unvectorized';
                    return;
                }

                if (mode === 'book_meta') {
                    if (trimmed.startsWith('ID: ')) {
                        currentBookId = trimmed.slice(4).trim();
                    } else if (trimmed.startsWith('书名: ')) {
                        currentBook.name = trimmed.slice(4).trim();
                    } else if (/^book\s*name\s*:/i.test(trimmed)) {
                        currentBook.name = trimmed.replace(/^book\s*name\s*:/i, '').trim();
                    } else if (trimmed.startsWith('创建时间:')) {
                        const timestamp = Number.parseInt(trimmed.replace('创建时间:', '').trim(), 10);
                        currentBook.createTime = Number.isFinite(timestamp) ? timestamp : Date.now();
                        currentBook.updateTime = currentBook.createTime;
                    } else if (/^create\s*time\s*:/i.test(trimmed)) {
                        const timestamp = Number.parseInt(trimmed.replace(/^create\s*time\s*:/i, '').trim(), 10);
                        currentBook.createTime = Number.isFinite(timestamp) ? timestamp : Date.now();
                        currentBook.updateTime = currentBook.createTime;
                    }
                    return;
                }

                if (mode === 'chunk_text') {
                    if (!trimmed) return;
                    currentBook.chunks[currentChunkIndex] += currentBook.chunks[currentChunkIndex]
                        ? `\n${rawLine}`
                        : rawLine;
                    return;
                }

                if (mode === 'chunk_vector') {
                    if (trimmed) vectorBuffer += trimmed;
                }
            });

            flushBook();
            return imported;
        }

        async importLegacyLibrary(text) {
            const nextLibrary = this.importBooksAsNew(this.parseLegacyLibraryBackup(text));
            Object.assign(this.library, nextLibrary);
            this.selectedBookId = Object.keys(nextLibrary)[0] || this.selectedBookId;
            await this.saveLibrary();
            return { success: true, bookCount: Object.keys(nextLibrary).length, legacy: true };
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
