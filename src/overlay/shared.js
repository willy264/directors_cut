export const ACTIONS = {
  set_title: { label: 'Change the title', short: 'Channel title', fields: [{ name: 'title', label: 'New stream title', placeholder: 'One more run. Chat is in charge.', maxLength: 140 }] },
  set_category: { label: 'Switch category', short: 'Category', fields: [{ name: 'categoryId', label: 'Twitch category ID', placeholder: '509658', numericId: true, hint: 'Use a real Twitch category ID. The service verifies it before execution.' }] },
  create_poll: { label: 'Start a poll', short: 'Poll', fields: [{ name: 'title', label: 'Question', placeholder: 'What should we do next?', maxLength: 60 }, { name: 'choices', label: 'Choices', type: 'list', placeholder: 'One more attempt\nSwitch it up', minItems: 2, maxItems: 5, itemLength: 25, hint: '2–5 choices, one per line. Up to 25 characters each.' }, { name: 'durationSeconds', label: 'Voting time (seconds)', type: 'number', min: 15, max: 1800, value: 60 }] },
  create_prediction: { label: 'Open a prediction', short: 'Prediction', fields: [{ name: 'title', label: 'Prediction title', placeholder: 'Will we finish this run?', maxLength: 45 }, { name: 'outcomes', label: 'Outcomes', type: 'list', placeholder: 'We have this\nNext time', minItems: 2, maxItems: 10, itemLength: 25, hint: '2–10 outcomes, one per line. Up to 25 characters each.' }, { name: 'predictionWindowSeconds', label: 'Prediction window (seconds)', type: 'number', min: 30, max: 1800, value: 60 }] },
  create_clip: { label: 'Clip this moment', short: 'Clip', fields: [], note: 'Twitch processes the clip before its verified link appears in the log.' },
  create_marker: { label: 'Leave a stream marker', short: 'Stream marker', fields: [{ name: 'description', label: 'Marker description', placeholder: 'The moment chat called it', maxLength: 140 }] },
  shoutout: { label: 'Give a shoutout', short: 'Shoutout', fields: [{ name: 'toBroadcasterId', label: 'Recipient’s Twitch user ID', placeholder: '12345678', numericId: true, hint: 'Use the numeric Twitch user ID, not their channel name.' }] },
  snooze_ad: { label: 'Snooze the next ad', short: 'Ad snooze', fields: [], note: 'Uses one available ad snooze. Availability is checked before the action runs.' },
  resolve_prediction: { label: 'Resolve a prediction · approval required', short: 'Resolve prediction', gated: true, fields: [{ name: 'predictionId', label: 'Active prediction ID', placeholder: 'Prediction ID' }, { name: 'winningOutcomeId', label: 'Winning outcome ID', placeholder: 'Outcome ID' }] },
  raid: { label: 'Start a raid · approval required', short: 'Raid', gated: true, fields: [{ name: 'toBroadcasterId', label: 'Destination’s Twitch user ID', placeholder: '12345678', numericId: true, hint: 'Use the numeric Twitch user ID, not their channel name.' }] },
};

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function describeAction(action) {
  const params = action?.params ?? {};
  switch (action?.kind) {
    case 'set_title': return params.title;
    case 'set_category': return `Switch to category ${params.categoryId}`;
    case 'create_poll': return params.title;
    case 'create_prediction': return params.title;
    case 'create_clip': return 'Save this moment as a clip';
    case 'create_marker': return params.description;
    case 'shoutout': return `Give channel ${params.toBroadcasterId} a shoutout`;
    case 'snooze_ad': return 'Give the next ad break a little more time';
    case 'resolve_prediction': return `Resolve prediction ${params.predictionId}`;
    case 'raid': return `Raid channel ${params.toBroadcasterId}`;
    default: return 'Channel action';
  }
}

export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, window.location.origin);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function getPhase(round) {
  if (!round) return { label: 'Standby', title: 'Ready when you are.', description: 'Open a round and let your audience make a proposal.' };
  if (round.state === 'collecting') return { label: 'Voting open', title: 'The floor is yours.', description: 'One vote per viewer, per proposal. The strongest idea takes the next cut.' };
  if (round.state === 'resolving') return { label: round.awaitingApproval ? 'Approval needed' : 'Resolving', title: round.awaitingApproval ? 'Your call, director.' : 'The votes are in.', description: round.awaitingApproval ? 'The winning action needs your approval before it can run.' : 'The decision engine is checking the winning proposal.' };
  if (round.state === 'executing') return { label: 'Verifying', title: 'Making the next move.', description: round.executionPhase === 'snapshot_pending' ? 'Saving the channel’s current state before making a change.' : 'Waiting for the service to verify the result.' };
  if (round.state === 'confirmed') return { label: 'Confirmed', title: 'That made the cut.', description: 'The action was verified. Its result is recorded below.' };
  if (round.state === 'vetoed') return { label: 'Cut called', title: 'The director called cut.', description: ['reverting', 'request_pending', 'awaiting_confirmation'].includes(round.executionPhase) ? 'Undo is in progress. Waiting for the restored state to be verified.' : round.executionPhase === 'reverted' ? 'The previous channel state was restored and verified.' : 'Voting stopped. See the log for the outcome of any action already in progress.' };
  return { label: 'Failed', title: 'This take didn’t land.', description: round.error || 'The action could not be confirmed. Check the log before opening the next round.' };
}

export function countdown(round, now) {
  if (!round || round.state !== 'collecting') return { text: '—', percent: 0 };
  const remaining = Math.max(0, round.closesAt - now);
  const duration = Math.max(1, round.closesAt - round.opensAt);
  return { text: String(Math.ceil(remaining / 1000)).padStart(2, '0'), percent: Math.min(100, Math.max(0, (remaining / duration) * 100)) };
}

export function connectEvents(onState, onConnection) {
  const source = new EventSource('/events');
  source.addEventListener('open', () => onConnection(true));
  source.addEventListener('state', (event) => {
    try {
      const state = JSON.parse(event.data);
      if (!state || !['demo', 'live'].includes(state.mode) || !Number.isFinite(state.serverTime)) throw new Error('Invalid state');
      onState(state);
      onConnection(true);
    } catch {
      onConnection(false);
    }
  });
  source.addEventListener('error', () => onConnection(false));
  window.addEventListener('pagehide', () => source.close(), { once: true });
  return source;
}
