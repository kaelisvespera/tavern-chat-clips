// 原脚本：千秋梦。经授权移植到 TauriTavern。
import { createTavernChatHelper, installChatSearchEntrypoints } from './tt-entry.js';
import { convertV1Backup, readV1Favorites } from './v1-migration.js';

(() => {
  const parentWin = window.parent && window.parent !== window ? window.parent : window;
  if (!parentWin || !parentWin.document) {
    console.warn('[ChatSearch] parent window not available.');
    return;
  }

  const doc = parentWin.document;
  const notifier = (window.toastr ?? parentWin.toastr) || null;
  const logger = window.log ?? parentWin.log ?? console;

  const PANEL_ID = 'th-chat-search-panel';
  const STYLE_ID = 'th-chat-search-style';
  const INPUT_ID = 'th-chat-search-input';
  const RESULT_ID = 'th-chat-search-results';
  const COUNTER_ID = 'th-chat-search-counter';
  const EMPTY_ID = 'th-chat-search-empty';
  const MODAL_ID = 'th-reading-modal';
  const EDITOR_ID = 'th-favorite-editor';
  const MAX_RESULTS = 200;
  const DB_NAME = 'th-chat-favorites';
  const DB_VERSION = 3;
  const STORE_NAME = 'favorites';
  const PAYLOAD_STORE_NAME = 'favorite_payload';
  const PREVIEW_TEXT_MAX_LEN = 500;
  const MESSAGE_FAVORITE_BUTTON_CLASS = 'th-chat-search-mes-favorite';
  const PURGE_DELETED_PAYLOAD_FLAG = 'th-chat-search-purge-deleted-payload-v1';

  let db = null;

  function popupContent(message) {
    const content = doc.createElement('div');
    content.textContent = message;
    content.style.whiteSpace = 'pre-wrap';
    return content;
  }

  async function askText(message, defaultValue = '') {
    const context = parentWin.SillyTavern.getContext();
    const result = await context.callGenericPopup(popupContent(message), context.POPUP_TYPE.INPUT, defaultValue);
    return typeof result === 'string' ? result : null;
  }

  async function askConfirm(message) {
    const context = parentWin.SillyTavern.getContext();
    const result = await context.callGenericPopup(popupContent(message), context.POPUP_TYPE.CONFIRM);
    return result === context.POPUP_RESULT.AFFIRMATIVE;
  }

  function safeFavoriteHtml(html) {
    return parentWin.DOMPurify.sanitize(html);
  }

  const FAVORITE_PAYLOAD_FIELDS = [
    'message',
    'messageHtml',
    'images',
    'editedMessage',
    'editedMessageHtml',
    'editedAt',
    'originalMessageHtml',
    'originalMessage',
  ];

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function hasAnyPayloadFields(fav) {
    return FAVORITE_PAYLOAD_FIELDS.some(key => hasOwn(fav, key));
  }

  function splitFavoriteForStorage(fav) {
    const uuid = fav?.uuid || generateUuid();
    const meta = { ...(fav ?? {}), uuid };
    const payload = { uuid };

    let includesImages = false;
    let hasPayload = false;

    for (const key of FAVORITE_PAYLOAD_FIELDS) {
      if (!hasOwn(meta, key)) continue;
      payload[key] = meta[key];
      delete meta[key];
      hasPayload = true;
      if (key === 'images') includesImages = true;
    }

    if (hasOwn(meta, '__payloadLoaded')) delete meta.__payloadLoaded;

    const rawPreview = typeof meta.previewText === 'string' ? meta.previewText.trim() : '';
    if (rawPreview) {
      meta.previewText = rawPreview.slice(0, PREVIEW_TEXT_MAX_LEN);
    } else {
      const html =
        typeof payload.editedMessageHtml === 'string'
          ? payload.editedMessageHtml
          : typeof payload.messageHtml === 'string'
            ? payload.messageHtml
            : '';
      const text =
        typeof payload.editedMessage === 'string'
          ? payload.editedMessage
          : typeof payload.message === 'string'
            ? payload.message
            : '';
      const previewSource = html || text;
      const previewText = previewSource ? collapseWhitespace(stripTags(previewSource)) : '';
      if (previewText) {
        meta.previewText = previewText.slice(0, PREVIEW_TEXT_MAX_LEN);
      }
    }

    if (includesImages) {
      meta.hasImages = Array.isArray(payload.images) && payload.images.length > 0;
      meta.coverThumbnail = meta.hasImages ? payload.images?.[0]?.thumbnail ?? null : null;
    } else {
      meta.hasImages = Boolean(meta.hasImages);
      meta.coverThumbnail = meta.coverThumbnail ?? null;
    }

    return { meta, payload, hasPayload };
  }

  async function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = event => {
        const db = event.target.result;
        const tx = event.target.transaction;
        /** @type {IDBObjectStore} */
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        } else {
          store = tx.objectStore(STORE_NAME);
        }

        const ensureIndex = (name, keyPath, options) => {
          if (!store.indexNames.contains(name)) {
            store.createIndex(name, keyPath, options);
          }
        };

        ensureIndex('chatId', 'chatId', { unique: false });
        ensureIndex('charName', 'charName', { unique: false });
        ensureIndex('createdAt', 'createdAt', { unique: false });
        ensureIndex('uuid', 'uuid', { unique: true });
        ensureIndex('chatId_messageId', ['chatId', 'messageId'], { unique: false });

        if (!db.objectStoreNames.contains(PAYLOAD_STORE_NAME)) {
          db.createObjectStore(PAYLOAD_STORE_NAME, { keyPath: 'uuid' });
        }

        if (event.oldVersion < 3) {
          const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const record = cursor.value ?? {};

            if (record.id == null) record.id = cursor.primaryKey;

            const uuid = record.uuid || generateUuid();
            record.uuid = uuid;

            const payload = { uuid };
            let hasPayload = false;
            for (const key of FAVORITE_PAYLOAD_FIELDS) {
              if (!hasOwn(record, key)) continue;
              payload[key] = record[key];
              delete record[key];
              hasPayload = true;
            }

            record.hasImages = Array.isArray(payload.images) && payload.images.length > 0;
            record.coverThumbnail = record.hasImages ? payload.images?.[0]?.thumbnail ?? null : null;

            const rawPreview = typeof record.previewText === 'string' ? record.previewText.trim() : '';
            if (rawPreview) {
              record.previewText = rawPreview.slice(0, PREVIEW_TEXT_MAX_LEN);
            } else {
              const html =
                typeof payload.editedMessageHtml === 'string'
                  ? payload.editedMessageHtml
                  : typeof payload.messageHtml === 'string'
                    ? payload.messageHtml
                    : '';
              const text =
                typeof payload.editedMessage === 'string'
                  ? payload.editedMessage
                  : typeof payload.message === 'string'
                    ? payload.message
                    : '';
              const previewSource = html || text;
              const previewText = previewSource ? collapseWhitespace(stripTags(previewSource)) : '';
              if (previewText) {
                record.previewText = previewText.slice(0, PREVIEW_TEXT_MAX_LEN);
              }
            }

            if (hasPayload) {
              payloadStore.put(payload);
            }

            cursor.update(record);
            cursor.continue();
          };
        }
      };
    });
  }

  async function addFavoriteDB(fav) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, PAYLOAD_STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);

      const { meta, payload, hasPayload } = splitFavoriteForStorage(fav);

      const request = store.add(meta);
      if (hasPayload) payloadStore.put(payload);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('收藏写入已取消'));
    });
  }

  async function getAllFavoritesDB(options = {}) {
    const { includePayload = true } = options ?? {};
    if (!db) await initDB();

    if (!includePayload) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, PAYLOAD_STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);

      const metaReq = store.getAll();
      const payloadReq = payloadStore.getAll();

      let metaResult = null;
      let payloadResult = null;

      const finish = () => {
        if (!metaResult || !payloadResult) return;
        const payloadMap = new Map(payloadResult.map(item => [item?.uuid, item]));
        resolve(
          metaResult.map(item => {
            const uuid = item?.uuid;
            const payload = uuid ? payloadMap.get(uuid) : null;
            return payload ? { ...item, ...payload } : { ...item };
          }),
        );
      };

      metaReq.onsuccess = () => {
        metaResult = Array.isArray(metaReq.result) ? metaReq.result : [];
        finish();
      };
      metaReq.onerror = () => reject(metaReq.error);

      payloadReq.onsuccess = () => {
        payloadResult = Array.isArray(payloadReq.result) ? payloadReq.result : [];
        finish();
      };
      payloadReq.onerror = () => reject(payloadReq.error);
    });
  }

  async function getFavoriteByUuidDB(uuid) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      if (!store.indexNames.contains('uuid')) {
        resolve(null);
        return;
      }
      const index = store.index('uuid');
      const request = index.get(uuid);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getFavoritePayloadByUuidDB(uuid) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PAYLOAD_STORE_NAME], 'readonly');
      const store = tx.objectStore(PAYLOAD_STORE_NAME);
      const request = store.get(uuid);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteFavoritePayloadByUuidDB(uuid) {
    if (!uuid) return;
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PAYLOAD_STORE_NAME], 'readwrite');
      const store = tx.objectStore(PAYLOAD_STORE_NAME);
      const request = store.delete(uuid);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function purgeDeletedFavoritePayloadsDB() {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, PAYLOAD_STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);

      let payloadDeletes = 0;
      let metaUpdates = 0;

      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;

        const record = cursor.value;
        if (record && record.deletedAt != null) {
          const uuid = record.uuid;
          if (uuid) {
            payloadStore.delete(uuid);
            payloadDeletes++;
          }

          let changed = false;
          if (record.hasImages || record.coverThumbnail != null) {
            record.hasImages = false;
            record.coverThumbnail = null;
            changed = true;
          }

          FAVORITE_PAYLOAD_FIELDS.forEach(key => {
            if (hasOwn(record, key)) {
              delete record[key];
              changed = true;
            }
          });

          if (hasOwn(record, '__payloadLoaded')) {
            delete record.__payloadLoaded;
            changed = true;
          }

          if (changed) {
            cursor.update(record);
            metaUpdates++;
          }
        }

        cursor.continue();
      };

      tx.oncomplete = () => resolve({ payloadDeletes, metaUpdates });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function hydrateFavoritePayload(fav) {
    if (!fav || typeof fav !== 'object') return fav;
    if (fav.__payloadLoaded) return fav;

    if (hasAnyPayloadFields(fav)) {
      fav.__payloadLoaded = true;
      return fav;
    }

    const uuid = fav.uuid;
    if (!uuid) {
      fav.__payloadLoaded = true;
      return fav;
    }

    const payload = await getFavoritePayloadByUuidDB(uuid);
    if (payload && typeof payload === 'object') {
      FAVORITE_PAYLOAD_FIELDS.forEach(key => {
        if (hasOwn(payload, key)) fav[key] = payload[key];
      });
    }

    fav.__payloadLoaded = true;
    return fav;
  }

  async function getFavoritesByChatIdDB(chatId) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);

      if (!store.indexNames.contains('chatId')) {
        const fallbackReq = store.getAll();
        fallbackReq.onsuccess = () => {
          const all = Array.isArray(fallbackReq.result) ? fallbackReq.result : [];
          resolve(all.filter(item => item?.chatId === chatId));
        };
        fallbackReq.onerror = () => reject(fallbackReq.error);
        return;
      }

      const index = store.index('chatId');
      const request = index.getAll(chatId);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteFavoriteDB(id) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, PAYLOAD_STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);

      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record?.uuid) {
          payloadStore.delete(record.uuid);
        }
        const delReq = store.delete(id);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function updateFavoriteDB(fav) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, PAYLOAD_STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const payloadStore = tx.objectStore(PAYLOAD_STORE_NAME);

      const { meta, payload, hasPayload } = splitFavoriteForStorage(fav);
      const request = store.put(meta);
      request.onsuccess = () => {
        if (hasPayload && hasAnyPayloadFields(fav)) payloadStore.put(payload);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function generateUuid() {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    (crypto?.getRandomValues ? crypto.getRandomValues(bytes) : bytes.fill(Math.floor(Math.random() * 256)));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }

  async function compressImage(imgElement, maxSize = 400, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const canvas = doc.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height), 0.5);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        let dataUrl = canvas.toDataURL('image/webp', quality);
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }

        resolve(dataUrl);
      };

      img.onerror = () => reject(new Error('Image load failed'));
      img.src = imgElement.src;
    });
  }

  async function extractImagesData(imgs) {
    const results = [];

    for (const img of imgs) {
      try {
        const thumbnail = await compressImage(img);
        results.push({
          originalSrc: img.src,
          thumbnail: thumbnail,
          width: img.width,
          height: img.height,
        });
      } catch (error) {
        logger.warn('[ChatSearch] failed to compress image:', error);
      }
    }

    return results;
  }

  const state = {
    helper: null,
    keywords: [],
    matches: [],
    fullMatchCount: 0,
    highlightedElement: null,
    highlightTimer: null,
    keydownHandler: null,
    docClickHandler: null,
    cleanupEntrypoints: null,
    currentMode: 'search',
    favorites: [],
    messageActionsObserver: null,
    modalVisible: false,
    galleryView: 'list',
    selectedCharacter: null,
    actionsPopoverOpen: false,
    jumpInProgress: false,
    renderEpoch: 0,
  };

  let elements = null;

  function cleanupElements() {
    const panel = doc.getElementById(PANEL_ID);
    if (panel) panel.remove();

    const modal = doc.getElementById(MODAL_ID);
    if (modal) modal.remove();

    const editor = doc.getElementById(EDITOR_ID);
    if (editor) editor.remove();

    const style = doc.getElementById(STYLE_ID);
    if (style) style.remove();

    if (state.keydownHandler) {
      doc.removeEventListener('keydown', state.keydownHandler, true);
      state.keydownHandler = null;
    }

    if (state.docClickHandler) {
      doc.removeEventListener('click', state.docClickHandler);
      state.docClickHandler = null;
    }

    if (state.messageActionsObserver) {
      state.messageActionsObserver.disconnect();
      state.messageActionsObserver = null;
    }

    if (state.highlightTimer) {
      clearTimeout(state.highlightTimer);
      state.highlightTimer = null;
    }

    if (state.highlightedElement) {
      state.highlightedElement.classList.remove('th-chat-search-target');
      state.highlightedElement = null;
    }

    state.cleanupEntrypoints?.();
    state.cleanupEntrypoints = null;
    doc.querySelectorAll(`#chat .${MESSAGE_FAVORITE_BUTTON_CLASS}`).forEach(button => button.remove());

    elements = null;
  }

  if (typeof parentWin.__thChatSearchCleanup === 'function') {
    try {
      parentWin.__thChatSearchCleanup();
    } catch (error) {
      logger.warn('[ChatSearch] previous cleanup failed:', error);
    }
  }
  parentWin.__thChatSearchCleanup = cleanupElements;

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;

    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${PANEL_ID} {
  --th-bg-color: var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.95));
  --th-text-color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  --th-muted-color: var(--SmartThemeEmColor, rgba(255, 255, 255, 0.75));
  --th-border-color: var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.28));
  --th-shadow-color: var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.55));
  --th-accent-color: var(--SmartThemeQuoteColor, rgba(129, 140, 248, 1));
  --th-chip-color: color-mix(in srgb, var(--th-accent-color) 32%, transparent);
  --th-scrollbar-color: color-mix(in srgb, var(--th-accent-color) 35%, transparent);
  --th-input-bg: color-mix(in srgb, var(--th-bg-color) 70%, transparent);
  --th-input-bg-focus: color-mix(in srgb, var(--th-bg-color) 60%, transparent);
  --th-input-border: color-mix(in srgb, var(--th-border-color) 70%, transparent);
  --th-highlight-color: color-mix(in srgb, var(--th-accent-color) 45%, transparent);
  --th-target-border: color-mix(in srgb, var(--th-accent-color) 65%, transparent);
  --th-inline-bg: color-mix(in srgb, var(--th-accent-color) 16%, transparent);
  --th-inline-bg-hover: color-mix(in srgb, var(--th-accent-color) 28%, transparent);
  --th-result-bg: color-mix(in srgb, var(--th-bg-color) 12%, transparent);
  --th-result-border: color-mix(in srgb, var(--th-border-color) 70%, transparent);

  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(460px, calc(100vw - 48px));
  max-height: min(620px, calc(100vh - 48px));
  display: none;
  flex-direction: column;
  gap: 12px;
  border-radius: 14px;
  padding: 18px 20px;
  z-index: 2147483000;
  border: 1px solid color-mix(in srgb, var(--th-border-color) 100%, transparent);
  background: color-mix(in srgb, var(--th-bg-color) 96%, transparent);
  color: var(--th-text-color);
  box-shadow: 0 28px 60px color-mix(in srgb, var(--th-shadow-color) 72%, transparent);
  backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px));
}
#${PANEL_ID}.th-visible {
  display: flex;
}
#${PANEL_ID}.th-hidden {
  display: none;
}

