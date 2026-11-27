function element(tag, className = '', content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

function button(label, handler, className = '') {
    const control = element('button', `tcc-button ${className}`.trim(), label);
    control.type = 'button';
    control.addEventListener('click', handler);
    return control;
}

function createDialog(title, className) {
    const dialog = element('dialog', `tcc-dialog ${className}`);
    dialog.setAttribute('aria-label', title);
    const shell = element('div', 'tcc-shell');
    const header = element('header', 'tcc-header');
    const close = button('×', () => dialog.close(), 'tcc-close');
    close.setAttribute('aria-label', '关闭');
    header.append(element('h2', '', title), close);
    shell.append(header);
    dialog.append(shell);
    document.body.append(dialog);
    return { dialog, shell };
}

function sourceLine(item) {
    const author = item.author || { user: '你', assistant: '角色', system: '系统' }[item.role];
    const floor = Number.isInteger(item.floor) && item.floor >= 0 ? `第 ${item.floor} 楼` : '';
    return [item.chatLabel || item.chatId, author, floor].filter(Boolean).join(' / ');
}

function preview(text, query) {
    const line = (text || '').replace(/\s+/g, ' ').trim();
    const result = element('span', 'tcc-preview');
    if (!line) {
        result.textContent = '图片';
        return result;
    }

    const terms = query.trim().split(/\s+/).filter(Boolean);
    const pattern = terms.length
        ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu')
        : null;
    const first = pattern ? line.search(pattern) : -1;
    const start = Math.max(0, first - 25);
    const sample = line.slice(start, start + 240);
    if (start) result.append('…');
    if (pattern) {
        let offset = 0;
        for (const match of sample.matchAll(pattern)) {
            result.append(sample.slice(offset, match.index), element('mark', '', match[0]));
            offset = match.index + match[0].length;
        }
        result.append(sample.slice(offset));
    } else {
        result.append(sample);
    }
    if (start + sample.length < line.length) result.append('…');
    return result;
}

function listItem(item, actions, tab, query) {
    const row = element('li', 'tcc-item');
    row.dataset.kind = item.kind;
    const searchable = tab === 'search';
    const open = button('', () => actions.onOpen(item), 'tcc-entry-open');
    const heading = element('span', 'tcc-entry-heading');
    if (!searchable) {
        heading.append(element('span', 'tcc-kind', item.kind === 'clip' ? '片段' : '整楼'));
    }
    const source = sourceLine(item);
    if (item.title || source) {
        heading.append(element('span', 'tcc-entry-title', item.title || source));
    }
    if (heading.childElementCount) open.append(heading);
    if (item.title && source) open.append(element('span', 'tcc-source', source));
    open.append(preview(item.text, query));
    if (!searchable && item.note) open.append(element('span', 'tcc-note-preview', item.note));
    row.append(open);

    const tools = element('div', 'tcc-entry-actions');
    if (item.canJump !== false) tools.append(button('回到原文', () => actions.onJump(item)));
    if (searchable) {
        tools.append(button('收藏整楼', () => actions.onSaveSearch(item)));
    } else {
        tools.append(
            button('编辑', () => actions.onEdit(item)),
            button('移除', () => actions.onRemove(item)),
        );
    }
    row.append(tools);
    return row;
}

export function createPanel(actions) {
    const { dialog, shell } = createDialog('聊天摘录', 'tcc-panel');
    let tab = 'favorites';
    let scope = 'all';
    const queries = { favorites: '', search: '' };

    const filters = element('div', 'tcc-filters');
    const tabs = element('div', 'tcc-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', '查看内容');
    const favoritesButton = button('收藏', () => selectTab('favorites'));
    const searchButton = button('聊天搜索', () => selectTab('search'));
    tabs.append(favoritesButton, searchButton);

    const toolbar = element('div', 'tcc-toolbar');
    const search = element('input', 'tcc-field');
    search.type = 'search';
    search.enterKeyHint = 'search';
    const selector = element('select', 'tcc-field tcc-scope');
    selector.setAttribute('aria-label', '收藏范围');
    const all = element('option', '', '全部聊天');
    all.value = 'all';
    const current = element('option', '', '当前聊天');
    current.value = 'current';
    selector.append(all, current);
    toolbar.append(search, selector);
    filters.append(tabs, toolbar);

    const main = element('div', 'tcc-scroll');
    const status = element('p', 'tcc-status');
    status.setAttribute('role', 'status');
    const list = element('ul', 'tcc-list');
    main.append(status, list);

    const footer = element('footer', 'tcc-footer');
    const importInput = element('input');
    importInput.hidden = true;
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.addEventListener('change', () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (file) actions.onImport(file);
    });
    footer.append(
        button('导出备份', () => actions.onExport()),
        button('导入备份', () => importInput.click()),
        importInput,
    );
    if (actions.onImportLegacy) footer.append(button('迁移旧收藏', () => actions.onImportLegacy()));
    shell.append(filters, main, footer);

    function notify() {
        actions.onFilter({ tab, query: queries[tab], scope });
    }

    function selectTab(next) {
        if (tab !== next) main.scrollTop = 0;
        tab = next;
        syncControls();
        notify();
    }

    function syncControls() {
        favoritesButton.setAttribute('aria-pressed', String(tab === 'favorites'));
        searchButton.setAttribute('aria-pressed', String(tab === 'search'));
        const placeholder = tab === 'search' ? '搜索当前聊天' : '搜索收藏';
        search.placeholder = placeholder;
        search.setAttribute('aria-label', placeholder);
        if (search.value !== queries[tab]) search.value = queries[tab];
        selector.value = scope;
        selector.hidden = tab === 'search';
        footer.hidden = tab === 'search';
    }

    search.addEventListener('input', () => {
        queries[tab] = search.value;
        main.scrollTop = 0;
        notify();
    });
    selector.addEventListener('change', () => {
        scope = selector.value;
        main.scrollTop = 0;
        notify();
    });

    return {
        open(next = 'favorites') {
            if (!dialog.open) dialog.showModal();
            selectTab(next);
            if (next === 'search') search.focus();
        },
        close() { dialog.close(); },
        isOpen() { return dialog.open; },
        update({ tab: next = tab, query = queries[next], scope: nextScope = scope, items = [], chatLabel, chatAvailable = true }) {
            tab = next;
            scope = nextScope;
            queries[tab] = query;
            syncControls();

            const inChat = tab === 'search' || scope === 'current';
            let message = '';
            if (inChat && !chatAvailable) message = '打开一段聊天后即可使用。';
            else if (tab === 'search' && !query.trim()) message = '输入关键词搜索当前聊天。';
            else if (items.length) message = `${items.length} 条${tab === 'search' ? '结果' : '收藏'}`;
            else if (query.trim()) message = '没有匹配的内容。';
            else if (scope === 'current') message = '当前聊天还没有收藏。选中消息文字即可收藏片段。';
            else message = '收藏夹还是空的。选中消息里的文字，即可收藏片段。';
            if (inChat && chatAvailable && chatLabel) message = `${chatLabel} / ${message}`;
            if (status.textContent !== message) status.textContent = message;
            const scrollTop = main.scrollTop;
            list.replaceChildren(...items.map(item => listItem(item, actions, tab, query)));
            main.scrollTop = scrollTop;
        },
    };
}

