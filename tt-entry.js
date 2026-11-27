export function createTavernChatHelper(getContext) {
    return {
        getLastMessageId() {
            const context = getContext();
            if (!context.chat?.length) return -1;
            const last = context.substituteParamsExtended?.('{{lastMessageId}}');
            if (last === '') return -1;
            return /^\d+$/.test(last) ? Number(last) : context.chat.length - 1;
        },

        // The original search only reads the active reply of each message.
        getChatMessages(range) {
            const chat = getContext().chat ?? [];
            const bounds = String(range).match(/^(-?\d+)(?:-(-?\d+))?$/);
            if (!bounds || !chat.length) return [];

            const index = value => {
                const numeric = Number(value);
                return numeric < 0 ? chat.length + numeric : numeric;
            };
            const first = index(bounds[1]);
            const last = index(bounds[2] ?? bounds[1]);
            const start = Math.max(0, Math.min(first, last));
            const end = Math.min(chat.length - 1, Math.max(first, last));
            const messages = [];

            for (let id = start; id <= end; id++) {
                const message = chat[id];
                if (!message) continue;

                // Hiding a message from the prompt does not turn it into a narrator message.
                const isNarrator = message.extra?.type === 'narrator';
                const role = isNarrator
                    ? (message.is_user ? 'unknown' : 'system')
                    : (message.is_user ? 'user' : 'assistant');
                messages.push({
                    message_id: id,
                    name: message.name,
                    role,
                    is_hidden: Boolean(message.is_system),
                    message: message.mes ?? '',
                });
            }

            return messages;
        },
    };
}

export function installChatSearchEntrypoints(doc, open) {
    const label = '聊天搜索';
    const menu = doc.getElementById('extensionsMenu');
    const sendForm = doc.getElementById('send_form');
    const openPanel = () => open();

    const menuButton = doc.createElement('button');
    menuButton.type = 'button';
    menuButton.id = 'th-chat-search-extension-menu';
    menuButton.className = 'list-group-item flex-container flexGap5';
    menuButton.style.cssText = 'background: transparent; border: 0; color: inherit; font: inherit; padding: 5px; column-gap: 10px; align-items: baseline; cursor: pointer;';
    const icon = doc.createElement('i');
    icon.className = 'fa-solid fa-magnifying-glass';
    icon.setAttribute('aria-hidden', 'true');
    menuButton.append(icon, doc.createTextNode(label));
    menuButton.addEventListener('click', openPanel);
    menu?.append(menuButton);

    // TT can remove or pop out its own QR bar, so keep this action in a separate row.
    const quickRow = doc.createElement('div');
    quickRow.id = 'th-chat-search-extension-qr';
    quickRow.className = 'flex-container justifyCenter';
    quickRow.style.cssText = 'order: 2; width: 100%;';
    const quickButton = doc.createElement('button');
    quickButton.type = 'button';
    quickButton.className = 'menu_button';
    quickButton.style.cssText = 'margin: 0.15em 0; padding: 0.15em 0.5em; height: auto; font-size: 0.9em;';
    quickButton.textContent = label;
    quickButton.addEventListener('click', openPanel);
    quickRow.append(quickButton);
    sendForm?.append(quickRow);

    return () => {
        menuButton.remove();
        quickRow.remove();
    };
}
