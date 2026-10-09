/** Grok Bot 0.68.1's installed sidebar route and focus targets, not guessed web paths.
 * See docs/grok-webhook-links.html. IDs must come from actual native routine metadata.
 */
const agentPattern = /^[A-Za-z0-9_-]{1,128}$/;
const routinePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function grokRoutineLinks(agentId: string, routineId: string) {
  if (!agentPattern.test(agentId) || !routinePattern.test(routineId)) throw new Error('Use the actual bot ID and local routine ID returned by Grok, not its display name or server webhook ID.');
  const link = (target: string, native = false) => {
    const url = new URL(native ? 'grokbot://app/v1/sidebar' : 'https://cursor.com/grok-bot/link/v1/sidebar');
    url.search = new URLSearchParams({ agent: agentId, tab: 'routines', automation: routineId, target }).toString();
    return url.href;
  };
  return { agent_id: agentId, routine_id: routineId, key_settings_url: link('webhook-key'),
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
    || !url.searchParams.get('agent') || !url.searchParams.get('automation')) {
    throw new Error('The key link must identify the bot and routine and target webhook-key; a general Routines page is insufficient.');
  }
  return grokRoutineLinks(url.searchParams.get('agent')!, url.searchParams.get('automation')!);
}
