import { ACTIONS, element, describeAction, safeUrl, getPhase, countdown, connectEvents } from './shared.js';

const $ = (id) => document.getElementById(id);
let state = null;
let controlToken = null;
let serverOffset = 0;
let transportConnected = false;
let pending = false;
let actionFingerprint = null;
let settingsDirty = false;
let announcementKey = '';
let refreshPromise = null;
let noticeRoundId = null;
const viewers = { 'demo-alex': 'Alex', 'demo-jules': 'Jules', 'demo-rio': 'Rio', 'demo-sam': 'Sam', 'demo-morgan': 'Morgan' };

function showNotice(message, error = false, roundId = null) {
  noticeRoundId = error ? null : roundId;
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = !message;
  dismissSettledNotice();
}

function dismissSettledNotice() {
  if (!noticeRoundId || noticeRoundId !== state?.round?.id || !['confirmed', 'failed', 'vetoed'].includes(state.round.state)) return;
  noticeRoundId = null;
  $('notice').textContent = '';
  $('notice').hidden = true;
}

function acceptState(next) {
  if (!next || !['demo', 'live'].includes(next.mode)) return;
  if (next.controlToken) controlToken = next.controlToken;
  if (state && Number.isFinite(next.serverTime) && next.serverTime < state.serverTime) return;
  state = next;
  serverOffset = next.serverTime - Date.now();
  dismissSettledNotice();
  render();
}

async function refreshState() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('The local service could not provide its state.');
    acceptState(await response.json());
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}

async function control(path, payload, acceptedMessage) {
  if (pending || !controlToken || !transportConnected) return;
  pending = true;
  showNotice('');
  renderControls();
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Control-Token': controlToken }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `The request was rejected (${response.status}).`);
    if (body.state) acceptState(body.state);
    if (path === '/control/settings') settingsDirty = false;
    showNotice(acceptedMessage, false, path === '/control/rounds/open' ? state?.round?.id : payload.roundId);
    await refreshState();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : 'The action could not be submitted.', true);
  } finally {
    pending = false;
    renderControls();
  }
}

function viewerIdentity() {
  const userId = $('viewer-select').value;
  return { userId, userName: viewers[userId] || 'Demo viewer' };
}

function renderFields() {
  const action = ACTIONS[$('action-kind').value];
  const container = $('action-fields');
  container.replaceChildren();
  $('gate-note').hidden = !action?.gated;
  if (!action) return;
  for (const field of action.fields) {
    const wrapper = element('div', `field${field.type === 'checkbox' ? ' checkbox-field' : ''}`);
    const label = element('label', '', field.label);
    label.htmlFor = `param-${field.name}`;
    const input = element(field.type === 'list' ? 'textarea' : 'input');
    input.id = `param-${field.name}`;
    input.name = field.name;
    if (field.type !== 'list') input.type = field.type || 'text';
    input.required = field.type !== 'checkbox';
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.maxLength) input.maxLength = field.maxLength;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.type === 'number') input.step = '1';
    if (field.value !== undefined) input.value = field.value;
    if (field.numericId) { input.inputMode = 'numeric'; input.pattern = '[0-9]+'; }
    if (field.type === 'list') { input.rows = 3; input.maxLength = (field.itemLength + 1) * field.maxItems; }
    input.addEventListener('input', () => input.setCustomValidity(''));
    if (field.type === 'checkbox') { label.prepend(input); wrapper.append(label); } else wrapper.append(label, input);
    if (field.hint) {
      const hint = element('p', 'field-hint', field.hint);
      hint.id = `${input.id}-hint`;
      input.setAttribute('aria-describedby', hint.id);
      wrapper.append(hint);
    }
    container.append(wrapper);
  }
  if (action.note) container.append(element('p', 'field-hint', action.note));
}

function refreshActions() {
  const available = (state.availableActions || []).filter((kind) => ACTIONS[kind]);
  const fingerprint = available.join('|');
  if (fingerprint === actionFingerprint) return;
  actionFingerprint = fingerprint;
  const select = $('action-kind');
  const previous = select.value;
  select.replaceChildren();
  if (!available.length) {
    const option = element('option', '', 'No actions available');
    option.value = '';
    select.append(option);
  }
  for (const kind of available) {
    const option = element('option', '', ACTIONS[kind].label);
    option.value = kind;
    select.append(option);
  }
  if (available.includes(previous)) select.value = previous;
  renderFields();
}

