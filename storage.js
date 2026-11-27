const BACKUP_FORMAT = 'tavern-chat-clips';
const LEGACY_FORMAT = 'th-chat-favorites-export';
const DATABASE = 'tavern-chat-clips';
const CLIPS = 'clips';

function string(value) {
    return typeof value === 'string' ? value : '';
}

function safeImages(images) {
    if (!Array.isArray(images)) return [];
    return images.filter(url => typeof url === 'string'
        && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(url));
}

function newId() {
    // getRandomValues also works when the tavern is accessed over HTTP on a LAN.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function makeClip(input) {
    const text = string(input.text).trim();
    const images = safeImages(input.images);
    if (!text && !images.length) throw new Error('收藏内容为空。');

    const now = Date.now();
    return {
        id: newId(),
        chatKey: string(input.chatKey),
        chatId: input.chatId == null ? '' : String(input.chatId),
        characterAvatar: string(input.characterAvatar),
        groupId: input.groupId == null ? null : String(input.groupId),
        chatLabel: string(input.chatLabel),
        floor: Number.isInteger(input.floor) && input.floor >= 0 ? input.floor : null,
        swipeId: Number.isInteger(input.swipeId) && input.swipeId >= 0 ? input.swipeId : null,
        author: string(input.author),
        role: string(input.role),
        sentAt: typeof input.sentAt === 'number' ? input.sentAt : string(input.sentAt),
        sourceText: string(input.sourceText),
        text,
        kind: input.kind === 'clip' ? 'clip' : 'message',
        title: string(input.title).trim(),
        note: string(input.note).trim(),
        images,
        createdAt: now,
        updatedAt: now,
    };
}

function legacyPlainText(html) {
    if (!html || !globalThis.document) return '';
    // Template contents stay inert, including links, scripts and remote media.
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    fragment.querySelectorAll('script,style,noscript').forEach(node => node.remove());
    fragment.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    fragment.querySelectorAll('p,div,li,blockquote,h1,h2,h3,h4,h5,h6,pre').forEach(node => node.append('\n'));
    return fragment.textContent.trim();
}

function parseLegacyClip(value) {
    if (!value || typeof value !== 'object' || value.deletedAt != null) return null;
    const chatId = value.chatId == null ? '' : String(value.chatId);
    const characterAvatar = value.characterAvatar === 'unknown' ? '' : string(value.characterAvatar);
    const floor = value.messageId === '' || value.messageId == null ? null : Number(value.messageId);
    const sourceText = string(value.originalMessage) || string(value.message);
    const text = string(value.editedMessage).trim()
        || legacyPlainText(string(value.editedMessageHtml || value.messageHtml))
        || string(value.message).trim()
        || string(value.originalMessage).trim()
        || string(value.previewText).trim();
    const images = safeImages(Array.isArray(value.images)
        ? value.images.flatMap(image => [image?.thumbnail, image?.originalSrc])
        : []);
    if (!text && !images.length) return null;

    const clip = makeClip({
        chatKey: chatId && characterAvatar ? JSON.stringify(['character', characterAvatar, chatId]) : '',
        chatId,
        characterAvatar,
        chatLabel: value.chatName,
        floor,
        author: value.charName,
        role: value.role,
        sourceText,
        text,
        kind: 'message',
        title: value.title,
        note: value.subtitle,
        images: [...new Set(images)],
    });
    if (string(value.uuid)) clip.id = `legacy:${value.uuid}`;
    else if (Number.isInteger(value.id)) clip.id = `legacy-record:${value.id}`;
    clip.createdAt = Number(value.createdAt) || clip.createdAt;
    clip.updatedAt = Number(value.updatedAt) || clip.createdAt;
    return clip;
}

