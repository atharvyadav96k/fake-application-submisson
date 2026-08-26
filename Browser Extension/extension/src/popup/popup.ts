import type { BackgroundToPopup, PopupState, PopupToBackground } from '@/common/messages';

/**
 * Read-only evidence inspector.
 *
 * The popup never computes evidence itself — it renders exactly what the background
 * stored, including which items were counted toward the score, so the number shown is
 * always explainable.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function send(message: PopupToBackground): Promise<BackgroundToPopup> {
  let response: BackgroundToPopup | undefined;
  try {
    response = (await chrome.runtime.sendMessage(message)) as BackgroundToPopup | undefined;
  } catch (err) {
    response = undefined;
    void err;
  }
  // The background can resolve with nothing (service worker restarted mid-request,
  // popup closed and reopened, extension reloaded) — never let that crash the popup.
  if (!response) {
    return {
      type: 'ERROR',
      message: chrome.runtime.lastError?.message ?? 'Lost contact with the extension background — try again.',
    };
  }
  return response;
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/** Collapses the detailed submission state machine into the one thing this popup leads with. */
function submittedVerdict(state: PopupState['submission'] extends infer S ? S : never): { text: string; cls: string } {
  const submissionState = state?.state;
  if (submissionState === 'confirmed') return { text: 'Submitted (confirmed)', cls: 'yes' };
  if (submissionState === 'submitted') return { text: 'Submitted', cls: 'yes' };
  if (submissionState === 'click_without_submission') return { text: 'Not submitted', cls: 'no' };
  if (!submissionState || submissionState === 'unknown') return { text: 'Not submitted yet', cls: 'unknown' };
  return { text: 'Not submitted yet', cls: 'unknown' };
}

let clientsLoaded = false;
/** Client id -> email, so the operator only ever picks a client once — the candidate
 *  being tracked is that same person, using the email already captured at onboarding. */
let clientEmailById: Record<string, string> = {};

function render(state: PopupState): void {
  const session = state.session;
  const loginPanel = $('login-panel');
  const startPanel = $('start-panel');
  const sessionPanel = $('session-panel');
  const pill = $('status-pill');
  const logoutButton = $<HTMLButtonElement>('logout');

  logoutButton.hidden = !state.auth;

  if (!state.auth) {
    loginPanel.hidden = false;
    startPanel.hidden = true;
    sessionPanel.hidden = true;
    pill.textContent = 'logged out';
    pill.className = 'pill pill--idle';
    return;
  }

  loginPanel.hidden = true;
  setText('auth-whoami', `Signed in as ${state.auth.name || state.auth.email} (${state.auth.role})`);

  if (!clientsLoaded) {
    clientsLoaded = true;
    void loadClients();
  }

  if (!session || session.state === 'ended') {
    startPanel.hidden = false;
    sessionPanel.hidden = true;
    pill.textContent = session ? `ended · ${session.outcome}` : 'idle';
    pill.className = `pill pill--${session ? 'ended' : 'idle'}`;
    return;
  }

  startPanel.hidden = true;
  sessionPanel.hidden = false;
  pill.textContent = session.state;
  pill.className = `pill pill--${session.state}`;

  setText('session-portal', session.portal_domain || '—');
  setText('session-adapter', `${session.adapter_name} (${session.matched_adapter})`);

  const submission = state.submission;

  const verdict = submittedVerdict(submission);
  const verdictEl = $('submitted-verdict');
  verdictEl.textContent = verdict.text;
  verdictEl.className = `verdict verdict--${verdict.cls}`;

  const score = submission?.confidence_score ?? 0;
  $('score-fill').style.width = `${Math.round(score * 100)}%`;
  setText('score-value', score.toFixed(2));

  const stateEl = $('submission-state');
  stateEl.textContent = submission ? submission.state.replace(/_/g, ' ') : 'unknown';
  stateEl.className = `state state--${submission?.state ?? 'unknown'}`;

  const evidenceList = $('evidence');
  evidenceList.replaceChildren();
  const items = [...(submission?.evidence ?? []), ...(submission?.negative_evidence ?? [])];
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No submission signals observed yet.';
    evidenceList.append(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    if (item.weight < 0) li.classList.add('negative');
    if (!item.counted) li.classList.add('uncounted');
    const label = document.createElement('span');
    label.textContent = item.kind.replace(/_/g, ' ');
    label.title = item.detail;
    const weight = document.createElement('span');
    weight.className = 'mono';
    weight.textContent = item.weight.toFixed(2);
    li.append(label, weight);
    evidenceList.append(li);
  }

  const notesList = $('notes');
  notesList.replaceChildren();
  for (const note of submission?.notes ?? []) {
    const li = document.createElement('li');
    li.textContent = note;
    notesList.append(li);
  }
}

async function refresh(): Promise<void> {
  const response = await send({ type: 'GET_STATE' });
  if (response.type === 'STATE') render(response.state);
}

async function loadClients(): Promise<void> {
  const select = $<HTMLSelectElement>('client-select');
  const response = await send({ type: 'LIST_CLIENTS' });
  select.replaceChildren();
  if (response.type !== 'CLIENTS') {
    clientsLoaded = false; // allow a retry on the next render
    return;
  }
  clientEmailById = {};
  for (const client of response.items) {
    clientEmailById[client.id] = client.email;
    const option = document.createElement('option');
    option.value = client.id;
    // The operator picks a client by the email they recognize, not an internal name.
    option.textContent = client.email || client.name;
    select.append(option);
  }
}


function bind(): void {
  $('login-submit').addEventListener('click', async () => {
    setText('login-error', '');
    const email = $<HTMLInputElement>('login-email').value.trim();
    const password = $<HTMLInputElement>('login-password').value;
    if (!email || !password) {
      setText('login-error', 'Email and password are required.');
      return;
    }
    const response = await send({ type: 'LOGIN', email, password });
    if (response.type === 'STATE') {
      $<HTMLInputElement>('login-password').value = '';
      render(response.state);
    } else if (response.type === 'ERROR') {
      setText('login-error', response.message);
    }
  });

  $('logout').addEventListener('click', async () => {
    await send({ type: 'LOGOUT' });
    await refresh();
  });

  $('start').addEventListener('click', async () => {
    setText('start-error', '');
    const clientId = $<HTMLSelectElement>('client-select').value;
    const candidateEmail = clientId ? clientEmailById[clientId] : undefined;
    if (!clientId || !candidateEmail) {
      setText('start-error', 'Select a client first.');
      return;
    }
    const response = await send({
      type: 'START_SESSION',
      candidate_email: candidateEmail,
      client_id: clientId,
    });
    if (response.type === 'STATE') render(response.state);
    else if (response.type === 'ERROR') setText('start-error', response.message);
  });

  $('flush').addEventListener('click', async () => {
    await send({ type: 'FLUSH_QUEUE' });
    await refresh();
  });

  $('end').addEventListener('click', async () => {
    await send({ type: 'END_SESSION', reason: 'operator_ended' });
    await refresh();
  });

  $('discard').addEventListener('click', async () => {
    // Unlike "Mark as completed", this never finalizes or uploads anything.
    await send({ type: 'DISCARD_SESSION' });
    await refresh();
  });

  $('copy-payload').addEventListener('click', async () => {
    const response = await send({ type: 'GET_PAYLOAD' });
    if (response.type !== 'PAYLOAD') {
      setText('copy-status', 'No payload available.');
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(response.payload, null, 2));
    setText('copy-status', 'Payload copied to the clipboard.');
  });
}

bind();
void refresh();
setInterval(() => void refresh(), 2000);