function renderConnection() {
  const demo = state.mode === 'demo';
  const connected = state.connected && transportConnected;
  $('mode-tag').textContent = demo ? 'DEMO MODE' : connected ? 'LIVE MODE' : 'LIVE · OFFLINE';
  $('mode-tag').className = `mode-tag ${demo ? 'demo' : connected ? 'live' : ''}`;
  $('mode-banner').className = `mode-banner${demo ? ' demo' : state.connection === 'error' ? ' error' : ''}`;
  $('mode-banner').textContent = demo ? 'DEMO SESSION / All viewers and channel actions are simulated. No Twitch channel is changed.' : connected ? 'LIVE SESSION / Actions operate your connected Twitch channel. Confirmed results are recorded below.' : `LIVE SESSION / ${state.message || 'Connect your Twitch account to bring your audience into the control room.'}`;
  $('connection-status').textContent = demo ? 'Local demo' : connected ? 'Twitch connected' : state.connection === 'connecting' ? 'Connecting to Twitch' : state.connection === 'error' ? 'Connection needs attention' : 'Twitch disconnected';
  $('connection-dot').className = `status-dot ${demo ? 'demo' : connected ? 'connected' : state.connection === 'error' ? 'error' : ''}`;
  $('channel-name').textContent = state.broadcaster?.name || state.broadcaster?.login || (demo ? 'Your demo channel' : 'Your channel goes here.');
  $('channel-title').textContent = state.channel?.title || (demo ? 'A rehearsal space for your next great stream.' : 'Connect Twitch to see your current stream title.');
  $('channel-category').textContent = state.channel?.categoryId ? `CATEGORY ${state.channel.categoryId}` : demo ? 'SIMULATED CHANNEL' : 'TWITCH CONNECTION';
  $('connect-link').hidden = demo || connected;
  $('demo-viewer').hidden = !demo;
  $('composer-role').textContent = demo ? 'SIMULATED VIEWER' : 'STREAMER';
  $('chat-help').textContent = demo ? 'The controls above simulate your audience. In live mode, viewers use these commands in Twitch chat.' : 'Viewers can submit proposals and cast votes from your Twitch chat. Include the current round ID.';
}