export function parseBackup(value) {
    if (value?.format === BACKUP_FORMAT && value.version === 1 && Array.isArray(value.clips)) {
        return value.clips.map(record => {
            if (!record || typeof record.id !== 'string' || !record.id) throw new Error('备份里有一条收藏缺少编号。');
            const clip = makeClip(record);
            clip.id = record.id;
            if (Number.isFinite(record.createdAt)) clip.createdAt = record.createdAt;
            if (Number.isFinite(record.updatedAt)) clip.updatedAt = record.updatedAt;
            return clip;
        });
    }
    if (Array.isArray(value)) return value.map(parseLegacyClip).filter(Boolean);
    if (Array.isArray(value?.favorites) && (!value.format || value.format === LEGACY_FORMAT)) {
        return value.favorites.map(parseLegacyClip).filter(Boolean);
    }
    throw new Error('请选择此扩展的收藏备份，或旧脚本导出的收藏 JSON。');
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('收藏存储操作已取消。'));
    });
}

export function createClipStore(indexedDB = globalThis.indexedDB) {
    let opening;

    function open() {
        if (!opening) {
            const request = indexedDB.open(DATABASE, 1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore(CLIPS, { keyPath: 'id' });
                store.createIndex('chatKey', 'chatKey');
            };
            opening = requestResult(request).then(database => {
                database.onversionchange = () => {
                    database.close();
                    opening = undefined;
                };
                return database;
            }, error => {
                opening = undefined;
                throw error;
            });
        }
        return opening;
    }

    async function run(mode, operation) {
        const database = await open();
        const transaction = database.transaction(CLIPS, mode);
        const done = transactionDone(transaction);
        const result = operation(transaction.objectStore(CLIPS));
        const [value] = await Promise.all([result, done]);
        return value;
    }

    async function list(chatKey) {
        const clips = await run('readonly', store => requestResult(chatKey === undefined
            ? store.getAll()
            : store.index('chatKey').getAll(chatKey)));
        return clips.sort((left, right) => right.createdAt - left.createdAt);
    }

    return {
        list,
        async add(clip) {
            await run('readwrite', store => requestResult(store.add(clip)));
            return clip;
        },
        update(id, changes) {
            return run('readwrite', async store => {
                const clip = await requestResult(store.get(id));
                if (!clip) return null;
                const text = changes.text === undefined ? clip.text : string(changes.text).trim();
                if (!text && !clip.images.length) throw new Error('收藏内容为空。');
                clip.text = text;
                if (changes.title !== undefined) clip.title = string(changes.title).trim();
                if (changes.note !== undefined) clip.note = string(changes.note).trim();
                clip.updatedAt = Date.now();
                await requestResult(store.put(clip));
                return clip;
            });
        },
        remove(id) {
            return run('readwrite', store => requestResult(store.delete(id)));
        },
        async backup() {
            return { format: BACKUP_FORMAT, version: 1, exportedAt: Date.now(), clips: await list() };
        },
        import(data) {
            const clips = parseBackup(data);
            return run('readwrite', async store => {
                let imported = 0;
                for (const clip of clips) {
                    if (await requestResult(store.getKey(clip.id)) !== undefined) continue;
                    await requestResult(store.add(clip));
                    imported += 1;
                }
                return { imported, skipped: clips.length - imported };
            });
        },
    };
}

export async function readLegacyFavorites(indexedDB = globalThis.indexedDB) {
    const result = { format: LEGACY_FORMAT, version: 1, favorites: [] };
    const request = indexedDB.open('th-chat-favorites');
    let missing = false;
    request.onupgradeneeded = () => {
        missing = true;
        request.transaction.abort();
    };

    let database;
    try {
        database = await requestResult(request);
    } catch (error) {
        if (missing) return result;
        throw error;
    }

    try {
        if (!database.objectStoreNames.contains('favorites')) return result;
        const hasPayload = database.objectStoreNames.contains('favorite_payload');
        const stores = hasPayload ? ['favorites', 'favorite_payload'] : ['favorites'];
        const transaction = database.transaction(stores, 'readonly');
        const favorites = requestResult(transaction.objectStore('favorites').getAll());
        const payloads = hasPayload ? requestResult(transaction.objectStore('favorite_payload').getAll()) : [];
        const [records, bodies] = await Promise.all([favorites, payloads]);
        const byUuid = new Map(bodies.map(body => [body.uuid, body]));
        result.favorites = records.map(record => ({ ...record, ...byUuid.get(record.uuid) }));
        return result;
    } finally {
        database.close();
    }
}
