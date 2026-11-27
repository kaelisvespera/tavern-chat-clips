import assert from 'node:assert/strict';
import test from 'node:test';
import { convertV1Backup } from '../v1-migration.js';

test('migration retains independent snapshots with the same floor and content', () => {
    const first = { id: 'first', floor: 20, chatId: 'story', text: '<第一行>\n第二行' };
    const second = { ...first, id: 'second', title: '另存', note: '金句' };
    const favorites = convertV1Backup({ format: 'tavern-chat-clips', version: 1, clips: [first, second] });

    assert.equal(favorites.length, 2);
    assert.notEqual(favorites[0].uuid, favorites[1].uuid);
    assert.deepEqual(favorites.map(item => item.messageId), [20, 20]);
    assert.equal(favorites[0].messageHtml, '&lt;第一行&gt;<br>第二行');
    assert.equal(favorites[1].title, '另存');
    assert.equal(favorites[1].subtitle, '金句');
    assert.equal(favorites[1].groupId, null);
});

test('a v1 record previously imported from the original retains the original UUID', () => {
    const clips = [{ id: 'legacy:old-uuid', floor: 2, text: '旧收藏', groupId: '42' }];
    const [favorite] = convertV1Backup({ format: 'tavern-chat-clips', version: 1, clips });
    assert.equal(favorite.uuid, 'old-uuid');
    assert.equal(favorite.groupId, '42');
});