export function showItem(item, actions) {
    const { dialog, shell } = createDialog(item.title || (item.kind === 'clip' ? '收藏片段' : '楼层内容'), 'tcc-reader');
    const content = element('div', 'tcc-scroll tcc-reader-content');
    const source = sourceLine(item);
    if (source) content.append(element('p', 'tcc-source', source));
    if (item.text) content.append(element('p', 'tcc-reading-text', item.text));
    for (const src of item.images ?? []) {
        if (typeof src !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(src)) continue;
        const image = element('img', 'tcc-image');
        image.alt = '收藏中的图片';
        image.src = src;
        content.append(image);
    }
    if (item.note) {
        const note = element('aside', 'tcc-note');
        note.append(element('h3', '', '笔记'), element('p', '', item.note));
        content.append(note);
    }

    const footer = element('footer', 'tcc-footer');
    if (item.text && actions.onCopy) footer.append(button('复制文字', () => actions.onCopy(item)));
    if (actions.onJump && item.canJump !== false) {
        footer.append(button('回到原文', () => {
            dialog.close();
            actions.onJump(item);
        }));
    }
    if (actions.onEdit) {
        footer.append(button('编辑', () => {
            dialog.close();
            actions.onEdit(item);
        }));
    }
    if (actions.onSaveSearch) footer.append(button('收藏整楼', () => actions.onSaveSearch(item), 'tcc-primary'));
    shell.append(content, footer);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    return { close: () => dialog.close() };
}

export function editItem(item) {
    const { dialog, shell } = createDialog('编辑收藏', 'tcc-editor');
    const form = element('form', 'tcc-edit-form');
    const fields = element('div', 'tcc-scroll tcc-edit-fields');
    const title = element('input', 'tcc-field');
    title.value = item.title || '';
    title.autofocus = true;
    const titleLabel = element('label', 'tcc-label', '标题');
    titleLabel.append(title);
    const note = element('textarea', 'tcc-field');
    note.rows = 5;
    note.value = item.note || '';
    const noteLabel = element('label', 'tcc-label', '笔记');
    noteLabel.append(note);
    fields.append(titleLabel, noteLabel);

    const footer = element('footer', 'tcc-footer');
    const save = element('button', 'tcc-button tcc-primary', '保存');
    save.type = 'submit';
    footer.append(button('取消', () => dialog.close()), save);
    form.append(fields, footer);
    shell.append(form);

    return new Promise(resolve => {
        let result = null;
        form.addEventListener('submit', event => {
            event.preventDefault();
            result = { title: title.value.trim(), note: note.value.trim(), text: item.text };
            dialog.close();
        });
        dialog.addEventListener('close', () => {
            dialog.remove();
            resolve(result);
        }, { once: true });
        dialog.showModal();
    });
}
