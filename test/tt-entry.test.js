import assert from 'node:assert/strict';
import test from 'node:test';
import { createTavernChatHelper } from '../tt-entry.js';

test('the original search sees active replies with narrator and hidden roles distinguished', () => {
    const chat = [
        { name: '用户', is_user: true, mes: '用户原话' },
        { name: '人物', is_system: true, mes: '隐藏回复', swipes: ['旧回复', '隐藏回复'] },
        { name: '旁白', is_system: true, extra: { type: 'narrator' }, mes: '叙述' },
        { name: '人物', mes: '' },
    ];
    const helper = createTavernChatHelper(() => ({ chat, substituteParamsExtended: () => '2' }));

    assert.equal(helper.getLastMessageId(), 2);
    assert.deepEqual(helper.getChatMessages('0-2').map(entry => [entry.role, entry.is_hidden, entry.message]), [
        ['user', false, '用户原话'], ['assistant', true, '隐藏回复'], ['system', true, '叙述'],
    ]);
    assert.equal(helper.getChatMessages('1')[0].message_id, 1);
});
