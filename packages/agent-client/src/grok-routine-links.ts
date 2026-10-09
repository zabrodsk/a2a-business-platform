/** Grok Bot 0.68.1's installed sidebar route and focus targets, not guessed web paths.
 * See docs/grok-webhook-links.html. IDs must come from actual native routine metadata.
 */
const agentPattern = /^[A-Za-z0-9_-]{1,128}$/;
const routinePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function grokRoutineLinks(agentId: string | undefined, routineId: string) {
  if (agentId !== undefined && !agentPattern.test(agentId) || !routinePattern.test(routineId)) throw new Error('Use actual native IDs, not a display name or server webhook ID.');
  const link = (target: string, native = false) => {
    const url = new URL(native ? 'grokbot://app/v1/sidebar' : 'https://cursor.com/grok-bot/link/v1/sidebar');
    url.search = new URLSearchParams({ ...(agentId ? {agent:agentId} : {}), tab: 'routines', automation: routineId, target }).toString();
    return url.href;
  };
  return { ...(agentId ? {agent_id:agentId} : {}), scope: agentId ? 'specific_bot' : 'current_bot', routine_id: routineId, key_settings_url: link('webhook-key'),
    native_key_settings_url: link('webhook-key', true), callback_settings_url: link('webhook-url'),
    native_callback_settings_url: link('webhook-url', true) };
}

export function parseGrokKeySettingsLink(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Use a routine-specific Grok webhook-key link.'); }
  const native = ['grokbot:', 'sand:'].includes(url.protocol) && url.hostname === 'app' && url.pathname === '/v1/sidebar';
  const https = url.origin === 'https://cursor.com' && ['/grok-bot/link/v1/sidebar', '/sand/link/v1/sidebar'].includes(url.pathname);
  const allowed = ['agent', 'tab', 'automation', 'target'];
  if ((!native && !https) || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some(k => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1)
    || url.searchParams.get('tab') !== 'routines' || url.searchParams.get('target') !== 'webhook-key'
    || !url.searchParams.get('automation')) {
    throw new Error('The key link must select a routine and target webhook-key; a general Routines page is insufficient.');
  }
  return grokRoutineLinks(url.searchParams.get('agent') ?? undefined, url.searchParams.get('automation')!);
}

export function grokWebhookHandoff(input: { agent_id?: string; routine_id: string; callback_url?: string }) {
  const links = grokRoutineLinks(input.agent_id, input.routine_id);
  let callback: string | undefined;
  if (input.callback_url !== undefined) {
    const url = new URL(input.callback_url);
    if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Use the actual routine callback URL.');
    callback = url.href;
  }
  return { ...links, ...(callback ? { callback_url: callback } : {}), handoff_ready: true, callback_known: Boolean(callback), key_entry: 'native_grok_masked_input',
    requested_fields: callback ? ['webhook_key'] : ['callback_url','webhook_key'],
    user_message: callback
      ? `Copy your [webhook key](${links.key_settings_url}) into the secure box below.`
      : `Copy the [webhook URL](${links.callback_settings_url}) into the URL field and the [webhook key](${links.key_settings_url}) into the secure box below.`,
    instruction: 'Show only user_message with these exact links and the requested native input fields. No setup narration, catalog summary, method chooser or general Routines link. Collect any missing URL together with the secret, not afterwards. Current-bot links must be opened from this bot’s conversation. Verify actual native wake-up before saying ready.' };
}
