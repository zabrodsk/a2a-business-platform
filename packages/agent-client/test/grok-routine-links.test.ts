import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokRoutineLinks, parseGrokKeySettingsLink } from '../src/grok-routine-links.js';

test('Grok links select the exact bot, routine and webhook field for HTTPS and native clients', () => {
  const links=grokRoutineLinks('bot_ABC-123','pneu-demo-replies');
  const url=new URL(links.key_settings_url);
  assert.equal(url.origin,'https://cursor.com');assert.equal(url.pathname,'/grok-bot/link/v1/sidebar');
  assert.deepEqual(Object.fromEntries(url.searchParams),{agent:'bot_ABC-123',tab:'routines',automation:'pneu-demo-replies',target:'webhook-key'});
  assert.equal(new URL(links.native_key_settings_url).protocol,'grokbot:');
  assert.equal(new URL(links.callback_settings_url).searchParams.get('target'),'webhook-url');
  assert.deepEqual(parseGrokKeySettingsLink(links.native_key_settings_url),links);
  assert.deepEqual(parseGrokKeySettingsLink(links.key_settings_url),links);
  assert.deepEqual(parseGrokKeySettingsLink(links.native_key_settings_url.replace('grokbot:','sand:')),links);
});

test('a general page, missing routine, wrong field, duplicate selectors or an unrelated URL cannot pass the key handoff', () => {
  const base='https://cursor.com/grok-bot/link/v1/sidebar';
  for (const value of [base+'?agent=bot&tab=routines',base+'?agent=bot&tab=routines&target=webhook-key',
    base+'?agent=bot&tab=routines&automation=routine&target=webhook-url',
    base+'?agent=bot&tab=routines&automation=routine&target=webhook-key&automation=other',
    base+'?agent=bot&tab=routines&automation=routine&target=webhook-key&secret=x',
    'https://evil.example/grok-bot/link/v1/sidebar?agent=bot&tab=routines&automation=routine&target=webhook-key',
    'https://grok.com/routines','javascript:alert(1)']) assert.throws(()=>parseGrokKeySettingsLink(value));
  for(const [agent,routine]of [['','routine'],['bot','Pneu 007 demo shop replies'],['bot','../routine'],['bot&target=other','routine']])assert.throws(()=>grokRoutineLinks(agent,routine));
});