#${PANEL_ID} .th-chat-search-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
  font-weight: 600;
  font-size: 16px;
}

#${PANEL_ID} .th-chat-search-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

#${PANEL_ID} .th-actions-menu {
  position: relative;
}

#${PANEL_ID} .th-actions-toggle {
  padding: 6px 10px;
  min-width: 36px;
}

#${PANEL_ID} .th-actions-toggle span {
  display: none;
}

#${PANEL_ID} .th-actions-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--th-bg-color) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--th-border-color) 90%, transparent);
  box-shadow: 0 18px 45px color-mix(in srgb, var(--th-shadow-color) 68%, transparent);
  backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10px) * 1.25));
  z-index: 10;
  scrollbar-gutter: stable;

  opacity: 0;
  transform: translateY(6px) scale(0.98);
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s ease;
}

#${PANEL_ID} .th-actions-popover::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.04));
  opacity: 0.9;
  pointer-events: none;
}

#${PANEL_ID} .th-actions-popover.th-popover-open {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
  visibility: visible;
}

#${PANEL_ID} .th-actions-popover .th-inline-button {
  position: relative;
  width: 100%;
  justify-content: flex-start;
  padding: 8px 12px;
  gap: 10px;
  min-height: 36px;
  border-radius: 10px;
}

.extraMesButtons .th-chat-search-mes-favorite {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
}

.extraMesButtons .th-chat-search-mes-favorite svg {
  width: 1em;
  height: 1em;
  display: block;
  fill: currentColor;
  pointer-events: none;
}

#${PANEL_ID} .th-chat-search-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

#${PANEL_ID} .th-tab {
  background: none;
  border: none;
  color: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
  padding: 6px 12px;
  opacity: 0.5;
  transition: opacity 0.18s ease, background 0.18s ease;
}
#${PANEL_ID} .th-tab:hover {
  opacity: 0.75;
  background: color-mix(in srgb, var(--th-text-color) 8%, transparent);
}
#${PANEL_ID} .th-tab.th-tab-active {
  opacity: 1;
  background: var(--th-inline-bg);
}

#${PANEL_ID} .th-chat-search-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  border-radius: 999px;
  padding: 4px 8px;
  transition: background 0.18s ease, color 0.18s ease;
}
#${PANEL_ID} .th-chat-search-close:hover {
  background: color-mix(in srgb, var(--th-text-color) 12%, transparent);
}

#${PANEL_ID} .th-chat-search-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

#${PANEL_ID} .th-chat-search-controls input {
  flex: 1;
  background: var(--th-input-bg);
  border: 1px solid var(--th-input-border);
  border-radius: 8px;
  padding: 8px 10px;
  color: inherit;
  font-size: 14px;
  outline: none;
  transition: border 0.18s ease, background 0.18s ease;
}
#${PANEL_ID} .th-chat-search-controls input:focus {
  border-color: color-mix(in srgb, var(--th-accent-color) 70%, transparent);
  background: var(--th-input-bg-focus);
}

#${PANEL_ID} .th-inline-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 0.93em;
  min-height: 32px;
  border-radius: 8px;
  background: var(--th-inline-bg);
  border: 1px solid color-mix(in srgb, var(--th-accent-color) 40%, transparent);
  color: inherit;
  transition: background 0.18s ease, border 0.18s ease, transform 0.18s ease;
}
#${PANEL_ID} .th-inline-button:hover {
  background: var(--th-inline-bg-hover);
  transform: translateY(-1px);
}
#${PANEL_ID} .th-inline-button:active {
  transform: translateY(0);
}
#${PANEL_ID} .th-inline-button i {
  font-size: 0.93em;
}

#${COUNTER_ID} {
  font-size: 0.93em;
  opacity: 0.8;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#${RESULT_ID} {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 220px;
  padding-right: 4px;
  scrollbar-gutter: stable;
}
#${RESULT_ID}::-webkit-scrollbar {
  width: 3px;
}
#${RESULT_ID}::-webkit-scrollbar-track {
  background: transparent;
}
#${RESULT_ID}::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--th-scrollbar-color) 50%, transparent);
  border-radius: 4px;
}
#${RESULT_ID}::-webkit-scrollbar-thumb:hover {
  background: var(--th-scrollbar-color);
}

#${PANEL_ID} .th-chat-search-result {
  border: 1px solid var(--th-result-border);
  border-radius: 10px;
  padding: 10px;
  background: var(--th-result-bg);
  transition: border 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
  cursor: pointer;
}
#${PANEL_ID} .th-chat-search-result:hover {
  border-color: var(--th-accent-color);
  background: color-mix(in srgb, var(--th-accent-color) 8%, transparent);
}
#${PANEL_ID} .th-chat-search-result.th-selected {
  border-color: var(--th-accent-color);
  background: color-mix(in srgb, var(--th-accent-color) 18%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--th-accent-color) 40%, transparent);
}
#${PANEL_ID} .th-chat-search-result-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
#${PANEL_ID} .th-chat-search-result-title {
  font-weight: 600;
}
#${PANEL_ID} .th-edit-icon {
  font-size: 0.93em;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.18s ease;
  margin-left: 4px;
}
#${PANEL_ID} .th-edit-icon:hover {
  opacity: 1;
}

#${PANEL_ID} .th-badge {
  font-size: 0.79em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--th-chip-color);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

#${PANEL_ID} .th-chat-search-result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
#${PANEL_ID} .th-chat-search-result-actions .menu_button {
  flex: 1 1 0;
}

#${PANEL_ID} .th-match-nav {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 0.86em;
  opacity: 0.75;
  margin-top: 8px;
  margin-bottom: 4px;
}
#${PANEL_ID} .th-match-nav.th-visible {
  display: flex;
}
#${PANEL_ID} .th-match-nav-btn {
  background: var(--th-inline-bg);
  border: 1px solid color-mix(in srgb, var(--th-accent-color) 30%, transparent);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 0.79em;
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
#${PANEL_ID} .th-match-nav-btn:hover {
  opacity: 1;
}
#${PANEL_ID} .th-match-nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

#${PANEL_ID} .th-chat-search-result-snippet {
  font-size: 0.93em;
  line-height: 1.5;
  opacity: 0.85;
  margin-top: 6px;
  display: none;
}
#${PANEL_ID} .th-chat-search-result-snippet.th-expanded {
  display: block;
}

#${EMPTY_ID} {
  font-size: 0.93em;
  opacity: 0.72;
  text-align: center;
  padding: 12px 0;
}

#${PANEL_ID} mark {
  background: var(--th-highlight-color);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}

.th-chat-search-target {
  animation: th-chat-search-pulse 1.6s ease-in-out 2;
  box-shadow: 0 0 0 2px var(--th-target-border) inset,
    0 0 20px color-mix(in srgb, var(--th-accent-color) 40%, transparent);
  border-radius: 14px !important;
}

@keyframes th-chat-search-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--th-accent-color) 85%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--th-accent-color) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--th-accent-color) 85%, transparent); }
}

@media (max-width: 900px) {
  #${PANEL_ID} {
    width: min(420px, calc(100vw - 32px));
    max-height: min(580px, calc(100vh - 36px));
  }
}

@media (max-width: 680px) {
  #${PANEL_ID} {
    top: calc(80px + env(safe-area-inset-top));
    transform: translateX(-50%);
    width: calc(100vw - 24px);
    max-height: calc(100vh - env(safe-area-inset-top) - 96px);
    padding: 16px;
    border-radius: 12px;
  }
  #${PANEL_ID} .th-chat-search-result-actions {
    flex-wrap: nowrap;
  }
  #${PANEL_ID} .th-chat-search-result-actions .menu_button {
    flex: 1 1 0;
  }
}

@media (max-width: 480px) {
  #${PANEL_ID} {
    top: calc(80px + env(safe-area-inset-top));
    width: calc(100vw - 16px);
    max-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 96px);
    padding: 14px;
  }
  #${RESULT_ID} {
    max-height: min(240px, 60vh);
  }
  #${PANEL_ID} .th-chat-search-result-actions {
    flex-wrap: nowrap;
  }
  #${PANEL_ID} .th-chat-search-result-actions .menu_button {
    flex: 1 1 0;
  }
}

.th-fav-subtitle {
  font-size: 0.93em;
  line-height: 1.5;
  color: var(--th-muted-color);
  margin-top: 6px;
  margin-bottom: 8px;
  font-style: italic;
  opacity: 0.85;
}

#${MODAL_ID} {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483647;
  display: none;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s ease;
}

#${MODAL_ID}.th-modal-visible {
  display: flex;
  opacity: 1;
}

.th-modal-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.88)) 92%, transparent);
}

.th-modal-content {
  position: relative;
  width: min(680px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.92)) 95%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.25)) 80%, transparent);
  border-radius: 20px;
  padding: 0;
  overflow: hidden;
  box-shadow: 0 32px 80px color-mix(in srgb, var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.7)) 85%, transparent);
  backdrop-filter: blur(var(--SmartThemeBlurStrength, 12px));
  animation: th-modal-fadein 0.3s ease;
}

@keyframes th-modal-fadein {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(20px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.th-modal-close {
  position: absolute;
  top: 20px;
  right: 20px;
  background: none;
  border: none;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  font-size: 28px;
  line-height: 1;
  width: 40px;
  height: 40px;
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.th-modal-close:hover {
  opacity: 1;
  transform: rotate(90deg);
}

.th-modal-export {
  position: absolute;
  top: 20px;
  right: 70px;
  background: none;
  border: none;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  font-size: 14px;
  line-height: 1;
  width: 40px;
  height: 40px;
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.th-modal-export:hover {
  opacity: 1;
  transform: scale(1.1);
}

.th-modal-edit {
  position: absolute;
  top: 20px;
  right: 120px;
  background: none;
  border: none;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  font-size: 14px;
  line-height: 1;
  width: 40px;
  height: 40px;
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.th-modal-edit:hover {
  opacity: 1;
  transform: scale(1.1);
}

.th-modal-load {
  position: absolute;
  top: 20px;
  right: 170px;
  background: none;
  border: none;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  font-size: 14px;
  line-height: 1;
  width: 40px;
  height: 40px;
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.th-modal-load:hover {
  opacity: 1;
  transform: scale(1.1);
}

.th-modal-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 48px;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.85)) 90%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.3)) 60%, transparent);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.6;
  transition: opacity 0.2s ease, transform 0.2s ease, background 0.2s ease;
  z-index: 10;
}

