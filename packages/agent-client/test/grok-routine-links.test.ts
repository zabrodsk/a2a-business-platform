import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokRoutineLinks, parseGrokKeySettingsLink, grokWebhookHandoff } from '../src/grok-routine-links.js';

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

test('current-bot links work without a separate self-ID lookup and missing URL is collected in the same handoff', () => {
  const current=grokRoutineLinks(undefined,'pneu-demo-replies');assert.equal(current.scope,'current_bot');assert.equal(new URL(current.key_settings_url).searchParams.has('agent'),false);assert.deepEqual(parseGrokKeySettingsLink(current.key_settings_url),current);
  const pending=grokWebhookHandoff({routine_id:'pneu-demo-replies'});assert.equal(pending.handoff_ready,true);assert.equal(pending.callback_known,false);assert.deepEqual(pending.requested_fields,['callback_url','webhook_key']);assert.ok(pending.user_message.includes(pending.key_settings_url));assert.ok(pending.user_message.includes(pending.callback_settings_url));
  const ready=grokWebhookHandoff({routine_id:'pneu-demo-replies',agent_id:'bot-123',callback_url:'https://api2.cursor.sh/test-fixture-webhook'});assert.equal(ready.callback_known,true);assert.deepEqual(ready.requested_fields,['webhook_key']);assert.ok(!ready.user_message.includes('URL field'));
});