function renderProposals() {
  const round = state.round;
  const container = $('proposal-list');
  const focusedId = document.activeElement?.id;
  container.replaceChildren();
  if (!round?.proposals?.length) {
    const empty = element('div', 'empty-state');
    const symbol = element('span', 'empty-icon', '↗');
    symbol.setAttribute('aria-hidden', 'true');
    empty.append(symbol, element('p', '', round?.state === 'collecting' ? 'Make the opening move.' : 'The next move starts here.'), element('span', '', round?.state === 'collecting' ? 'Submit a proposal. Your audience’s ideas will appear here.' : 'Proposals will appear here when a round opens.'));
    container.append(empty);
    return;
  }
  round.proposals.forEach((proposal, index) => {
    const card = element('article', `proposal-card${proposal.id === round.winnerId ? ' winner' : ''}`);
    const number = element('span', 'proposal-number', String(index + 1).padStart(2, '0'));
    const copy = element('div', 'proposal-copy');
    const action = ACTIONS[proposal.action.kind];
    copy.append(element('p', 'proposal-type', `${action?.short || 'Action'}${action?.gated ? ' · approval required' : ''}`), element('p', 'proposal-title', describeAction(proposal.action)), element('p', 'proposal-by', `by ${proposal.proposedBy.userName} · ${proposal.id}`));
    const votes = element('div', 'proposal-votes');
    votes.append(element('span', 'vote-count', proposal.votes), element('span', 'vote-caption', Number(proposal.votes) === 1 ? 'vote' : 'votes'));
    if (state.mode === 'demo' && round.state === 'collecting') {
      const vote = element('button', 'vote-button', '+ Vote');
      vote.type = 'button';
      vote.id = `vote-${proposal.id}`;
      vote.disabled = pending || !controlToken || !transportConnected;
      vote.setAttribute('aria-label', `Vote as ${viewerIdentity().userName} for ${describeAction(proposal.action)}`);
      vote.addEventListener('click', () => control('/control/votes', { roundId: round.id, proposalId: proposal.id, ...viewerIdentity() }, `Vote submitted for ${proposal.id}. Repeat votes from the same viewer count once.`));
      votes.append(vote);
    }
    card.append(number, copy, votes);
    if (action?.gated && round.winnerId === proposal.id && round.state === 'resolving') {
      const approve = element('button', 'button button-secondary approval-button', `Approve ${action.short.toLowerCase()} & execute`);
      approve.type = 'button';
      approve.id = `approve-${proposal.id}`;
      approve.disabled = pending || !controlToken || !transportConnected;
      approve.addEventListener('click', () => control('/control/approve', { roundId: round.id, proposalId: proposal.id }, 'Approval submitted. The result will appear only after verification.'));
      card.append(approve);
    }
    container.append(card);
  });
  if (focusedId?.startsWith('vote-') || focusedId?.startsWith('approve-')) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

function renderLog() {
  const entries = [...(state.log || [])].sort((a, b) => b.at - a.at).slice(0, 25);
  const container = $('activity-list');
  $('log-status').textContent = entries.length ? `${state.mode === 'demo' ? 'SIMULATED SESSION · ' : ''}${entries.length} ${entries.length === 1 ? 'ENTRY' : 'ENTRIES'}` : 'WAITING FOR THE FIRST TAKE';
  container.replaceChildren();
  if (!entries.length) {
    const empty = element('li', 'log-empty');
    const symbol = element('span', '', '✳');
    symbol.setAttribute('aria-hidden', 'true');
    const copy = element('div');
    copy.append(element('p', '', 'A record of what actually happened.'), element('span', '', 'Verified actions, failed attempts, and cuts appear here with clear status.'));
    empty.append(symbol, copy);
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const status = ['confirmed', 'failed', 'vetoed'].includes(entry.status) ? entry.status : 'info';
    const row = element('li', `log-entry ${status}`);
    const icon = element('span', 'log-icon', { confirmed: '✓', failed: '×', vetoed: '■', info: '·' }[status]);
    icon.setAttribute('aria-hidden', 'true');
    const date = new Date(entry.at);
    const time = element('time', 'log-time', Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
    if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
    const message = element('p', 'log-message', entry.message);
    if (entry.actor) message.append(element('span', 'log-actor', `Directed by ${entry.actor}`));
    const url = safeUrl(entry.url);
    if (url && status === 'confirmed') {
      const link = element('a', 'log-link', 'Open result ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      message.append(link);
    }
    row.append(icon, time, message, element('span', 'log-status', status === 'confirmed' && state.mode === 'demo' ? 'SIMULATED' : status.toUpperCase()));
    container.append(row);
  }
}

function renderControls() {
  const round = state?.round;
  const controlsReady = Boolean(state && controlToken && transportConnected && !pending);
  const ready = controlsReady && (state.mode === 'demo' || state.connected);
  const collecting = round?.state === 'collecting';
  const active = round && ['collecting', 'resolving', 'executing'].includes(round.state);
  const reverting = round?.state === 'vetoed' && ['reverting', 'request_pending', 'awaiting_confirmation'].includes(round.executionPhase);
  $('open-round').disabled = !ready || Boolean(active) || Boolean(reverting);
  $('open-round').textContent = pending ? 'Working…' : round ? 'Open next round ↗' : 'Open the floor ↗';
  $('close-round').hidden = !collecting;
  $('close-round').disabled = !ready || !collecting;
  $('veto-round').disabled = !controlsReady || (!active && !round?.canUndo) || Boolean(reverting);
  $('veto-round').textContent = round?.canUndo && !active ? 'Undo last action' : 'Call cut';
  $('proposal-fieldset').disabled = !ready || !collecting || !ACTIONS[$('action-kind').value];
  $('settings-fieldset').disabled = !state || !controlToken || !transportConnected || pending;
  $('viewer-select').disabled = pending;
  $('composer-hint').textContent = !state ? 'Connecting to the service.' : !transportConnected ? 'Connection interrupted. Controls will return when the service reconnects.' : !collecting ? 'Open a round to submit a proposal.' : !(state.availableActions || []).length ? 'No actions are available for this connection.' : state.mode === 'demo' ? 'Demo proposals and votes never change a Twitch channel.' : 'This proposal is credited to you. Viewers participate through Twitch chat.';
  document.querySelectorAll('.vote-button, .approval-button').forEach((button) => { button.disabled = !ready; });
}

function updateTimer() {
  const clock = countdown(state?.round, Date.now() + serverOffset);
  $('timer-value').textContent = clock.text;
  $('round-progress').style.width = `${clock.percent}%`;
  $('timer').setAttribute('aria-label', clock.text === '—' ? 'No voting countdown' : `${Number(clock.text)} seconds remaining`);
}

function render() {
  renderConnection();
  refreshActions();
  const round = state.round;
  const phase = getPhase(round);
  $('phase-tag').textContent = phase.label.toUpperCase();
  $('phase-tag').className = `phase-tag ${round?.state || ''}`;
  $('round-heading').textContent = phase.title;
  $('round-description').textContent = phase.description;
  $('round-reference').textContent = round ? `ROUND ${round.id}` : 'NO ACTIVE ROUND';
  $('quorum-label').textContent = `${round?.quorum ?? state.settings?.quorum ?? '—'} DISTINCT VOTES TO PASS`;
  $('round-footnote').textContent = round?.error || (round?.state === 'confirmed' && !round.canUndo ? 'This action has no automatic undo. The director can stop upcoming rounds.' : 'Only a confirmed result appears as confirmed in the Director’s Log.');
  const roundId = round?.id || '<round-id>';
  $('chat-command').textContent = `!propose ${roundId} title Your next stream title`;
  $('vote-command').textContent = `!vote ${roundId} ${round?.proposals?.[0]?.id || '<proposal-id>'}`;
  if (!settingsDirty && state.settings) {
    $('quorum').value = state.settings.quorum;
    $('round-window').value = state.settings.roundWindowMs / 1000;
    $('cooldown').value = state.settings.cooldownMs / 1000;
  }
  renderProposals();
  renderLog();
  renderControls();
  updateTimer();
  const nextAnnouncement = `${round?.id}:${round?.state}:${round?.executionPhase}:${round?.awaitingApproval}`;
  if (nextAnnouncement !== announcementKey) {
    announcementKey = nextAnnouncement;
    $('live-announcement').textContent = `${phase.title} ${phase.description}`;
  }
}

$('action-kind').addEventListener('change', renderFields);
$('viewer-select').addEventListener('change', () => { if (state) renderProposals(); });
$('open-round').addEventListener('click', () => control('/control/rounds/open', {}, 'Round opened. The floor is yours.'));
$('close-round').addEventListener('click', () => { if (state?.round) control('/control/rounds/close', { roundId: state.round.id }, 'Voting closed. Waiting for the decision engine.'); });
$('veto-round').addEventListener('click', () => { if (state?.round) control('/control/veto', { roundId: state.round.id }, 'Cut requested. Any undo must be verified before it is marked complete.'); });
$('settings-form').addEventListener('input', () => { settingsDirty = true; });
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  control('/control/settings', { quorum: Number($('quorum').value), roundWindowMs: Number($('round-window').value) * 1000, cooldownMs: Number($('cooldown').value) * 1000 }, 'Rules saved for future rounds.');
});
$('proposal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const kind = $('action-kind').value;
  const definition = ACTIONS[kind];
  if (!definition || !state?.round || state.round.state !== 'collecting') return;
  const params = {};
  for (const field of definition.fields) {
    const input = $(`param-${field.name}`);
    input.setCustomValidity('');
    if (field.type === 'checkbox') params[field.name] = input.checked;
    else if (field.type === 'number') params[field.name] = Number(input.value);
    else if (field.type === 'list') {
      params[field.name] = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
      if (params[field.name].length < field.minItems || params[field.name].length > field.maxItems || params[field.name].some((value) => value.length > field.itemLength)) input.setCustomValidity(`Enter ${field.minItems}–${field.maxItems} options, one per line, with at most ${field.itemLength} characters each.`);
    } else {
      params[field.name] = input.value.trim();
      if (!params[field.name]) input.setCustomValidity('Enter a value for this field.');
    }
  }
  if (!event.currentTarget.reportValidity()) return;
  control('/control/proposals', { roundId: state.round.id, action: { kind, params }, ...(state.mode === 'demo' ? viewerIdentity() : {}) }, 'Proposal submitted to the room.');
});

refreshState().catch((error) => showNotice(error.message, true));
connectEvents(acceptState, (connected) => {
  const changed = transportConnected !== connected;
  transportConnected = connected;
  $('transport-dot').className = `status-dot ${connected ? 'connected' : 'error'}`;
  $('transport-status').textContent = connected ? 'Local service connected' : 'Connection interrupted · retrying';
  if (changed && state) { renderConnection(); renderControls(); }
  if (connected && !controlToken) refreshState().catch((error) => showNotice(error.message, true));
});
setInterval(updateTimer, 250);
