import { activeChat, describeMessage, locateSource } from './chat.js';
import { createClipStore, makeClip, readLegacyFavorites } from './storage.js';
import { createPanel, editItem, showItem } from './view.js';

const context = () => globalThis.SillyTavern.getContext();
const chatElement = document.getElementById('chat');
const messageSelector = '.mes[mesid]';
const store = createClipStore();
let filter = { tab: 'favorites', query: '', scope: 'all' };
let revision = 0;
let navigationPending = false;
let pendingSelection = null;

function notify(level, message) {
    globalThis.toastr?.[level]?.(message);
}

async function perform(task, message) {
    try {
        return await task();
    } catch (error) {
        console.error('[聊天摘录]', error);
        notify('error', message);
    }
}

function button(className, label, iconClass) {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = className;
    result.title = label;
    result.setAttribute('aria-label', label);
    if (iconClass) {
        const icon = document.createElement('i');
        icon.className = iconClass;
        icon.setAttribute('aria-hidden', 'true');
        result.append(icon);
    } else {
        result.textContent = label;
    }
    return result;
}

function messageFromElement(element) {
    const contextNow = context();
    const chat = activeChat(contextNow);
    const floor = Number(element.getAttribute('mesid'));
    if (!chat || !Number.isInteger(floor) || floor < 0) return null;
    return describeMessage(chat, contextNow.chat[floor], floor);
}

function snapshot(element, fallback) {
    const content = element.querySelector('.mes_text');
    const parts = [content?.innerText?.trim()];
    const imageElements = [...element.querySelectorAll('.mes_text img, .mes_img_container img')];
    for (const frame of content?.querySelectorAll('iframe') ?? []) {
        // An opaque or cross-origin frame cannot be read by the extension.
        const body = frame.contentDocument?.body;
        if (!body) continue;
        parts.push(body.innerText?.trim());
        imageElements.push(...body.querySelectorAll('img'));
    }

    const images = [];
    for (const image of imageElements) {
        if (!image.complete || !image.naturalWidth || !image.naturalHeight) continue;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        try {
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            images.push(canvas.toDataURL('image/webp', 0.85));
        } catch {
            // The host can display cross-origin images that the canvas cannot export.
        }
    }
    return { text: parts.filter(Boolean).join('\n\n') || fallback, images };
}

async function saveClip(draft) {
    if (!draft || (!draft.text?.trim() && !draft.images?.length)) {
        notify('warning', '这条消息没有可收藏的内容。');
        return false;
    }
    const saved = await perform(async () => {
        await store.add(makeClip(draft));
        return true;
    }, '收藏失败，请重试。');
    if (saved) {
        notify('success', draft.kind === 'clip' ? '已收藏选中文字。' : '已新增一条整楼收藏。');
        updatePanel();
    }
    return saved;
}

function saveSearchItem(item) {
    const host = context();
    const message = activeChat(host)?.chatKey === item.chatKey ? host.chat[item.floor] : null;
    const floor = message?.mes === item.sourceText && chatElement.querySelector(`${messageSelector}[mesid="${item.floor}"]`);
    return saveClip(floor ? { ...item, ...snapshot(floor, item.text) } : item);
}

function addMessageAction(messageElement) {
    const controls = messageElement.querySelector('.extraMesButtons, .mes_buttons');
    if (!controls || controls.querySelector('.tcc-message-action')) return;
    const action = button('tcc-message-action', '收藏整楼', 'fa-regular fa-bookmark');
    action.addEventListener('click', () => {
        const message = messageFromElement(messageElement);
        if (message) void saveClip({ ...message, ...snapshot(messageElement, message.text) });
    });
    controls.append(action);
}

const selectionButton = button('tcc-selection', '收藏选中文字');
selectionButton.hidden = true;
document.body.append(selectionButton);

function captureSelection() {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const parentOf = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const start = parentOf(range.startContainer)?.closest('.mes_text');
    const end = parentOf(range.endContainer)?.closest('.mes_text');
    const messageElement = start?.closest(messageSelector);
    if (!start || start !== end || !chatElement.contains(messageElement)) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const message = messageFromElement(messageElement);
    return message ? { ...message, text, kind: 'clip' } : null;
}

function setSelection() {
    pendingSelection = captureSelection();
    selectionButton.hidden = !pendingSelection;
}

document.addEventListener('selectionchange', setSelection);
selectionButton.addEventListener('pointerdown', event => event.preventDefault());
selectionButton.addEventListener('click', async () => {
    const draft = captureSelection() ?? pendingSelection;
    if (!draft || activeChat(context())?.chatKey !== draft.chatKey) return;
    selectionButton.disabled = true;
    try {
        if (await saveClip(draft)) {
            if (captureSelection()?.text === draft.text) document.getSelection()?.removeAllRanges();
            setSelection();
        }
    } finally {
        selectionButton.disabled = false;
    }
});