.th-modal-nav:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.95)) 95%, transparent);
  transform: translateY(-50%) scale(1.05);
}

.th-modal-nav:active {
  transform: translateY(-50%) scale(0.95);
}

.th-modal-nav:disabled {
  opacity: 0.25;
  cursor: not-allowed;
  pointer-events: none;
}

.th-modal-nav-prev {
  left: 20px;
}

.th-modal-nav-next {
  right: 20px;
}

.th-modal-nav i {
  font-size: 18px;
}

.th-modal-body {
  padding: 56px 64px;
  overflow-y: auto;
  max-height: calc(100vh - 96px);
  text-align: center;
  /* Hide scrollbar while keeping content scrollable */
  -ms-overflow-style: none; /* IE, Edge */
  scrollbar-width: none;    /* Firefox */
}

.th-modal-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.th-modal-body::-webkit-scrollbar-track {
  background: transparent;
}
.th-modal-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, rgba(129, 140, 248, 1)) 15%, transparent);
  border-radius: 4px;
}
.th-modal-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, rgba(129, 140, 248, 1)) 30%, transparent);
}

.th-modal-title {
  font-size: 1.86em;
  font-weight: 400;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  margin: 0 auto 12px;
  line-height: 1.4;
  letter-spacing: 0.15em;
  position: relative;
  display: block;
  text-transform: uppercase;
  padding-bottom: 16px;
  max-width: 85%;
}

.th-modal-title::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 60%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.3)) 60%, transparent) 20%,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.5)) 80%, transparent) 50%,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.3)) 60%, transparent) 80%,
    transparent
  );
}

.th-modal-subtitle {
  font-size: 1.14em;
  line-height: 1.75;
  color: var(--SmartThemeEmColor, rgba(255, 255, 255, 0.7));
  margin: 28px auto 44px;
  opacity: 0.85;
  max-width: 85%;
  position: relative;
  padding: 16px 32px;
  font-style: italic;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.08)) 30%, transparent) 20%,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.08)) 30%, transparent) 80%,
    transparent
  );
}

.th-modal-subtitle::before {
  content: '—';
  position: absolute;
  left: 8px;
  opacity: 0.4;
}

.th-modal-subtitle::after {
  content: '—';
  position: absolute;
  right: 8px;
  opacity: 0.4;
}

.th-modal-message {
  font-size: 1.14em;
  line-height: 1.9;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  margin: 0 auto 40px;
  text-align: left;
  max-width: 90%;
  opacity: 0.92;
  quotes: none;
}

.th-modal-message * {
  quotes: none;
}

.th-modal-message q::before,
.th-modal-message q::after {
  content: '' !important;
}

.th-modal-message .mes_img_container {
  pointer-events: none;
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
  width: 100%;
}

.th-modal-message .mes_img_container img {
  max-width: 100%;
  height: auto;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.th-modal-message .mes_img_container * {
  pointer-events: none;
}

.th-modal-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 36px;
  margin-top: 36px;
  position: relative;
  font-size: 0.86em;
  color: var(--SmartThemeEmColor, rgba(255, 255, 255, 0.5));
  gap: 10px;
}

.th-modal-meta::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 40%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.2)) 50%, transparent) 30%,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.3)) 60%, transparent) 50%,
    color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.2)) 50%, transparent) 70%,
    transparent
  );
}

.th-modal-source {
  font-weight: 400;
  opacity: 0.75;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-size: 0.79em;
  position: relative;
  padding: 0 20px;
  text-align: center;
  white-space: nowrap;
}

.th-modal-source::before,
.th-modal-source::after {
  content: '·';
  position: absolute;
  opacity: 0.3;
  font-size: 0.57em;
}

.th-modal-source::before {
  left: 0;
}

.th-modal-source::after {
  right: 0;
}

.th-modal-time {
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
  font-size: 0.71em;
  letter-spacing: 0.08em;
  font-family: 'Courier New', monospace;
  text-align: center;
}

.th-fav-edited-text {
  text-align: left;
}

@media (max-width: 768px) {
  .th-modal-content {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    border-radius: 16px;
  }

  .th-modal-body {
    padding: 44px 36px;
    max-height: calc(100vh - 64px);
  }

  .th-modal-title {
    font-size: 22px;
    letter-spacing: 0.12em;
    padding-bottom: 14px;
  }

  .th-modal-title::after {
    width: 70%;
  }

  .th-modal-subtitle {
    font-size: 15px;
    max-width: 85%;
    padding: 14px 28px;
    margin: 24px auto 40px;
  }

  .th-modal-message {
    font-size: 15px;
    line-height: 1.8;
    max-width: 95%;
  }

  .th-modal-close {
    top: 16px;
    right: 16px;
    width: 36px;
    height: 36px;
    font-size: 24px;
  }

  .th-modal-export {
    top: 16px;
    right: 62px;
    width: 36px;
    height: 36px;
    font-size: 16px;
  }

  .th-modal-edit {
    top: 16px;
    right: 108px;
    width: 36px;
    height: 36px;
    font-size: 16px;
  }

  .th-modal-load {
    top: 16px;
    right: 154px;
    width: 36px;
    height: 36px;
    font-size: 16px;
  }

  .th-modal-nav {
    width: 42px;
    height: 42px;
  }

  .th-modal-nav-prev {
    left: 16px;
  }

  .th-modal-nav-next {
    right: 16px;
  }
}

@media (max-width: 480px) {
  #${MODAL_ID} {
    align-items: flex-start;
    padding-top: 20px;
  }

  .th-modal-content {
    width: calc(100vw - 24px);
    max-height: calc(100vh - 140px);
    border-radius: 14px;
  }

  .th-modal-body {
    padding: 30px 22px;
    max-height: calc(100vh - 140px);
  }

  .th-modal-title {
    font-size: 20px;
    letter-spacing: 0.1em;
    padding-bottom: 12px;
  }

  .th-modal-title::after {
    width: 80%;
  }

  .th-modal-subtitle {
    font-size: 14px;
    margin: 20px auto 36px;
    max-width: 90%;
    padding: 12px 24px;
  }

  .th-modal-message {
    font-size: 14px;
    line-height: 1.75;
    margin-bottom: 32px;
    max-width: 100%;
  }

  .th-modal-meta {
    gap: 8px;
    padding-top: 32px;
    margin-top: 32px;
  }

  .th-modal-meta::before {
    width: 50%;
  }

  .th-modal-close {
    top: 12px;
    right: 12px;
    width: 32px;
    height: 32px;
    font-size: 22px;
  }

  .th-modal-export {
    top: 12px;
    right: 54px;
    width: 32px;
    height: 32px;
    font-size: 14px;
  }

  .th-modal-edit {
    top: 12px;
    right: 94px;
    width: 32px;
    height: 32px;
    font-size: 14px;
  }

  .th-modal-load {
    top: 12px;
    right: 134px;
    width: 32px;
    height: 32px;
    font-size: 14px;
  }

  .th-modal-nav {
    width: 38px;
    height: 38px;
  }

  .th-modal-nav-prev {
    left: 12px;
  }

  .th-modal-nav-next {
    right: 12px;
  }

  .th-modal-nav i {
    font-size: 16px;
  }
}

/* 收藏编辑器 */
#${EDITOR_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
}

#${EDITOR_ID} .th-fav-editor-backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.88)) 92%, transparent);
}

#${EDITOR_ID} .th-fav-editor-content {
  position: relative;
  width: min(720px, calc(100vw - 36px));
  max-height: calc(100vh - 72px);
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.92)) 95%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.25)) 80%, transparent);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 32px 80px color-mix(in srgb, var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.7)) 85%, transparent);
  backdrop-filter: blur(var(--SmartThemeBlurStrength, 12px));
  display: flex;
  flex-direction: column;
}

#${EDITOR_ID} .th-fav-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.18)) 80%, transparent);
}

#${EDITOR_ID} .th-fav-editor-title {
  font-weight: 600;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
}

#${EDITOR_ID} .th-fav-editor-close {
  background: none;
  border: none;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  font-size: 24px;
  line-height: 1;
  width: 34px;
  height: 34px;
  cursor: pointer;
  opacity: 0.75;
}

#${EDITOR_ID} .th-fav-editor-close:hover {
  opacity: 1;
}

#${EDITOR_ID} .th-fav-editor-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

#${EDITOR_ID} .th-fav-editor-body {
  padding: 16px 18px 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}

#${EDITOR_ID} .th-fav-editor-label {
  display: block;
  margin-bottom: 12px;
}

#${EDITOR_ID} .th-fav-editor-label span {
  display: block;
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 6px;
}

#${EDITOR_ID} .th-fav-editor-input,
#${EDITOR_ID} .th-fav-editor-rich {
  width: 100%;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(15, 16, 24, 0.55)) 86%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.22)) 70%, transparent);
  border-radius: 12px;
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  padding: 10px 12px;
}

#${EDITOR_ID} .th-fav-editor-rich {
  min-height: 220px;
  line-height: 1.45;
  overflow: auto;
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgba(0, 0, 0, 0.18) 60%, transparent);
  quotes: none;
}

#${EDITOR_ID} .th-fav-editor-rich:focus {
  border-color: color-mix(in srgb, var(--th-accent-color) 70%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--th-accent-color) 42%, transparent),
    0 0 0 3px color-mix(in srgb, var(--th-accent-color) 16%, transparent);
}

#${EDITOR_ID} .th-fav-editor-rich * {
  quotes: none;
}

#${EDITOR_ID} .th-fav-editor-rich q::before,
#${EDITOR_ID} .th-fav-editor-rich q::after {
  content: '' !important;
}

#${EDITOR_ID} .th-fav-editor-actions {
  display: flex;
  gap: 14px;
  flex-wrap: nowrap;
  justify-content: center;
  padding: 12px 18px calc(18px + env(safe-area-inset-bottom, 0px));
  margin-top: 0;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.18)) 80%, transparent);
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, rgba(18, 19, 27, 0.86)) 95%, transparent);
  backdrop-filter: blur(var(--SmartThemeBlurStrength, 12px));
}

#${EDITOR_ID} .th-fav-editor-actions .menu_button {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 92px;
  height: 76px;
  padding: 10px 12px;
  border-radius: 16px;
  background: color-mix(in srgb, rgba(255, 255, 255, 0.10) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, rgba(129, 140, 248, 0.22)) 70%, transparent);
  color: var(--SmartThemeBodyColor, var(--text-color-high, #f5f6ff));
  transition: transform 0.12s ease, background 0.18s ease, border 0.18s ease, opacity 0.18s ease;
}

#${EDITOR_ID} .th-fav-editor-actions .menu_button:hover {
  background: color-mix(in srgb, rgba(255, 255, 255, 0.16) 70%, transparent);
  border-color: color-mix(in srgb, var(--th-accent-color) 40%, transparent);
  transform: translateY(-1px);
}

#${EDITOR_ID} .th-fav-editor-actions .menu_button:active {
  transform: translateY(0);
  opacity: 0.92;
}

#${EDITOR_ID} .th-fav-editor-actions .menu_button i {
  font-size: 18px;
  opacity: 0.85;
}

#${EDITOR_ID} .th-fav-editor-actions .menu_button span {
  font-size: 13px;
  letter-spacing: 0.02em;
  opacity: 0.9;
}

@media (max-width: 480px) {
  #${EDITOR_ID} {
    align-items: flex-start;
    padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  }

  #${EDITOR_ID} .th-fav-editor-content {
    width: calc(100vw - 24px);
    height: calc(100dvh - 24px - env(safe-area-inset-bottom, 0px));
    max-height: calc(100dvh - 24px - env(safe-area-inset-bottom, 0px));
    border-radius: 16px;
  }

  #${EDITOR_ID} .th-fav-editor-body {
    padding: 14px 14px 0;
  }

  #${EDITOR_ID} .th-fav-editor-actions {
    padding: 12px 14px calc(22px + env(safe-area-inset-bottom, 0px));
    gap: 12px;
  }

  #${EDITOR_ID} .th-fav-editor-actions .menu_button {
    min-width: 86px;
    height: 72px;
    border-radius: 14px;
  }
}

/* 仅展示图片：隐藏图片控制按钮/悬停浮层 */
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container button,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .menu_button,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .right_menu_button,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_controls,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_swipes,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_swipe_counter,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_enlarge,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_caption,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_delete,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_swipe_left,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_img_swipe_right,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .img_controls,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .img_control,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container .mes_buttons,
.th-modal-message .mes_img_container button,
.th-modal-message .mes_img_container .menu_button,
.th-modal-message .mes_img_container .right_menu_button,
.th-modal-message .mes_img_container .mes_img_controls,
.th-modal-message .mes_img_container .mes_img_swipes,
.th-modal-message .mes_img_container .mes_img_swipe_counter,
.th-modal-message .mes_img_container .mes_img_enlarge,
.th-modal-message .mes_img_container .mes_img_caption,
.th-modal-message .mes_img_container .mes_img_delete,
.th-modal-message .mes_img_container .mes_img_swipe_left,
.th-modal-message .mes_img_container .mes_img_swipe_right,
.th-modal-message .mes_img_container .img_controls,
.th-modal-message .mes_img_container .img_control,
.th-modal-message .mes_img_container .mes_buttons {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
}

