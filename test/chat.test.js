import assert from 'node:assert/strict';
import test from 'node:test';
import { activeChat, describeMessage, locateSource } from '../chat.js';
import { makeClip, parseBackup } from '../storage.js';

const context = {
    chatId: '番外',
    characterId: 0,
    characters: [{ avatar: 'hero.png', name: '角色' }],
};

test('two runs on floor 20 have independent immutable snapshots', () => {
    const chat = activeChat(context);
    const message = { name: '角色', mes: '第一个番外', swipe_id: 0, send_date: 100 };
    const first = makeClip(describeMessage(chat, message, 20));
    Object.assign(message, { mes: '第二个番外', swipe_id: 1, send_date: 200 });
    const second = makeClip(describeMessage(chat, message, 20));

    assert.notEqual(first.id, second.id);
    assert.equal(first.floor, second.floor);
    const restored = parseBackup({ format: 'tavern-chat-clips', version: 1, clips: [first, second] });
    assert.deepEqual(restored.map(clip => [clip.floor, clip.swipeId, clip.text]), [
        [20, 0, '第一个番外'], [20, 1, '第二个番外'],
    ]);
});

test('repeated clicks on unchanged floor 20 produce three separate favorites', () => {
    const item = describeMessage(activeChat(context), { name: '角色', mes: '同一段番外' }, 20);
    const clips = Array.from({ length: 3 }, () => makeClip(item));
    assert.equal(new Set(clips.map(clip => clip.id)).size, 3);
    assert.deepEqual(clips.map(clip => [clip.floor, clip.text]), Array(3).fill([20, '同一段番外']));
});

test('source jump identifies the old swipe after a floor moves', () => {
    const chat = activeChat(context);
    const first = { name: '角色', mes: '第一个番外', swipe_id: 0, send_date: 100 };
    const saved = makeClip(describeMessage(chat, first, 20));
    const moved = {
        ...first, mes: '第二个番外', swipe_id: 1, send_date: 200,
        swipes: [first.mes, '第二个番外'], swipe_info: [{ send_date: 100 }, { send_date: 200 }],
    };
    const messages = Array(20).fill(null);
    messages[19] = moved;
    assert.equal(locateSource(messages, saved)?.floor, 19);
    assert.equal(locateSource(messages, saved)?.visible, false);
    messages[19] = { ...moved, swipes: ['第二个番外'] };
    assert.equal(locateSource(messages, saved), null);
});

test('chat identity includes the character or group even when chat names match', () => {
    const single = activeChat(context);
    const group = activeChat({ ...context, groupId: '42', groups: [{ id: 42, name: '群聊' }] });
    assert.equal(single.chatKey, JSON.stringify(['character', 'hero.png', '番外']));
    assert.equal(group.chatKey, JSON.stringify(['group', '42', '番外']));
});
