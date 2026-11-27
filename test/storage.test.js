import assert from 'node:assert/strict';
import test from 'node:test';
import { makeClip, parseBackup } from '../storage.js';

const chatKey = JSON.stringify(['character', 'role.png', '演示聊天']);
const source = {
    chatKey,
    chatId: '演示聊天',
    characterAvatar: 'role.png',
    chatLabel: '对话',
    floor: 0,
    swipeId: 2,
    author: '角色',
    role: 'assistant',
    sentAt: '2026-01-01 13:00',
    sourceText: '第一句。\n第二句。 ',
};

test('a full message and multiple independent excerpts can share one source', () => {
    const whole = makeClip({ ...source, text: source.sourceText, kind: 'message' });
    const first = makeClip({ ...source, text: '第一句。', kind: 'clip' });
    const second = makeClip({ ...source, text: '第二句。', kind: 'clip' });

    assert.equal(new Set([whole.id, first.id, second.id]).size, 3);
    assert.deepEqual([whole.text, first.text, second.text], ['第一句。\n第二句。', '第一句。', '第二句。']);
    for (const clip of [whole, first, second]) {
        assert.equal(clip.chatKey, chatKey);
        assert.equal(clip.floor, 0);
        assert.equal(clip.swipeId, 2);
        assert.equal(clip.sourceText, source.sourceText);
    }
    assert.deepEqual(parseBackup({ format: 'tavern-chat-clips', version: 1, clips: [whole, first, second] }), [whole, first, second]);
});

test('legacy imports keep IDs, edits, titles and notes and skip deleted entries', () => {
    const legacy = {
        format: 'th-chat-favorites-export',
        version: 1,
        favorites: [{
            uuid: 'existing-id', chatId: '演示聊天', characterAvatar: 'role.png', chatName: '旧对话',
            messageId: '0', charName: '角色', role: 'assistant', title: '标题', subtitle: '金句',
            message: '原消息', editedMessage: '收藏版', createdAt: 10, updatedAt: 20, deletedAt: null,
        }, { uuid: 'deleted', message: '已删除', deletedAt: 10 }, {
            uuid: 'unknown-chat', chatId: 123, characterAvatar: 'unknown', messageId: 5, previewText: '摘要',
        }],
    };
    const [edited, unresolved] = parseBackup(legacy);
    assert.equal(edited.id, 'legacy:existing-id');
    assert.equal(edited.chatKey, chatKey);
    assert.equal(edited.floor, 0);
    assert.equal(edited.text, '收藏版');
    assert.equal(edited.sourceText, '原消息');
    assert.equal(edited.title, '标题');
    assert.equal(edited.note, '金句');
    assert.equal(edited.createdAt, 10);
    assert.equal(edited.updatedAt, 20);
    assert.equal(unresolved.chatKey, '');
    assert.equal(unresolved.chatId, '123');
    assert.equal(unresolved.text, '摘要');
    assert.equal(unresolved.sourceText, '');
    assert.equal(parseBackup(legacy).length, 2);
});

test('image-only legacy entries keep embedded raster thumbnails', () => {
    const thumbnail = 'data:image/png;base64,AAAA';
    const [clip] = parseBackup([{ uuid: 'image', images: [
        { thumbnail, originalSrc: 'https://example.test/private.png' },
        { thumbnail: 'data:image/svg+xml;base64,AAAA' },
    ] }]);
    assert.deepEqual(clip.images, [thumbnail]);
    assert.equal(clip.text, '');
    assert.throws(() => makeClip({ text: ' ', images: ['https://example.test/external.png'] }), /收藏内容为空/);
    assert.throws(() => parseBackup({ type: 'script' }), /收藏备份/);
});