#${EDITOR_ID} .th-fav-editor-rich .mes_img_container img,
#${EDITOR_ID} .th-fav-editor-rich .mes_img_container a,
.th-modal-message .mes_img_container img,
.th-modal-message .mes_img_container a {
  pointer-events: none !important;
}

#${EDITOR_ID} .th-fav-editor-rich .mes_img_container,
.th-modal-message .mes_img_container {
  pointer-events: none !important;
}

#${EDITOR_ID} .th-fav-editor-rich .mes_img_container img,
.th-modal-message .mes_img_container img {
  max-width: 100%;
  height: auto;
}

.th-gallery-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.th-character-card {
  display: grid;
  grid-template-columns: 60px 1fr 60px;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--th-border-color);
  border-radius: 10px;
  background: var(--th-result-bg);
  cursor: pointer;
  transition: border 0.18s ease, background 0.18s ease;
}

.th-character-card:hover {
  border-color: var(--th-accent-color);
  background: color-mix(in srgb, var(--th-accent-color) 12%, transparent);
}

.th-card-date {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: 'Georgia', serif;
  color: var(--th-accent-color);
  opacity: 0.85;
  letter-spacing: 0.05em;
}

.th-card-date-day {
  font-size: 1.5em;
  font-weight: 600;
}

.th-card-date-year {
  font-size: 0.85em;
  opacity: 0.7;
  margin-top: 4px;
}

.th-card-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.th-character-card .th-card-content {
  padding-left: 18px;
  position: relative;
}

.th-character-card .th-card-content::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  width: 1px;
  height: 70%;
  background: var(--th-accent-color);
  opacity: 0.5;
}

.th-card-title {
  font-size: 1.1em;
  font-weight: 600;
  color: var(--th-text-color);
  letter-spacing: 0.02em;
}

.th-card-subtitle {
  font-size: 0.9em;
  color: var(--th-muted-color);
  opacity: 0.75;
}

.th-card-cover {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  border: 1px solid var(--th-border-color);
  object-fit: cover;
  background: var(--th-inline-bg);
}

.th-favorite-card-horizontal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--th-result-border);
  border-radius: 10px;
  background: var(--th-result-bg);
  margin-bottom: 12px;
  transition: border 0.18s ease, background 0.18s ease;
  cursor: pointer;
}

.th-favorite-card-horizontal:hover {
  border-color: var(--th-accent-color);
  background: color-mix(in srgb, var(--th-accent-color) 8%, transparent);
}

.th-card-wrapper {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.th-card-wrapper .th-card-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.th-card-cover-large {
  width: 85px;
  height: 85px;
  border-radius: 8px;
  border: 1px solid var(--th-border-color);
  object-fit: cover;
  background: var(--th-inline-bg);
  flex-shrink: 0;
}

.th-gallery-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.th-gallery-actions .th-inline-button {
  width: 100%;
  white-space: nowrap;
}

.th-gallery-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--th-muted-color);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 10px;
  font-size: 0.9em;
  opacity: 0.8;
}

.th-gallery-back:hover {
  background: var(--th-inline-bg);
  color: var(--th-text-color);
  border-color: color-mix(in srgb, var(--th-accent-color) 20%, transparent);
  opacity: 1;
}

