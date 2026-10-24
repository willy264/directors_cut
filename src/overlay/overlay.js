import { ACTIONS, element, describeAction, getPhase, countdown, connectEvents } from './shared.js';

const $ = (id) => document.getElementById(id);
let state = null;
let serverOffset = 0;
let connected = false;

function updateClock() {
  const clock = countdown(state?.round, Date.now() + serverOffset);
  $('overlay-timer').textContent = clock.text;
  $('overlay-progress').style.width = `${clock.percent}%`;
}

function renderWarning() {
  const warning = $('overlay-warning');
  warning.hidden = connected && state?.mode === 'live' && state.connected;
  warning.textContent = !connected ? 'CONTROL ROOM DISCONNECTED · RECONNECTING' : state?.mode === 'demo' ? 'DEMO · SIMULATED VIEWERS AND CHANNEL ACTIONS' : 'TWITCH DISCONNECTED · WAITING FOR THE DIRECTOR';
}

function render(next) {
  if (state && next.serverTime < state.serverTime) return;
  state = next;
  serverOffset = state.serverTime - Date.now();
  const demo = state.mode === 'demo';
  $('overlay-mode').textContent = demo ? 'DEMO' : state.connected ? 'LIVE' : 'OFFLINE';
  $('overlay-mode').className = `mode-tag ${demo ? 'demo' : state.connected ? 'live' : ''}`;
  const round = state.round;
  const phase = getPhase(round);
  $('overlay-phase').textContent = phase.label.toUpperCase();
  $('overlay-heading').textContent = round ? phase.title : 'Chat takes the controls.';
  $('overlay-round-id').textContent = round ? `ROUND ${round.id}` : 'NEXT ROUND SOON';
  $('overlay-quorum').textContent = round ? `${round.quorum} DISTINCT VOTES TO PASS` : 'PROPOSE · VOTE · DIRECT';
  $('overlay-instruction').textContent = round?.state === 'collecting' ? `Vote in chat: !vote ${round.id} <proposal-id>` : round ? phase.description : 'The director will open the floor soon.';
  const list = $('overlay-proposals');
  list.replaceChildren();
  // Keep the broadcast readable: show the five leading proposals, with stable tie order.
  const proposals = [...(round?.proposals || [])].sort((a, b) => b.votes - a.votes || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 5);
  proposals.forEach((proposal, index) => {
    const row = element('li', `broadcast-proposal${proposal.id === round.winnerId ? ' winner' : ''}`);
    const copy = element('div');
    copy.append(element('p', 'proposal-type', ACTIONS[proposal.action.kind]?.short || 'Channel action'), element('p', 'proposal-title', describeAction(proposal.action)), element('p', 'proposal-by', `${proposal.proposedBy.userName} · ${proposal.id}`));
    const votes = element('div', 'proposal-votes');
    votes.append(element('span', 'vote-count', proposal.votes), element('span', 'vote-caption', Number(proposal.votes) === 1 ? 'vote' : 'votes'));
    row.append(element('span', 'proposal-number', String(index + 1).padStart(2, '0')), copy, votes);
    list.append(row);
  });
  const confirmed = [...(state.log || [])].filter((entry) => entry.status === 'confirmed').sort((a, b) => b.at - a.at)[0];
  $('result-label').textContent = demo ? 'LAST SIMULATED RESULT' : 'LAST VERIFIED ACTION';
  $('overlay-result').textContent = confirmed?.message || 'Waiting for the first verified action.';
  $('overlay-credit').textContent = confirmed ? `${confirmed.actor ? `Directed by ${confirmed.actor}` : 'Confirmed by the service'}${demo ? ' · simulation' : ''}` : 'Your next great idea could make the cut.';
  renderWarning();
  updateClock();
}

connectEvents(render, (value) => { connected = value; renderWarning(); });
setInterval(updateClock, 250);
