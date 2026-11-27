export function activeChat(context) {
    const chatId = String(context.getCurrentChatId?.() ?? context.chatId ?? '');
    if (!chatId) return null;

    const groupId = String(context.groupId ?? '');
    const character = groupId ? undefined : context.characters?.[context.characterId];
    const characterAvatar = character?.avatar ?? '';
    if (!groupId && !characterAvatar) return null;

    const group = context.groups?.find(entry => String(entry.id) === groupId);
    const label = group?.name || character?.name;
    const chatLabel = label && label !== chatId ? `${label} / ${chatId}` : chatId;
    const owner = groupId ? ['group', groupId] : ['character', characterAvatar];
    return { chatId, chatLabel, chatKey: JSON.stringify([...owner, chatId]), groupId, characterAvatar };
}

function roleOf(message) {
    if (message.is_system) return 'system';
    return message.is_user ? 'user' : 'assistant';
}

export function describeMessage(chat, message, floor) {
    if (typeof message?.mes !== 'string') return null;

    return {
        ...chat,
        floor,
        author: message.name ?? '',
        role: roleOf(message),
        sentAt: String(message.send_date ?? ''),
        swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : null,
        sourceText: message.mes,
        text: message.mes,
        kind: 'message',
    };
}

export function locateSource(messages, clip) {
    if (!clip.sourceText) return null;

    const sentAt = String(clip.sentAt ?? '');
    const matches = [];
    for (const [floor, message] of messages.entries()) {
        if (!message || (clip.role && roleOf(message) !== clip.role)) continue;
        if (clip.author && message.name !== clip.author) continue;

        const visible = message.mes === clip.sourceText;
        let hasTimestamp = Boolean(sentAt && visible && String(message.send_date ?? '') === sentAt);
        let hasText = visible;
        if (Array.isArray(message.swipes)) {
            message.swipes.forEach((swipe, index) => {
                if (swipe !== clip.sourceText) return;
                hasText = true;
                const date = message.swipe_info?.[index]?.send_date;
                hasTimestamp ||= Boolean(sentAt && String(date ?? '') === sentAt);
            });
        }
        if (hasText) matches.push({ floor, visible, hasTimestamp });
    }

    const timed = matches.filter(match => match.hasTimestamp);
    if (timed.length === 1) return timed[0];
    if (timed.length > 1) return null;
    // TT may keep inactive swipe bodies cold until the floor is opened.
    const found = messages[clip.floor];
    if (sentAt && found?.tt_swipe_cold
        && roleOf(found) === clip.role && found.name === clip.author
        && String(found.send_date ?? '') === sentAt) {
        return { floor: clip.floor, visible: false };
    }
    return matches.length === 1 && (!sentAt || matches[0].floor === clip.floor) ? matches[0] : null;
}