@keyframes th-fade-in-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.th-animate-in {
  animation: th-fade-in-up 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  opacity: 0;
}
`;

    doc.head.appendChild(style);
  }

  function createIconButton(iconClass, labelText) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'menu_button menu_button_icon th-inline-button';
    button.setAttribute('aria-label', labelText);
    button.innerHTML = `<i class="fa-solid ${iconClass}"></i><span>${labelText}</span>`;
    return button;
  }

  function buildImagesContainerHtml(images) {
    if (!Array.isArray(images) || images.length === 0) return '';
    const imgs = images
      .map(img => {
        const src = img?.thumbnail || img?.originalSrc;
        if (!src) return '';
        return `<img src="${escapeHtml(src)}" style="max-width: 100%; height: auto;" />`;
      })
      .filter(Boolean)
      .join('');
    if (!imgs) return '';
    return `<div class="mes_img_container">${imgs}</div>`;
  }

  function buildFavoriteContentHtml(fav) {
    if (fav?.messageHtml) return String(fav.messageHtml);

    if (fav?.editedMessageHtml) return String(fav.editedMessageHtml);

    if (fav?.editedMessage != null) {
      const text = String(fav.editedMessage);
      const html = escapeHtml(text).replace(/\r\n|\n|\r/g, '<br>');
      return `<div class="th-fav-edited-text">${html}</div>${buildImagesContainerHtml(fav.images)}`;
    }

    return escapeHtml(fav?.message ?? '').replace(/\r\n|\n|\r/g, '<br>');
  }

  function buildEditableHtmlFromFavorite(fav) {
    if (fav?.messageHtml) return String(fav.messageHtml);
    if (fav?.editedMessageHtml) return String(fav.editedMessageHtml);

    if (fav?.editedMessage != null) {
      const text = String(fav.editedMessage);
      return escapeHtml(text).replace(/\r\n|\n|\r/g, '<br>');
    }

    const fallback = String(fav?.message ?? '');
    if (!fallback) return '';
    return escapeHtml(fallback).replace(/\r\n|\n|\r/g, '<br>');
  }

  async function openFavoriteEditor(fav) {
    if (!fav) return;

    try {
      await hydrateFavoritePayload(fav);
    } catch (error) {
      logger.warn('[ChatSearch] failed to load favorite payload:', error);
    }

    const existing = doc.getElementById(EDITOR_ID);
    if (existing) existing.remove();

    const wrapper = doc.createElement('div');
    wrapper.id = EDITOR_ID;
    wrapper.className = 'th-fav-editor';

    let currentHtml = buildEditableHtmlFromFavorite(fav);
    if (!currentHtml && isFavoriteChat(fav)) {
      const renderedContent = getRenderedMessageContent(fav.messageId);
      currentHtml = renderedContent ? String(renderedContent) : '';
    }
    const titleValue = String(fav.title ?? '');
    const subtitleValue = String(fav.subtitle ?? '');

    wrapper.innerHTML = `
      <div class="th-fav-editor-backdrop"></div>
      <div class="th-fav-editor-content" role="dialog" aria-modal="true">
        <div class="th-fav-editor-header">
          <div class="th-fav-editor-title">编辑收藏</div>
          <button type="button" class="th-fav-editor-close" aria-label="关闭">×</button>
        </div>
        <div class="th-fav-editor-form">
          <div class="th-fav-editor-body">
            <label class="th-fav-editor-label">
              <span>标题</span>
              <input type="text" class="th-fav-editor-input th-fav-editor-title-input" value="${escapeHtml(titleValue)}" />
            </label>
            <label class="th-fav-editor-label">
              <span>副标题（金句/台词）</span>
              <input type="text" class="th-fav-editor-input th-fav-editor-subtitle-input" value="${escapeHtml(subtitleValue)}" />
            </label>
            <label class="th-fav-editor-label">
              <span>正文（保留收藏时的前端渲染/隐藏逻辑）</span>
              <div class="th-fav-editor-rich" contenteditable="true" spellcheck="false"></div>
            </label>
          </div>
          <div class="th-fav-editor-actions">
            <button type="button" class="menu_button th-fav-editor-save"><i class="fa-solid fa-check"></i><span>保存</span></button>
            <button type="button" class="menu_button th-fav-editor-cancel"><i class="fa-solid fa-xmark"></i><span>取消</span></button>
          </div>
        </div>
      </div>
    `;

    doc.body.appendChild(wrapper);

    const backdrop = wrapper.querySelector('.th-fav-editor-backdrop');
    const closeBtn = wrapper.querySelector('.th-fav-editor-close');
    const cancelBtn = wrapper.querySelector('.th-fav-editor-cancel');
    const saveBtn = wrapper.querySelector('.th-fav-editor-save');
    const titleInput = wrapper.querySelector('.th-fav-editor-title-input');
    const subtitleInput = wrapper.querySelector('.th-fav-editor-subtitle-input');
    const richInput = wrapper.querySelector('.th-fav-editor-rich');

    const close = () => {
      wrapper.remove();
    };

    backdrop.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);

    if (richInput) {
      richInput.innerHTML = safeFavoriteHtml(currentHtml);
      richInput.querySelectorAll('img').forEach(img => {
        img.setAttribute('contenteditable', 'false');
        img.setAttribute('draggable', 'false');
      });
    }

    saveBtn.addEventListener('click', async () => {
      const newTitle = String(titleInput.value ?? '').trim();
      const newSubtitle = String(subtitleInput.value ?? '').trim();
      const newHtml = String(richInput?.innerHTML ?? '');

      fav.title = newTitle || `消息 #${fav.messageId}`;
      fav.subtitle = newSubtitle;
      fav.updatedAt = Date.now();

      fav.messageHtml = newHtml;
      fav.message = collapseWhitespace(stripTags(newHtml));
      delete fav.editedMessage;
      delete fav.editedMessageHtml;
      delete fav.editedAt;
      delete fav.originalMessageHtml;
      delete fav.originalMessage;

      await updateFavoriteDB(fav);
      await reloadFavorites();
      close();
      if (state.modalVisible) void openReadingModal(fav);
    });

    setTimeout(() => {
      titleInput?.focus?.();
      titleInput?.select?.();
    }, 0);
  }

  function coerceTimestamp(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  function normalizeFavoriteForSync(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const fav = { ...raw };

    delete fav.coverThumbnail;
    delete fav.hasImages;
    delete fav.__payloadLoaded;

    if (!fav.uuid) fav.uuid = generateUuid();

    const createdAt = coerceTimestamp(fav.createdAt, 0) || Date.now();
    fav.createdAt = createdAt;
    fav.updatedAt = coerceTimestamp(fav.updatedAt, createdAt);

    if (fav.deletedAt != null) {
      fav.deletedAt = coerceTimestamp(fav.deletedAt, 0) || Date.now();
    } else {
      fav.deletedAt = null;
    }

    return fav;
  }

  function normalizePreviewText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, PREVIEW_TEXT_MAX_LEN);
  }

  function toMetaFavoriteForSync(raw) {
    const fav = normalizeFavoriteForSync(raw);
    if (!fav) return null;

    if (fav.id != null) delete fav.id;

    FAVORITE_PAYLOAD_FIELDS.forEach(key => {
      if (hasOwn(fav, key)) delete fav[key];
    });

    const previewText = normalizePreviewText(fav.previewText);
    if (previewText) {
      fav.previewText = previewText;
    } else {
      delete fav.previewText;
    }

    return fav;
  }
  function downloadJsonFile(filename, data) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return blob.size;
  }

  async function exportFavorites(options = {}) {
    const { mode = 'full', includeDeleted = false } = options ?? {};
    const resolvedMode = mode === 'meta' ? 'meta' : 'full';
    const includePayload = resolvedMode === 'full';

    const all = await getAllFavoritesDB({ includePayload });
    const favorites = all.filter(fav => includeDeleted || !fav?.deletedAt);

    const exportedFavorites =
      resolvedMode === 'meta'
        ? favorites.map(item => toMetaFavoriteForSync(item)).filter(Boolean)
        : favorites
            .map(item => {
              const norm = normalizeFavoriteForSync(item);
              if (!norm) return null;
              if (norm.id != null) delete norm.id;
              const previewText = normalizePreviewText(norm.previewText);
              if (previewText) {
                norm.previewText = previewText;
              } else {
                delete norm.previewText;
              }
              return norm;
            })
            .filter(Boolean);

    const payload = {
      format: 'th-chat-favorites-export',
      version: 1,
      mode: resolvedMode,
      exportedAt: Date.now(),
      favorites: exportedFavorites,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chat-favorites-${resolvedMode}-${stamp}.json`;
    const sizeBytes = downloadJsonFile(filename, payload);

    if (notifier?.success) {
      const kb = Math.round((sizeBytes / 1024) * 10) / 10;
      notifier.success(`已导出 ${exportedFavorites.length} 条收藏（${kb} KB）`);
    }
  }

  async function exportFavoritesInteractive() {
    try {
      await exportFavorites({ mode: 'full', includeDeleted: true });
    } catch (error) {
      logger.error('[ChatSearch] export failed:', error);
      if (notifier?.error) notifier.error('导出失败，详见控制台。');
    }
  }

  function extractFavoritesFromImportPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.favorites)) return payload.favorites;
    return convertV1Backup(payload);
  }

  function pickJsonFile() {
    return new Promise(resolve => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.style.display = 'none';

      const cleanup = () => {
        input.remove();
      };

      input.addEventListener(
        'change',
        () => {
          const file = input.files?.[0] ?? null;
          cleanup();
          resolve(file);
        },
        { once: true },
      );

      doc.body.appendChild(input);
      input.click();
    });
  }

  async function importFavoritesInteractive() {
    try {
      const file = await pickJsonFile();
      if (!file) return;

      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const list = extractFavoritesFromImportPayload(parsed);
      if (!Array.isArray(list)) {
        throw new Error('Invalid import file: favorites array not found');
      }

      const overwrite = await askConfirm(
        '导入策略：遇到同 uuid 冲突时，是否用导入数据覆盖本地？\n\n确定：覆盖本地\n取消：保留较新版本（推荐）',
      );

      const result = await importFavorites(list, { overwrite });
      await reloadFavorites();

      if (notifier?.success) notifier.success(`导入完成：新增/更新 ${result.imported} 条，跳过 ${result.skipped} 条`);
    } catch (error) {
      logger.error('[ChatSearch] import failed:', error);
      if (notifier?.error) notifier.error('导入失败，详见控制台。');
    }
  }

  async function importFavorites(list, options = {}) {
    const { overwrite = false, keepExisting = false } = options ?? {};

    let imported = 0;
    let skipped = 0;

    for (const item of list) {
      const norm = normalizeFavoriteForSync(item);
      if (!norm) continue;
      if (norm.id != null) delete norm.id;

      const previewText = normalizePreviewText(norm.previewText);
      if (previewText) {
        norm.previewText = previewText;
      } else {
        delete norm.previewText;
      }

      const isDeleted = norm.deletedAt != null;
      if (isDeleted) {
        norm.hasImages = false;
        norm.coverThumbnail = null;
        FAVORITE_PAYLOAD_FIELDS.forEach(key => {
          if (hasOwn(norm, key)) delete norm[key];
        });
        delete norm.__payloadLoaded;
      }

      const existing = await getFavoriteByUuidDB(norm.uuid);
      if (existing?.id != null) {
        const localTime = coerceTimestamp(existing?.updatedAt, coerceTimestamp(existing?.createdAt, 0));
        const importTime = coerceTimestamp(norm?.updatedAt, coerceTimestamp(norm?.createdAt, 0));
        if (keepExisting || (!overwrite && localTime > importTime)) {
          skipped++;
          continue;
        }

        const merged = { ...existing, ...norm, id: existing.id };
        await updateFavoriteDB(merged);
        if (isDeleted && merged.uuid) {
          try {
            await deleteFavoritePayloadByUuidDB(merged.uuid);
          } catch (error) {
            logger.warn('[ChatSearch] failed to purge payload for imported deleted favorite:', error);
          }
        }
        imported++;
        continue;
      }

      await addFavoriteDB(norm);
      if (isDeleted && norm.uuid) {
        try {
          await deleteFavoritePayloadByUuidDB(norm.uuid);
        } catch (error) {
          logger.warn('[ChatSearch] failed to purge payload for imported deleted favorite:', error);
        }
      }
      imported++;
    }

    return { imported, skipped };
  }

  function buildUI() {
    const panel = doc.createElement('section');
    panel.id = PANEL_ID;
    panel.classList.add('th-hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const header = doc.createElement('div');
    header.className = 'th-chat-search-header';

    const tabs = doc.createElement('div');
    tabs.className = 'th-chat-search-tabs';
    const searchTab = doc.createElement('button');
    searchTab.type = 'button';
    searchTab.className = 'th-tab th-tab-active';
    searchTab.textContent = '搜索';
    searchTab.dataset.mode = 'search';
    const favTab = doc.createElement('button');
    favTab.type = 'button';
    favTab.className = 'th-tab';
    favTab.textContent = '收藏';
    favTab.dataset.mode = 'favorites';
    const galleryTab = doc.createElement('button');
    galleryTab.type = 'button';
    galleryTab.className = 'th-tab';
    galleryTab.textContent = '展馆';
    galleryTab.dataset.mode = 'gallery';
    tabs.appendChild(searchTab);
    tabs.appendChild(favTab);
    tabs.appendChild(galleryTab);
    header.appendChild(tabs);

    const headerActions = doc.createElement('div');
    headerActions.className = 'th-chat-search-header-actions';

    const actionsMenu = doc.createElement('div');
    actionsMenu.className = 'th-actions-menu';

    const moreBtn = createIconButton('fa-ellipsis', '更多');
    moreBtn.classList.add('th-actions-toggle');
    moreBtn.title = '更多操作';
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    actionsMenu.appendChild(moreBtn);

    const actionsPopover = doc.createElement('div');
    actionsPopover.className = 'th-actions-popover';
    actionsPopover.setAttribute('role', 'menu');
    actionsPopover.setAttribute('aria-hidden', 'true');
    actionsMenu.appendChild(actionsPopover);

    const exportBtn = createIconButton('fa-download', '导出');
    exportBtn.title = '导出收藏数据（JSON，完整快照，含已删除记录）';
    exportBtn.setAttribute('role', 'menuitem');
    actionsPopover.appendChild(exportBtn);

    const importBtn = createIconButton('fa-upload', '导入');
    importBtn.title = '导入收藏数据（JSON）';
    importBtn.setAttribute('role', 'menuitem');
    actionsPopover.appendChild(importBtn);

    const latestBtn = createIconButton('fa-angles-down', '最新视图');
    latestBtn.title = '回到最新视图';
    latestBtn.setAttribute('role', 'menuitem');
    actionsPopover.appendChild(latestBtn);

    headerActions.appendChild(actionsMenu);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'th-chat-search-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '关闭面板');
    headerActions.appendChild(closeBtn);
    header.appendChild(headerActions);

    panel.appendChild(header);

    const controls = doc.createElement('div');
    controls.className = 'th-chat-search-controls';

    const input = doc.createElement('input');
    input.id = INPUT_ID;
    input.type = 'text';
    input.placeholder = '输入关键词';
    controls.appendChild(input);

    const searchBtn = createIconButton('fa-magnifying-glass', '搜索');
    controls.appendChild(searchBtn);

    panel.appendChild(controls);

    const counter = doc.createElement('div');
    counter.id = COUNTER_ID;
    counter.textContent = '就绪';
    panel.appendChild(counter);

    const results = doc.createElement('div');
    results.id = RESULT_ID;
    panel.appendChild(results);

    const emptyNotice = doc.createElement('div');
    emptyNotice.id = EMPTY_ID;
    emptyNotice.textContent = '请输入关键词开始搜索';
    panel.appendChild(emptyNotice);

    doc.body.appendChild(panel);

    const modal = doc.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'th-reading-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    doc.body.appendChild(modal);

    elements = {
      panel,
      closeBtn,
      searchBtn,
      input,
      counter,
      results,
      emptyNotice,
      searchTab,
      favTab,
      galleryTab,
      controls,
      modal,
      latestBtn,
      exportBtn,
      importBtn,
      moreBtn,
      actionsMenu,
      actionsPopover,
    };
  }

  function isActionsPopoverOpen() {
    return Boolean(elements?.actionsPopover?.classList?.contains('th-popover-open'));
  }

  function setActionsPopoverVisible(visible) {
    if (!elements?.actionsPopover || !elements?.moreBtn) {
      state.actionsPopoverOpen = false;
      return;
    }

    elements.actionsPopover.classList.toggle('th-popover-open', visible);
    elements.actionsPopover.setAttribute('aria-hidden', visible ? 'false' : 'true');
    elements.moreBtn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    state.actionsPopoverOpen = visible;
  }

  function toggleActionsPopover(force) {
    const next = typeof force === 'boolean' ? force : !isActionsPopoverOpen();
    setActionsPopoverVisible(next);
  }

  function setEmptyMessage(message) {
    if (!elements) return;
    elements.emptyNotice.textContent = message || '';
    elements.emptyNotice.style.display = message ? 'block' : 'none';
  }

  function translateRole(role) {
    switch (role) {
      case 'user':
        return '用户';
      case 'assistant':
        return '角色';
      case 'system':
        return '系统';
      default:
        return role;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripTags(value) {
    return String(value ?? '').replace(/<[^>]+>/g, ' ');
  }

  function collapseWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function findAllMatches(text, keywords) {
    if (!keywords.length) return [];
    const plain = collapseWhitespace(stripTags(text));
    const lower = plain.toLowerCase();
    const matches = [];

    keywords.forEach(term => {
      if (!term) return;
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1) {
        matches.push({ pos, term });
        pos += term.length;
      }
    });

    return matches.sort((a, b) => a.pos - b.pos);
  }

  function groupMatches(matches) {
    if (!matches.length) return [];
    const groups = [];
    let currentGroup = [matches[0]];

    for (let i = 1; i < matches.length; i++) {
      const groupSpan = matches[i].pos - currentGroup[0].pos;
      const lastDistance = matches[i].pos - currentGroup[currentGroup.length - 1].pos;

      if (lastDistance <= 100 && groupSpan <= 300) {
        currentGroup.push(matches[i]);
      } else {
        groups.push(currentGroup);
        currentGroup = [matches[i]];
      }
    }
    groups.push(currentGroup);
    return groups;
  }

  function buildSnippet(text, keywords, matchIndex = 0) {
    const plain = collapseWhitespace(stripTags(text));
    if (!plain) return '<em>(空消息)</em>';

    if (!keywords.length) {
      const short = plain.slice(0, 200);
      return escapeHtml(short) + (plain.length > 200 ? ' …' : '');
    }

    const matches = findAllMatches(text, keywords);
    if (!matches.length) {
      const short = plain.slice(0, 200);
      return escapeHtml(short) + (plain.length > 200 ? ' …' : '');
    }

    const groups = groupMatches(matches);
    const group = groups[Math.min(matchIndex, groups.length - 1)];
    const firstMatch = group[0];
    const lastMatch = group[group.length - 1];

    const start = Math.max(0, firstMatch.pos - 35);
    const end = Math.min(plain.length, lastMatch.pos + lastMatch.term.length + 85);

    const snippet = plain.slice(start, end);
    const prefix = start > 0 ? '… ' : '';
    const suffix = end < plain.length ? ' …' : '';
    const escaped = escapeHtml(snippet);
    const pattern = new RegExp(keywords.filter(Boolean).map(escapeRegExp).join('|'), 'gi');
    return prefix + escaped.replace(pattern, m => `<mark>${m}</mark>`) + suffix;
  }

  function markSelectedRow(messageId) {
    if (!elements) return;
    const rows = elements.results.querySelectorAll('.th-chat-search-result');
    rows.forEach(row => {
      const currentId = Number(row.dataset.messageId);
      row.classList.toggle('th-selected', messageId != null && currentId === messageId);
    });
  }

  function getChatContainer() {
    return doc.querySelector('#chat') || doc.querySelector('#chatHistory') || doc.querySelector('.chat') || doc.body;
  }

  function getCurrentChatId() {
    const context = parentWin.SillyTavern?.getContext?.();
    const getChatId = context?.getCurrentChatId;
    return getChatId ? getChatId() : null;
  }

  function isFavoriteChat(fav) {
    const context = parentWin.SillyTavern.getContext();
    if (String(getCurrentChatId()) !== String(fav.chatId)) return false;
    if (fav.groupId) return String(context.groupId) === String(fav.groupId);
    if (!fav.characterAvatar || fav.characterAvatar === 'unknown') return true;
    return !context.groupId && context.characters?.[context.characterId]?.avatar === fav.characterAvatar;
  }

  async function addFavorite(messageId) {
    if (!state.helper) return;

    const context = parentWin.SillyTavern?.getContext?.();
    const message = state.helper.getChatMessages(`${messageId}`, { include_swipes: false })?.[0];
    if (!message) {
      if (notifier?.warning) notifier.warning('无法获取消息内容');
      return;
    }

    // Capture the live message before opening either prompt or loading image thumbnails.
    const chatId = context?.getCurrentChatId?.() ?? 'unknown';
    const groupId = context?.groupId ?? null;
    const characterId = context?.characterId ?? 'unknown';
    const characterAvatar = context?.characters?.[context?.characterId]?.avatar || 'unknown';
    const chatName = context?.chatMetadata?.name || context?.name2 || '未知聊天';
    const renderedContent = getRenderedMessageContent(messageId);
    const imgSelector = `#chat .mes[mesid="${messageId}"] .mes_img_container img`;
    const messageImages = Array.from(doc.querySelectorAll(imgSelector), img => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    }));

    const title = await askText('为这条收藏添加标题（可选）：');
    if (title === null) return;
    const subtitle = await askText('选填：输入消息金句或关键台词');
    if (subtitle === null) return;
    const images = await extractImagesData(messageImages);

    const now = Date.now();
    const fav = {
      uuid: generateUuid(),
      messageId: messageId,
      chatId: chatId,
      groupId: groupId,
      characterId: characterId,
      characterAvatar: characterAvatar,
      title: title.trim() || `消息 #${messageId}`,
      subtitle: subtitle.trim() || '',
      message: message.message,
      messageHtml: renderedContent || escapeHtml(message.message).replace(/\r\n|\n|\r/g, '<br>'),
      role: message.role,
      charName: message.name || '未知',
      chatName: chatName,
      images: images,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    await addFavoriteDB(fav);
    await reloadFavorites();

    if (notifier?.success) notifier.success('已添加到收藏');
  }

  function createHeartSvgIcon() {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    );
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function ensureMessageFavoriteButton(mesElement) {
    if (!mesElement || mesElement.nodeType !== 1) return false;

    const extraButtons = mesElement.querySelector('.extraMesButtons');
    if (!extraButtons) return false;

    if (extraButtons.querySelector(`.${MESSAGE_FAVORITE_BUTTON_CLASS}`)) return true;

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `mes_button ${MESSAGE_FAVORITE_BUTTON_CLASS}`;
    button.title = '收藏';
    button.setAttribute('aria-label', '收藏');
    button.appendChild(createHeartSvgIcon());

    button.addEventListener('click', event => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {
        // ignore
      }

      const mes = button.closest('div.mes[mesid]') ?? mesElement.closest('div.mes[mesid]');
      const messageId = mes ? Number(mes.getAttribute('mesid')) : NaN;
      if (Number.isNaN(messageId)) return;
      void addFavorite(messageId).catch(error => {
        logger.error('[ChatSearch] failed to save favorite:', error);
        notifier?.error?.('收藏保存失败，请重试。');
      });
    });

    extraButtons.appendChild(button);
    return true;
  }

  function installMessageFavoriteButtons() {
    const chatContainer = getChatContainer();
    if (!chatContainer || chatContainer === doc.body) return;

    chatContainer.querySelectorAll('div.mes[mesid]').forEach(mes => {
      ensureMessageFavoriteButton(mes);
    });

    if (state.messageActionsObserver) {
      state.messageActionsObserver.disconnect();
      state.messageActionsObserver = null;
    }

    const MutationObserverCtor = parentWin.MutationObserver ?? MutationObserver;
    const observer = new MutationObserverCtor(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (typeof node.matches === 'function' && node.matches('div.mes[mesid]')) {
            ensureMessageFavoriteButton(node);
            continue;
          }
          if (node.matches('.extraMesButtons')) ensureMessageFavoriteButton(node.closest('div.mes[mesid]'));
          node.querySelectorAll?.('div.mes[mesid]').forEach(mes => ensureMessageFavoriteButton(mes));
        }
      }
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    state.messageActionsObserver = observer;
  }

  async function removeFavorite(favId) {
    const fav = state.favorites.find(f => f.id === favId);
    if (fav) {
      fav.deletedAt = Date.now();
      fav.updatedAt = fav.deletedAt;
      fav.hasImages = false;
      fav.coverThumbnail = null;
      FAVORITE_PAYLOAD_FIELDS.forEach(key => {
        if (hasOwn(fav, key)) delete fav[key];
      });
      delete fav.__payloadLoaded;
      await updateFavoriteDB(fav);
      if (fav.uuid) {
        try {
          await deleteFavoritePayloadByUuidDB(fav.uuid);
        } catch (error) {
          logger.warn('[ChatSearch] failed to purge payload for deleted favorite:', error);
        }
      }
    } else {
      await deleteFavoriteDB(favId);
    }
    await reloadFavorites();
    if (state.currentMode === 'favorites') {
      renderFavorites();
    } else if (state.currentMode === 'gallery') {
      if (state.selectedCharacter) {
        renderCharacterDetail(state.selectedCharacter);
      } else {
        renderGalleryList();
      }
    }
  }

  async function editFavoriteTitle(favId) {
    const fav = state.favorites.find(f => f.id === favId);
    if (!fav) return;
    void openFavoriteEditor(fav);
  }

  function getRenderedMessageContent(messageId) {
    try {
      const chatContainer = getChatContainer();
      if (!chatContainer) return null;

      const mesElement = chatContainer.querySelector(`div.mes[mesid="${messageId}"]`);
      if (!mesElement) return null;

      const mesText = mesElement.querySelector('.mes_text');
      if (!mesText) return null;

      const snapshot = mesText.cloneNode(true);
      const frames = Array.from(mesText.querySelectorAll('iframe'));
      snapshot.querySelectorAll('iframe').forEach((frame, index) => {
        const body = frames[index].contentDocument?.body;
        if (body) frame.replaceWith(...Array.from(body.childNodes, node => doc.importNode(node, true)));
        else frame.remove();
      });

      const media = Array.from(mesElement.querySelectorAll('.mes_img_container'))
        .filter(container => !mesText.contains(container))
        .map(container => container.outerHTML).join('');
      const content = safeFavoriteHtml(snapshot.innerHTML + media);
      if (frames.length && !snapshot.textContent.trim() && !snapshot.querySelector('img, video, audio') && !media) return null;

      return content;
    } catch {
      return null;
    }
  }

  function processModalImages(modalElement, imagesData) {
    if (!imagesData?.length) return;

    const imgs = modalElement.querySelectorAll('.th-modal-message img');
    imgs.forEach((img, index) => {
      const imageData = imagesData[index];
      if (!imageData) return;

      const originalSrc = imageData.originalSrc;
      const thumbnail = imageData.thumbnail;

      img.src = originalSrc;

      const fallbackToThumbnail = () => {
        if (img.src !== thumbnail) {
          img.src = thumbnail;
        }
      };

      img.onerror = fallbackToThumbnail;

      const timeout = setTimeout(fallbackToThumbnail, 2000);
      img.onload = () => clearTimeout(timeout);
    });
  }

  async function exportModalAsImage() {
    const modal = doc.getElementById(MODAL_ID);
    if (!modal || !state.modalVisible) return;

    const body = modal.querySelector('.th-modal-body');
    if (!body) return;

    // 确保加载 modern-screenshot
    let screenshotLib = window.modernScreenshot || parentWin.modernScreenshot;
    if (!screenshotLib) {
      try {
        screenshotLib = await loadScreenshotLib();
      } catch (error) {
        logger.error('[ChatSearch] failed to load screenshot library:', error);
        notifier?.error?.('导出失败：无法加载截图库');
        return;
      }
    }

    const content = modal.querySelector('.th-modal-content');
    const originalBodyOverflow = body.style.overflow;
    const originalBodyMaxHeight = body.style.maxHeight;
    const originalBodyQuotes = body.style.quotes;

    const originalContentOverflow = content.style.overflow;
    const originalContentMaxHeight = content.style.maxHeight;
    const originalContentHeight = content.style.height;

    const replacements = [];
    const quoteReplacements = [];
    const hiddenButtons = [];
    let imageShadows = [];

    try {
      // 隐藏UI按钮
      const buttonsToHide = content.querySelectorAll(
        '.th-modal-close, .th-modal-export, .th-modal-edit, .th-modal-load, .th-modal-nav',
      );
      buttonsToHide.forEach(btn => {
        hiddenButtons.push({ element: btn, originalDisplay: btn.style.display });
        btn.style.display = 'none';
      });

      const context = parentWin.SillyTavern?.getContext?.();
      const userName = context?.name1;
      let shouldReplace = false;

      if (userName) {
        const choice = await askText('导出截图选项：\n\n输入 1 - 替换用户名为 {{user}}\n输入 2 - 保持原用户名', '2');
        if (choice === null) return;
        if (choice === '1') shouldReplace = true;
      }

      await document.fonts.ready;

      if (shouldReplace && userName) {
        const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue && node.nodeValue.includes(userName)) {
            replacements.push({ node, original: node.nodeValue });
            node.nodeValue = node.nodeValue.replace(new RegExp(escapeRegExp(userName), 'g'), '{{user}}');
          }
        }
      }

      // 暂时将 <q> 标签替换为普通 <span>，避免截图时出现 open-quote/close-quote 文本
      body.querySelectorAll('q').forEach(qEl => {
        const parent = qEl.parentNode;
        if (!parent) return;
        const span = doc.createElement('span');
        span.textContent = qEl.textContent;
        span.style.fontStyle = 'italic';
        quoteReplacements.push({ parent, original: qEl, replacement: span, nextSibling: qEl.nextSibling });
        parent.replaceChild(span, qEl);
      });

      // 展开内容以进行长截图
      body.style.overflow = 'visible';
      body.style.maxHeight = 'none';
      body.style.quotes = 'none';

      content.style.overflow = 'visible';
      content.style.maxHeight = 'none';
      content.style.height = 'auto';

      // 获取 SmartThemeBlurTintColor 并去掉透明度
      let themeBg = window.getComputedStyle(doc.body).getPropertyValue('--SmartThemeBlurTintColor').trim();

      // 如果变量未定义，尝试从 content 获取背景色
      if (!themeBg) {
        themeBg = window.getComputedStyle(content).backgroundColor;
      }

      // 提取 RGB 分量，去掉透明度
      const rgbaMatch = themeBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const opaqueBg = rgbaMatch ? `rgb(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]})` : '#12131b';

      // 使用更可靠的移动端检测：结合屏幕宽度和触摸设备检测
      const isMobile = window.innerWidth <= 768 && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
      const scale = isMobile ? 1.5 : 2;

      // 移动端临时移除图片阴影，避免高分辨率下阴影位移
      if (isMobile) {
        body.querySelectorAll('img').forEach(img => {
          const originalShadow = img.style.boxShadow;
          imageShadows.push({ element: img, originalShadow });
          img.style.boxShadow = 'none';
        });
      }

      const dataUrl = await screenshotLib.domToPng(content, {
        quality: 0.8,
        backgroundColor: opaqueBg,
        scale: scale,
      });

      const link = doc.createElement('a');
      link.download = `favorite-${Date.now()}.png`;
      link.href = dataUrl;
      doc.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      logger.error('[ChatSearch] failed to export screenshot:', error);
      notifier?.error?.('导出截图失败，详见控制台。');
    } finally {
      // 恢复用户名
      replacements.forEach(({ node, original }) => {
        node.nodeValue = original;
      });

      // 恢复 <q> 标签
      quoteReplacements.forEach(({ parent, original, replacement, nextSibling }) => {
        if (!parent) return;
        if (replacement.parentNode === parent) {
          parent.replaceChild(original, replacement);
        } else if (replacement.parentNode) {
          replacement.parentNode.replaceChild(original, replacement);
        } else if (nextSibling && nextSibling.parentNode === parent) {
          parent.insertBefore(original, nextSibling);
        } else {
          parent.appendChild(original);
        }
      });

      body.style.overflow = originalBodyOverflow;
      body.style.maxHeight = originalBodyMaxHeight;
      body.style.quotes = originalBodyQuotes;

      content.style.overflow = originalContentOverflow;
      content.style.maxHeight = originalContentMaxHeight;
      content.style.height = originalContentHeight;

      // 恢复UI按钮
      hiddenButtons.forEach(({ element, originalDisplay }) => {
        element.style.display = originalDisplay;
      });

      // 恢复图片阴影（仅移动端）
      if (imageShadows.length > 0) {
        imageShadows.forEach(({ element, originalShadow }) => {
          element.style.boxShadow = originalShadow;
        });
      }
    }
  }

  async function openReadingModal(fav) {
    const modal = doc.getElementById(MODAL_ID);
    if (!modal) return;

    try {
      await hydrateFavoritePayload(fav);
    } catch (error) {
      logger.warn('[ChatSearch] failed to load favorite payload:', error);
    }

    const currentIndex = state.favorites.findIndex(f => f.id === fav.id);
    const hasPrev = currentIndex < state.favorites.length - 1;
    const hasNext = currentIndex > 0;

    const timestamp = new Date(fav.createdAt).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const subtitleHtml = fav.subtitle ? `<div class="th-modal-subtitle">${escapeHtml(fav.subtitle)}</div>` : '';

    let messageContent = buildFavoriteContentHtml(fav);
    if (!messageContent && isFavoriteChat(fav)) {
      const renderedContent = getRenderedMessageContent(fav.messageId);
      messageContent = renderedContent || fav.message || '';
    }

    if (!messageContent) {
      const previewText = normalizePreviewText(fav.previewText);
      if (previewText) {
        const previewHtml = escapeHtml(previewText).replace(/\r\n|\n|\r/g, '<br>');
        messageContent = `
          <div class="th-fav-edited-text">${previewHtml}</div>
          <div style="opacity:0.75;margin-top:8px;"><em>（精简收藏：点击“定位”可从聊天记录加载正文，或用“导入”导入完整收藏。）</em></div>
        `;
      } else {
        messageContent = `<em>（该收藏未包含正文。点击“定位”从聊天记录加载，或用“导入”导入完整收藏。）</em>`;
      }
    }

    const prevBtnHtml = `
      <button class="th-modal-nav th-modal-nav-prev" aria-label="上一条收藏" ${!hasPrev ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-left"></i>
      </button>
    `;

    const nextBtnHtml = `
      <button class="th-modal-nav th-modal-nav-next" aria-label="下一条收藏" ${!hasNext ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    `;

    modal.innerHTML = `
      <div class="th-modal-backdrop"></div>
      <div class="th-modal-content">
        <button class="th-modal-close" aria-label="关闭">&times;</button>
        <button class="th-modal-export" aria-label="导出截图" title="导出截图">
          <i class="fa-solid fa-download"></i>
        </button>
        <button class="th-modal-edit" aria-label="编辑收藏" title="编辑收藏">
          <i class="fa-solid fa-pen-to-square"></i>
        </button>
        <button class="th-modal-load" aria-label="定位到原消息" title="定位到原消息">
          <i class="fa-solid fa-location-arrow"></i>
        </button>
        ${prevBtnHtml}
        ${nextBtnHtml}
        <div class="th-modal-body">
          <h2 class="th-modal-title">${escapeHtml(fav.title)}</h2>
          ${subtitleHtml}
          <div class="th-modal-message">${safeFavoriteHtml(messageContent)}</div>
          <div class="th-modal-meta">
            <div class="th-modal-source">${escapeHtml(fav.charName || '未知')} 来信</div>
            <div class="th-modal-time">${timestamp}</div>
          </div>
        </div>
      </div>
    `;

    const closeBtn = modal.querySelector('.th-modal-close');
    const exportBtn = modal.querySelector('.th-modal-export');
    const editBtn = modal.querySelector('.th-modal-edit');
    const loadBtn = modal.querySelector('.th-modal-load');
    const backdrop = modal.querySelector('.th-modal-backdrop');
    const prevBtn = modal.querySelector('.th-modal-nav-prev');
    const nextBtn = modal.querySelector('.th-modal-nav-next');

    const closeModal = () => {
      modal.classList.remove('th-modal-visible');
      state.modalVisible = false;
    };

    closeBtn.addEventListener('click', closeModal);
    exportBtn.addEventListener('click', exportModalAsImage);
    editBtn.addEventListener('click', () => void openFavoriteEditor(fav));
    loadBtn?.addEventListener('click', async () => {
      const floor = await jumpToMessageWithAutoLoad(fav.messageId, fav.chatId, fav.characterAvatar, {
        groupId: fav.groupId,
        fallbackText: fav.previewText ?? fav.message ?? '',
      });
      if (floor == null || hasAnyPayloadFields(fav) || !isFavoriteChat(fav)) return;

      const renderedContent = getRenderedMessageContent(floor);
      if (!renderedContent) {
        if (notifier?.warning) notifier.warning('未能从聊天记录加载正文，请先打开对应聊天后重试。');
        return;
      }

      fav.messageHtml = String(renderedContent);
      fav.message = collapseWhitespace(stripTags(fav.messageHtml));

      const previewText = normalizePreviewText(fav.previewText ?? fav.message);
      if (previewText) fav.previewText = previewText;

      try {
        await updateFavoriteDB(fav);
      } catch (error) {
        logger.warn('[ChatSearch] save loaded favorite failed:', error);
      }

      void openReadingModal(fav);
    });
    backdrop.addEventListener('click', closeModal);

    if (hasPrev) {
      prevBtn.addEventListener('click', () => {
        void openReadingModal(state.favorites[currentIndex + 1]);
      });
    }

    if (hasNext) {
      nextBtn.addEventListener('click', () => {
        void openReadingModal(state.favorites[currentIndex - 1]);
      });
    }

    modal.classList.add('th-modal-visible');
    state.modalVisible = true;

    processModalImages(modal, fav.images);
  }

  async function restoreLatestView() {
    try {
      const context = parentWin.SillyTavern.getContext();
      await context.scrollChatToBottom({ waitForFrame: true });
      notifier?.info?.('已恢复到最新视图');
    } catch (error) {
      logger.error('[ChatSearch] restoreLatestView failed:', error);
      notifier?.error?.('恢复最新视图失败，请重试。');
    }
  }

  function resolveMessageIdByPreview(chat, preview, originalFloor) {
    const needle = collapseWhitespace(preview).trim().toLowerCase();
    const tokens = [needle, needle.slice(0, 80), needle.slice(0, 50), needle.slice(0, 32)].filter(token => token.length >= 12);
    if (!tokens.length) return null;

    let best = null;
    let distance = Infinity;
    for (let i = 0; i < chat.length; i++) {
      const text = collapseWhitespace(String(chat[i]?.mes ?? '')).toLowerCase();
      if (!tokens.some(token => text.includes(token))) continue;
      const currentDistance = Math.abs(i - originalFloor);
      if (currentDistance < distance) {
        best = i;
        distance = currentDistance;
      }
    }
    return best;
  }

  async function jumpToMessageWithAutoLoad(messageId, chatId = null, characterAvatar = null, options = {}) {
    if (state.jumpInProgress) {
      notifier?.info?.('正在跳转中，请稍候…');
      return null;
    }
    const parsed = Number(messageId);
    if (messageId == null || !Number.isInteger(parsed) || parsed < 0) {
      notifier?.error?.('无效的楼层号');
      return null;
    }

    state.jumpInProgress = true;
    try {
      let context = parentWin.SillyTavern.getContext();
      const groupId = options.groupId || null;
      if (chatId && chatId !== 'unknown' && !isFavoriteChat({ chatId, characterAvatar, groupId })) {
        if (groupId != null) await context.openGroupChat(String(groupId), String(chatId));
        else if (characterAvatar && characterAvatar !== 'unknown') await context.openCharacterChat(String(chatId), characterAvatar);
        if (!isFavoriteChat({ chatId, characterAvatar, groupId })) {
          notifier?.warning?.('未能打开来源聊天。');
          return null;
        }
        context = parentWin.SillyTavern.getContext();
      }

      const chat = context.chat;
      const floor = chat[parsed] ? parsed : resolveMessageIdByPreview(chat, String(options.fallbackText ?? ''), parsed);
      if (floor == null) {
        notifier?.warning?.(`目标楼层 #${parsed} 超出该聊天长度（共 ${chat.length} 楼）。可能该存档已被覆盖/删除，或楼层号发生变化。`);
        return null;
      }

      // Let TT load the target through its own chat projection, including virtualized history.
      await context.executeSlashCommandsWithOptions(`/chat-jump ${floor}`);
      const target = getChatContainer()?.querySelector(`div.mes[mesid="${floor}"]`);
      if (!target) return null;

      if (state.highlightTimer) clearTimeout(state.highlightTimer);
      state.highlightedElement?.classList.remove('th-chat-search-target');
      target.classList.add('th-chat-search-target');
      state.highlightedElement = target;
      state.highlightTimer = setTimeout(() => {
        target.classList.remove('th-chat-search-target');
        state.highlightedElement = null;
        state.highlightTimer = null;
      }, 2600);
      return floor;
    } catch (error) {
      logger.error('[ChatSearch] failed to jump to message:', error);
      notifier?.error?.('跳转失败，请打开来源聊天后重试。');
      return null;
    } finally {
      state.jumpInProgress = false;
    }
  }

  function createResultRow(match) {
    const row = doc.createElement('article');
    row.className = 'th-chat-search-result';
    row.dataset.messageId = String(match.message_id);

    const header = doc.createElement('div');
    header.className = 'th-chat-search-result-header';

    const title = doc.createElement('span');
    title.className = 'th-chat-search-result-title';
    title.textContent = `#${match.message_id} · ${match.name || '未命名'}`;
    header.appendChild(title);

    const roleBadge = doc.createElement('span');
    roleBadge.className = 'th-badge';
    roleBadge.textContent = translateRole(match.role);
    header.appendChild(roleBadge);

    if (match.is_hidden) {
      const hiddenBadge = doc.createElement('span');
      hiddenBadge.className = 'th-badge';
      hiddenBadge.textContent = '隐藏';
      header.appendChild(hiddenBadge);
    }

    row.appendChild(header);

    const actions = doc.createElement('div');
    actions.className = 'th-chat-search-result-actions';

    const previewBtn = createIconButton('fa-eye', '预览');
    const jumpBtn = createIconButton('fa-location-arrow', '跳转');

    actions.appendChild(previewBtn);
    actions.appendChild(jumpBtn);
    row.appendChild(actions);

    const allMatches = findAllMatches(match.message, state.keywords);
    const matchGroups = groupMatches(allMatches);
    const matchCount = matchGroups.length;
    let currentMatchIndex = 0;

    const matchNav = doc.createElement('div');
    matchNav.className = 'th-match-nav';
    const prevBtn = doc.createElement('button');
    prevBtn.className = 'th-match-nav-btn';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    const matchInfo = doc.createElement('span');
    matchInfo.textContent = `匹配 ${matchCount} 处`;
    const nextBtn = doc.createElement('button');
    nextBtn.className = 'th-match-nav-btn';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    matchNav.appendChild(prevBtn);
    matchNav.appendChild(matchInfo);
    matchNav.appendChild(nextBtn);
    row.appendChild(matchNav);

    const snippet = doc.createElement('div');
    snippet.className = 'th-chat-search-result-snippet';
    row.appendChild(snippet);

    const updateSnippet = () => {
      snippet.innerHTML = buildSnippet(match.message, state.keywords, currentMatchIndex);
      matchInfo.textContent = `${currentMatchIndex + 1} / ${matchCount}`;
      prevBtn.disabled = currentMatchIndex === 0;
      nextBtn.disabled = currentMatchIndex === matchCount - 1;
    };

    const toggleSnippet = forceVisible => {
      const isOpen = snippet.classList.contains('th-expanded');
      const shouldOpen = typeof forceVisible === 'boolean' ? forceVisible : !isOpen;
      snippet.classList.toggle('th-expanded', shouldOpen);
      matchNav.classList.toggle('th-visible', shouldOpen && matchCount > 1);
      row.classList.toggle('th-open', shouldOpen);
      if (shouldOpen) {
        updateSnippet();
        markSelectedRow(match.message_id);
      } else if (isOpen) {
        markSelectedRow(null);
      }
    };

    prevBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (currentMatchIndex > 0) {
        currentMatchIndex--;
        updateSnippet();
      }
    });

    nextBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (currentMatchIndex < matchCount - 1) {
        currentMatchIndex++;
        updateSnippet();
      }
    });

    previewBtn.addEventListener('click', event => {
      event.stopPropagation();
      toggleSnippet();
    });

    jumpBtn.addEventListener('click', event => {
      event.stopPropagation();
      toggleSnippet(true);
      void jumpToMessageWithAutoLoad(match.message_id);
    });

    row.addEventListener('click', () => toggleSnippet());

    return row;
  }

  function renderResults(matches, keyword) {
    if (!elements) return;

    elements.results.innerHTML = '';

    if (!keyword) {
      elements.counter.textContent = '就绪';
      setEmptyMessage('请输入关键词开始搜索');
      state.matches = [];
      state.keywords = [];
      state.fullMatchCount = 0;
      markSelectedRow(null);
      return;
    }

    if (!matches.length) {
      elements.counter.textContent = '无结果';
      setEmptyMessage('未找到匹配内容');
      state.matches = [];
      markSelectedRow(null);
      return;
    }

    const truncated = state.fullMatchCount > matches.length;
    if (truncated) {
      elements.counter.textContent = `显示 ${matches.length} 条，实际 ${state.fullMatchCount} 条。`;
    } else {
      elements.counter.textContent = `${matches.length} 条结果。`;
    }
    setEmptyMessage('');
    markSelectedRow(null);

    matches.forEach((match, index) => {
      const row = createResultRow(match);
      row.classList.add('th-animate-in');
      row.style.animationDelay = `${index * 0.03}s`;
      elements.results.appendChild(row);
    });
  }

  function renderFavorites() {
    if (!elements) return;

    elements.results.innerHTML = '';

    if (!state.favorites.length) {
      elements.counter.textContent = '暂无收藏';
      setEmptyMessage('点击消息右侧的收藏按钮即可收藏');
      return;
    }

    elements.counter.textContent = `共 ${state.favorites.length} 条收藏`;
    setEmptyMessage('');

    state.favorites
      .slice()
      .reverse()
      .forEach((fav, index) => {
        const row = doc.createElement('article');
        row.classList.add('th-animate-in');
        row.style.animationDelay = `${index * 0.03}s`;
        row.className = 'th-chat-search-result th-animate-in';
        row.style.position = 'relative';

        const editIcon = doc.createElement('i');
        editIcon.className = 'fa-solid fa-pen th-edit-icon';
        editIcon.title = '编辑收藏';
        editIcon.style.position = 'absolute';
        editIcon.style.top = '10px';
        editIcon.style.right = '10px';
        editIcon.style.margin = '0';
        row.appendChild(editIcon);

        const header = doc.createElement('div');
        header.className = 'th-chat-search-result-header';

        const title = doc.createElement('span');
        title.className = 'th-chat-search-result-title';
        title.textContent = `#${fav.messageId} · ${fav.title}`;
        header.appendChild(title);

        const roleBadge = doc.createElement('span');
        roleBadge.className = 'th-badge';
        roleBadge.textContent = translateRole(fav.role);
        header.appendChild(roleBadge);

        row.appendChild(header);

        if (fav.subtitle) {
          const subtitle = doc.createElement('div');
          subtitle.className = 'th-fav-subtitle';
          subtitle.textContent = fav.subtitle;
          row.appendChild(subtitle);
        }

        const actions = doc.createElement('div');
        actions.className = 'th-chat-search-result-actions';

        const jumpBtn = createIconButton('fa-location-arrow', '跳转');
        const delBtn = createIconButton('fa-trash', '删除');

        actions.appendChild(jumpBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);

        editIcon.addEventListener('click', e => {
          e.stopPropagation();
          editFavoriteTitle(fav.id);
        });

        jumpBtn.addEventListener('click', e => {
          e.stopPropagation();
          void jumpToMessageWithAutoLoad(fav.messageId);
        });

        delBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (await askConfirm('确定删除这条收藏？')) {
            await removeFavorite(fav.id);
          }
        });

        row.addEventListener('click', () => void openReadingModal(fav));

        elements.results.appendChild(row);
      });
  }

  async function reloadFavorites() {
    const currentChatId = getCurrentChatId();

    if (state.currentMode === 'favorites') {
      // 收藏模式：只显示当前聊天的收藏
      const allFavorites = currentChatId ? await getFavoritesByChatIdDB(currentChatId) : [];
      state.favorites = allFavorites.filter(fav => !fav.deletedAt && isFavoriteChat(fav));
      renderFavorites();
    } else if (state.currentMode === 'gallery') {
      // 展馆模式：显示所有角色的所有收藏（全局通用）
      state.favorites = (await getAllFavoritesDB({ includePayload: false })).filter(fav => !fav.deletedAt);
      if (state.selectedCharacter) {
        renderCharacterDetail(state.selectedCharacter);
      } else {
        renderGalleryList();
      }
    }
  }

  function getFavoriteGalleryGroupKey(fav) {
    const charName = String(fav.charName || '未知').trim() || '未知';
    const characterAvatar = String(fav.characterAvatar || 'unknown').trim() || 'unknown';
    const chatId = String(fav.chatId || 'unknown').trim() || 'unknown';
    return `${charName}::${characterAvatar}::${chatId}`;
  }

  function getFavoriteGallerySubtitle(fav) {
    const chatName = String(fav.chatName || '').trim();
    if (chatName) return chatName;

    const chatId = String(fav.chatId || '').trim();
    return chatId && chatId !== 'unknown' ? chatId : '';
  }

  function groupFavoritesByCharacter() {
    const grouped = {};
    state.favorites.forEach(fav => {
      const key = getFavoriteGalleryGroupKey(fav);
      const charName = fav.charName || '未知';
      if (!grouped[key]) {
        grouped[key] = {
          key,
          name: charName,
          subtitle: getFavoriteGallerySubtitle(fav),
          favorites: [],
          lastFavoriteDate: 0,
          coverImage: null,
          characterAvatar: fav.characterAvatar,
          chatId: fav.chatId,
        };
      }
      grouped[key].favorites.push(fav);
      if (fav.createdAt > grouped[key].lastFavoriteDate) {
        grouped[key].lastFavoriteDate = fav.createdAt;
      }
      if (fav.coverThumbnail) {
        grouped[key].coverImage = fav.coverThumbnail;
      }
    });
    return Object.values(grouped).sort((a, b) => b.lastFavoriteDate - a.lastFavoriteDate);
  }

  async function renderGalleryList() {
    if (!elements) return;
    elements.results.innerHTML = '';
    state.selectedCharacter = null;

    const characters = groupFavoritesByCharacter();
    if (!characters.length) {
      elements.counter.textContent = '暂无展馆内容';
      setEmptyMessage('收藏消息后将在此展示');
      return;
    }

    elements.counter.textContent = `共 ${characters.length} 个分组`;
    setEmptyMessage('');

    const listContainer = doc.createElement('div');
    listContainer.className = 'th-gallery-list';

    characters.forEach((char, index) => {
      const card = doc.createElement('div');
      card.className = 'th-character-card th-animate-in';
      card.style.animationDelay = `${index * 0.05}s`;

      const date = new Date(char.lastFavoriteDate);
      const dateDiv = doc.createElement('div');
      dateDiv.className = 'th-card-date';
      dateDiv.innerHTML = `
        <div class="th-card-date-day">${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(
        2,
        '0',
      )}</div>
        <div class="th-card-date-year">${date.getFullYear()}</div>
      `;

      const content = doc.createElement('div');
      content.className = 'th-card-content';
      const detailText = char.subtitle
        ? `${char.favorites.length} 条收藏 · ${escapeHtml(char.subtitle)}`
        : `${char.favorites.length} 条收藏`;
      content.innerHTML = `
        <div class="th-card-title">${escapeHtml(char.name)}</div>
        <div class="th-card-subtitle">${detailText}</div>
      `;

      const coverImg = doc.createElement('img');
      coverImg.className = 'th-card-cover';
      coverImg.alt = '封面';
      coverImg.src = char.coverImage || `/characters/${char.characterAvatar}`;

      card.appendChild(dateDiv);
      card.appendChild(content);
      card.appendChild(coverImg);

      card.addEventListener('click', () => {
        state.selectedCharacter = char.key;
        renderCharacterDetail(char.key);
      });

      listContainer.appendChild(card);
    });

    elements.results.appendChild(listContainer);
  }

  async function renderCharacterDetail(groupKey) {
    if (!elements) return;
    elements.results.innerHTML = '';

    const characters = groupFavoritesByCharacter();
    const char = characters.find(c => c.key === groupKey);
    if (!char) {
      renderGalleryList();
      return;
    }

    const backBtn = doc.createElement('button');
    backBtn.className = 'th-gallery-back';
    backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i><span>返回</span>';
    backBtn.addEventListener('click', () => {
      state.selectedCharacter = null;
      renderGalleryList();
    });

    elements.counter.textContent = `${char.name} (${char.favorites.length} 条收藏)`;
    elements.results.appendChild(backBtn);

    const sortedFavs = char.favorites.slice().sort((a, b) => b.createdAt - a.createdAt);

    sortedFavs.forEach((fav, index) => {
      const card = doc.createElement('div');
      card.className = 'th-favorite-card-horizontal th-animate-in';
      card.style.animationDelay = `${index * 0.03}s`;

      const wrapper = doc.createElement('div');
      wrapper.className = 'th-card-wrapper';

      const content = doc.createElement('div');
      content.className = 'th-card-content';

      const date = new Date(fav.createdAt);
      const timestamp = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      const subtitleHtml = fav.subtitle ? `<div class="th-fav-subtitle">${escapeHtml(fav.subtitle)}</div>` : '';
      content.innerHTML = `
        <div class="th-card-title">${escapeHtml(fav.title)}</div>
        ${subtitleHtml}
        <div class="th-card-subtitle">${timestamp}</div>
      `;

      wrapper.appendChild(content);

      if (fav.coverThumbnail) {
        const img = doc.createElement('img');
        img.className = 'th-card-cover-large';
        img.alt = '消息图片';
        img.src = fav.coverThumbnail;
        wrapper.appendChild(img);
      }

      const actions = doc.createElement('div');
      actions.className = 'th-gallery-actions';

      const jumpBtn = createIconButton('fa-location-arrow', '跳转');
      const delBtn = createIconButton('fa-trash', '删除');

      jumpBtn.addEventListener('click', e => {
        e.stopPropagation();
        void jumpToMessageWithAutoLoad(fav.messageId, fav.chatId, fav.characterAvatar, {
          groupId: fav.groupId,
          fallbackText: fav.previewText ?? '',
        });
      });

      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (await askConfirm('确定删除这条收藏？')) {
          await removeFavorite(fav.id);
        }
      });

      actions.appendChild(jumpBtn);
      actions.appendChild(delBtn);

      card.addEventListener('click', () => void openReadingModal(fav));

      card.appendChild(wrapper);
      card.appendChild(actions);

      elements.results.appendChild(card);
    });
  }

  function switchMode(mode) {
    if (!elements) return;
    state.currentMode = mode;

    elements.searchTab.classList.toggle('th-tab-active', mode === 'search');
    elements.favTab.classList.toggle('th-tab-active', mode === 'favorites');
    elements.galleryTab.classList.toggle('th-tab-active', mode === 'gallery');

    if (mode === 'search') {
      elements.controls.style.display = '';
      renderResults(state.matches, elements.input.value.trim());
    } else if (mode === 'favorites') {
      elements.controls.style.display = 'none';
      state.selectedCharacter = null;
      void reloadFavorites();
    } else if (mode === 'gallery') {
      elements.controls.style.display = 'none';
      state.selectedCharacter = null;
      void reloadFavorites();
    }
  }

  function togglePanel(force, focusInput = false) {
    if (!elements) return;
    const visible = elements.panel.classList.contains('th-visible');
    const nextState = typeof force === 'boolean' ? force : !visible;
    elements.panel.classList.toggle('th-visible', nextState);
    elements.panel.classList.toggle('th-hidden', !nextState);
    setActionsPopoverVisible(false);

    if (nextState) {
      // 打开面板时重新加载当前模式的数据
      if (state.currentMode === 'favorites' || state.currentMode === 'gallery') {
        void reloadFavorites();
      }
      if (focusInput && state.currentMode === 'search') {
        requestAnimationFrame(() => {
          elements.input.focus();
          elements.input.select();
        });
      }
    }
  }

  function openPanel(focusInput = false) {
    togglePanel(true, focusInput);
  }

  function closePanel() {
    togglePanel(false);
  }

  function performSearch() {
    if (!state.helper || !elements) return;

    const raw = elements.input.value.trim();
    const keywords = raw.toLowerCase().split(/\s+/).filter(Boolean);
    state.keywords = keywords;

    if (!raw) {
      renderResults([], '');
      return;
    }

    const lastId = state.helper.getLastMessageId?.();
    if (typeof lastId !== 'number' || Number.isNaN(lastId) || lastId < 0) {
      renderResults([], raw);
      setEmptyMessage('当前聊天暂无消息');
      return;
    }

    let messages = [];
    try {
      messages = state.helper.getChatMessages(`0-${lastId}`, { include_swipes: false });
    } catch (error) {
      logger.error('[ChatSearch] getChatMessages failed:', error);
      if (notifier && typeof notifier.error === 'function') {
        notifier.error('搜索失败，详见控制台。');
      }
      return;
    }

    const filtered = messages.filter(item => {
      if (!keywords.length) return true;
      const text = String(item.message ?? '').toLowerCase();
      return keywords.every(term => text.includes(term));
    });

    state.fullMatchCount = filtered.length;
    const display = filtered.slice(0, MAX_RESULTS);
    state.matches = display;
    renderResults(display, raw);
  }

  function attachHandlers() {
    if (!elements) return;

    elements.closeBtn.addEventListener('click', () => closePanel());
    elements.moreBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleActionsPopover();
    });
    elements.latestBtn.addEventListener('click', () => {
      setActionsPopoverVisible(false);
      void restoreLatestView();
    });
    elements.exportBtn.addEventListener('click', () => {
      setActionsPopoverVisible(false);
      void exportFavoritesInteractive();
    });
    elements.importBtn.addEventListener('click', () => {
      setActionsPopoverVisible(false);
      void importFavoritesInteractive();
    });
    elements.searchBtn.addEventListener('click', performSearch);

    elements.searchTab.addEventListener('click', () => switchMode('search'));
    elements.favTab.addEventListener('click', () => switchMode('favorites'));
    elements.galleryTab.addEventListener('click', () => switchMode('gallery'));

    elements.input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        performSearch();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        closePanel();
      }
    });

    if (state.docClickHandler) {
      doc.removeEventListener('click', state.docClickHandler);
    }
    state.docClickHandler = event => {
      if (!elements) return;
      if (!isActionsPopoverOpen()) return;
      if (elements.actionsMenu?.contains?.(event.target)) return;
      setActionsPopoverVisible(false);
    };
    doc.addEventListener('click', state.docClickHandler);

    state.keydownHandler = event => {
      const visible = elements.panel.classList.contains('th-visible');

      if (event.key === 'Escape' && visible) {
        if (isActionsPopoverOpen()) {
          event.preventDefault();
          event.stopPropagation();
          setActionsPopoverVisible(false);
          return;
        }
        closePanel();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyF') {
        event.preventDefault();
        openPanel(true);
      }
    };
    doc.addEventListener('keydown', state.keydownHandler, true);

    const chatContainer = getChatContainer();
    if (chatContainer) {
      installMessageFavoriteButtons();
    }
  }

  function loadScreenshotLib() {
    const lib = window.modernScreenshot || parentWin.modernScreenshot;
    if (lib) {
      return Promise.resolve(lib);
    }

    // Load the packaged browser build so PNG export also works offline.
    return new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = new URL('./vendor/modern-screenshot-4.7.0.js', import.meta.url).href;
      script.onload = () => {
        const loadedLib = window.modernScreenshot || parentWin.modernScreenshot;
        if (!loadedLib) {
          reject(new Error('modern-screenshot loaded but global not found'));
          return;
        }
        resolve(loadedLib);
      };
      script.onerror = () => reject(new Error('Failed to load modern-screenshot'));
      doc.head.appendChild(script);
    });
  }

  async function init() {
    state.helper = createTavernChatHelper(() => parentWin.SillyTavern.getContext());
    await initDB();
    try {
      const favorites = await readV1Favorites();
      await importFavorites(favorites, { keepExisting: true });
    } catch (error) {
      logger.warn('[ChatSearch] migration from version 1.0.0 failed:', error);
    }
    try {
      const storage = parentWin.localStorage ?? localStorage;
      if (!storage.getItem(PURGE_DELETED_PAYLOAD_FLAG)) {
        purgeDeletedFavoritePayloadsDB()
          .then(result => {
            if (result?.payloadDeletes) {
              logger.info(`[ChatSearch] purged payload for ${result.payloadDeletes} deleted favorites.`);
            }
            storage.setItem(PURGE_DELETED_PAYLOAD_FLAG, '1');
          })
          .catch(error => {
            logger.warn('[ChatSearch] deleted payload purge failed:', error);
          });
      }
    } catch (error) {
      logger.warn('[ChatSearch] deleted payload purge skipped:', error);
    }
    // 初始化时不需要加载收藏，等用户切换到对应标签页时再加载
    state.favorites = [];

    loadScreenshotLib().catch(error => {
      logger.warn('[ChatSearch] screenshot lib load failed:', error);
    });

    injectStyle();
    buildUI();
    attachHandlers();
    state.cleanupEntrypoints = installChatSearchEntrypoints(doc, () => openPanel(true));
    renderResults([], '');

    // Pull/push is triggered when the panel enters favorites/gallery, or when local changes happen.

    window.ChatSearchPortal = {
      open: openPanel,
      close: closePanel,
      toggle: () => togglePanel(),
      openFavorites: () => {
        switchMode('favorites');
        openPanel();
      },
      openGallery: () => {
        switchMode('gallery');
        openPanel();
      },
      version: '1.1.0',
    };
  }

  init().catch(error => {
    logger.error('[ChatSearch] initialization failed:', error);
  });
})();
