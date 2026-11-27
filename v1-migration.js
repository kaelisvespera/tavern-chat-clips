const format = 'tavern-chat-clips';

function text(value) {
  return typeof value === 'string' ? value : '';
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n?|\n/g, '<br>');
}

function convertClip(clip) {
  if (!clip || !text(clip.id)) return null;

  const message = text(clip.text);
  const images = (Array.isArray(clip.images) ? clip.images : [])
    .filter(src => typeof src === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(src))
    .map(src => ({ originalSrc: src, thumbnail: src }));
  if (!message && !images.length) return null;

  const messageId = Number.isInteger(clip.floor) && clip.floor >= 0 ? clip.floor : null;
  const nativeUuid = clip.id.startsWith('legacy:') ? clip.id.slice('legacy:'.length) : '';
  const imageMarkup = images.map(({ thumbnail }) => `<img src="${thumbnail}" alt="消息图片">`).join('');
  return {
    uuid: nativeUuid || `${format}-v1:${clip.id}`,
    messageId,
    chatId: text(clip.chatId) || 'unknown',
    characterId: 'unknown',
    characterAvatar: text(clip.characterAvatar) || 'unknown',
    groupId: text(clip.groupId) || null,
    chatName: text(clip.chatLabel),
    charName: text(clip.author) || '未知',
    role: text(clip.role),
    title: text(clip.title) || (messageId !== null ? `消息 #${messageId}` : '收藏'),
    subtitle: text(clip.note),
    message,
    messageHtml: escapeText(message) + (imageMarkup ? `<div class="mes_img_container">${imageMarkup}</div>` : ''),
    images,
    previewText: message.slice(0, 500),
    ...(text(clip.sourceText) && clip.sourceText !== message ? { originalMessage: clip.sourceText } : {}),
    createdAt: clip.createdAt,
    updatedAt: clip.updatedAt,
    deletedAt: null,
  };
}

export function convertV1Backup(data) {
  if (data?.format !== format || data.version !== 1 || !Array.isArray(data.clips)) return null;
  return data.clips.map(convertClip).filter(Boolean);
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readV1Favorites(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return [];

  const request = indexedDB.open(format);
  let missing = false;
  request.onupgradeneeded = () => {
    missing = true;
    request.transaction.abort();
  };

  let database;
  try {
    database = await readRequest(request);
  } catch (error) {
    if (missing) return [];
    throw error;
  }

  try {
    if (!database.objectStoreNames.contains('clips')) return [];
    const transaction = database.transaction('clips', 'readonly');
    const records = await readRequest(transaction.objectStore('clips').getAll());
    return records.map(convertClip).filter(Boolean);
  } finally {
    database.close();
  }
}