function termsIn(query) {
    return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function includesTerms(text, terms) {
    const lower = text.toLocaleLowerCase();
    return terms.every(term => lower.includes(term));
}

async function updatePanel() {
    if (!panel.isOpen()) return;
    const current = ++revision;
    const request = filter;
    const host = context();
    const chat = activeChat(host);
    const terms = termsIn(request.query);
    try {
        let items = [];
        if (request.tab === 'search') {
            if (chat && terms.length) {
                for (let floor = host.chat.length - 1; floor >= 0; floor--) {
                    const item = describeMessage(chat, host.chat[floor], floor);
                    if (item && includesTerms(item.text, terms)) items.push(item);
                }
            }
        } else if (request.scope !== 'current' || chat) {
            items = await store.list(request.scope === 'current' ? chat.chatKey : undefined);
            if (terms.length) {
                items = items.filter(item => includesTerms([
                    item.title, item.note, item.text, item.author, item.chatLabel, item.chatId,
                ].join('\n'), terms));
            }
            items = items.map(item => ({
                ...item,
                canJump: Boolean(item.sourceText && (item.characterAvatar || item.groupId || chat?.chatKey === item.chatKey)),
            }));
        }
        if (current === revision && panel.isOpen()) {
            panel.update({ ...request, items, chatLabel: chat?.chatLabel, chatAvailable: Boolean(chat) });
        }
    } catch (error) {
        console.error('[聊天摘录]', error);
        if (current === revision) notify('error', '读取收藏失败，请重试。');
    }
}

async function jumpTo(item) {
    if (navigationPending) return;
    navigationPending = true;
    try {
        await perform(async () => {
            let host = context();
            if (activeChat(host)?.chatKey !== item.chatKey) {
                if (item.groupId) await host.openGroupChat(item.groupId, item.chatId);
                else if (item.characterAvatar) await host.openCharacterChat(item.chatId, item.characterAvatar);
                host = context();
                if (activeChat(host)?.chatKey !== item.chatKey) {
                    notify('warning', '未能打开来源聊天。');
                    return;
                }
            }

            const match = locateSource(host.chat, item);
            if (!match) {
                notify('warning', '找不到对应版本。收藏快照仍可阅读。');
                return;
            }
            if (typeof host.executeSlashCommandsWithOptions === 'function') {
                await host.executeSlashCommandsWithOptions(`/chat-jump ${match.floor}`);
            } else {
                const message = chatElement.querySelector(`${messageSelector}[mesid="${match.floor}"]`);
                if (!message) throw new Error('Chat jump is unavailable');
                message.scrollIntoView({ block: 'center' });
            }
            panel.close();
            if (!match.visible) notify('info', '已定位来源楼层。收藏的版本可在快照中查看。');
        }, '跳转失败，请打开来源聊天后重试。');
    } finally {
        navigationPending = false;
    }
}

async function edit(item) {
    const changes = await editItem(item);
    if (!changes) return;
    const { title, note } = changes;
    await perform(() => store.update(item.id, { title, note }), '保存标题和备注失败。');
    updatePanel();
}

function openItem(item) {
    showItem(item, {
        onCopy: entry => perform(async () => {
            await navigator.clipboard.writeText(entry.text);
            notify('success', '已复制正文。');
        }, '复制失败，可手动选择正文。'),
        onJump: jumpTo,
        onEdit: item.id ? edit : undefined,
        onSaveSearch: item.id ? undefined : saveSearchItem,
    });
}

async function importBackup(data) {
    const { imported, skipped } = await store.import(data);
    notify('success', `导入 ${imported} 条，跳过 ${skipped} 条。`);
    updatePanel();
}

const panel = createPanel({
    onFilter(next) {
        filter = next;
        updatePanel();
    },
    onOpen: openItem,
    onJump: jumpTo,
    onEdit: edit,
    onSaveSearch: saveSearchItem,
    onRemove: item => perform(async () => {
        await store.remove(item.id);
        notify('success', '已删除收藏。');
        updatePanel();
    }, '删除收藏失败。'),
    onExport: () => perform(async () => {
        const backup = await store.backup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `聊天摘录-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, '导出收藏失败。'),
    onImport: file => perform(async () => importBackup(JSON.parse(await file.text())), '导入失败，请选择收藏备份 JSON。'),
    onImportLegacy: () => perform(async () => {
        const backup = await readLegacyFavorites();
        if (!backup.favorites.length) {
            notify('info', '此酒馆未找到旧收藏。也可用旧脚本导出的 JSON 导入。');
            return;
        }
        await importBackup(backup);
    }, '读取旧收藏失败，可尝试导入旧脚本备份。'),
});

const menuAction = button('list-group-item flex-container tcc-chat-action', '聊天摘录', 'fa-regular fa-bookmark');
menuAction.id = 'tcc-open-panel';
menuAction.append(document.createTextNode('聊天摘录'));
menuAction.addEventListener('click', () => panel.open());
document.getElementById('extensionsMenu')?.append(menuAction);

document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyF') {
        if (document.querySelector('dialog[open]') && !panel.isOpen()) return;
        event.preventDefault();
        panel.open('search');
    }
});

chatElement.querySelectorAll(messageSelector).forEach(addMessageAction);
new MutationObserver(records => {
    const addedMessages = new Set();
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches(messageSelector)) addedMessages.add(node);
            if (node.matches('.extraMesButtons, .mes_buttons')) addedMessages.add(node.closest(messageSelector));
            for (const message of node.querySelectorAll(messageSelector)) addedMessages.add(message);
        }
    }
    for (const message of addedMessages) if (message?.isConnected) addMessageAction(message);
}).observe(chatElement, { childList: true, subtree: true });

const host = context();
for (const name of ['CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED']) {
    const event = host.eventTypes?.[name];
    if (event) host.eventSource?.on(event, () => {
        if (name === 'CHAT_CHANGED') {
            pendingSelection = null;
            selectionButton.hidden = true;
        }
        updatePanel();
    });
}
