import { ApiClient } from '@/api/client';
import { getConfig, setConfig } from '@/common/config';
import type {
  BackgroundToContent,
  BackgroundToPopup,
  ContentToBackground,
  PopupState,
  PopupToBackground,
} from '@/common/messages';
import { AuthStore } from '@/storage/auth-store';
import { EventStore } from '@/storage/event-store';
import { createDriver } from '@/storage/local';
import { SessionStore } from '@/storage/session-store';
import { createLogger } from '@/utils/logger';
import { uuid } from '@/utils/ids';
import { buildSessionPayload } from './payload-builder';
import { Uploader } from './uploader';

/**
 * Dev-only override: set to `true` to run with no backend at all (offline demo / a
 * backend that is not currently running). Real usage always talks to the configured
 * backend, requires operator sign-in, and starts sessions under the signed-in operator's
 * identity and a candidate email typed into the popup — there is no fake local identity.
 */
const NO_BACKEND_MODE = false;

/**
 * MV3 background service worker.
 *
 * It is the single writer for durable state: content scripts send events and snapshots,
 * the popup issues commands, and everything is reconciled here. The worker can be
 * terminated at any moment, so no state lives only in memory — alarms restart the
 * upload loop and the queue is always read back from storage.
 */

const log = createLogger('sw');

const CONFIG_KEY = 'aav.config';

const configDriver = createDriver('local');
const secureDriver = createDriver('session');

const sessions = new SessionStore(createDriver('local'), secureDriver);
const events = new EventStore(createDriver('local'));
const auth = new AuthStore(createDriver('local'));
const api = new ApiClient(undefined, auth);
const uploader = new Uploader(api, events, sessions);

async function getAuth() {
  return auth.get();
}

async function setAuth(state: { token: string; role: string; email: string; name: string }) {
  await auth.set(state);
}

async function clearAuth() {
  await auth.clear();
}

const ALARM_UPLOAD = 'aav.upload';
const ALARM_TIMEOUT = 'aav.timeout';

/** Loads a deployment config override, if one was provisioned via managed storage. */
async function loadConfig(): Promise<void> {
  const override = await configDriver.get<Record<string, unknown>>(CONFIG_KEY);
  if (override) setConfig(override as never);
}

async function ensureAlarms(): Promise<void> {
  const cfg = getConfig();
  await chrome.alarms.create(ALARM_UPLOAD, { periodInMinutes: cfg.buffering.upload_interval_minutes });
  await chrome.alarms.create(ALARM_TIMEOUT, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await loadConfig();
    await ensureAlarms();
    log.info('installed');
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await loadConfig();
    await ensureAlarms();
    // Anything left in the queue from the previous run goes out now.
    await uploader.drain();
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    await loadConfig();
    if (alarm.name === ALARM_UPLOAD) {
      await uploader.drain();
      return;
    }
    if (alarm.name === ALARM_TIMEOUT) {
      if (await sessions.isTimedOut()) {
        log.info('session timed out');
        await sessions.end('timed_out');
        await broadcastToTabs({ type: 'SESSION_PAUSED', session_id: (await sessions.get())?.session_id ?? '' });
        await uploader.finalize();
      }
    }
  })();
});

// ---- content-script messages ---------------------------------------------

async function handleContentMessage(
  message: ContentToBackground,
  sender: chrome.runtime.MessageSender,
): Promise<BackgroundToContent | { ok: boolean } | undefined> {
  switch (message.type) {
    case 'REQUEST_CONTEXT': {
      const override = await configDriver.get<Record<string, unknown>>(CONFIG_KEY);
      const session = await sessions.get();
      if (!session) return { type: 'CONTEXT', session: null, candidate: null, config_override: override };

      // Domain is not the trust boundary here — a portal routinely redirects the actual
      // apply step to the employer's own ATS on an entirely different domain, and that
      // has to keep being tracked. The tab (or a tab opened from it) does the job
      // instead: an operator working an application stays in that tab/its children;
      // switching to unrelated browsing means a different, unrelated tab.
      const tabId = sender.tab?.id;
      const openerTabId = sender.tab?.openerTabId;
      if (tabId !== undefined) {
        const allowedTabs = await sessions.getAllowedTabs();
        const isKnownTab = allowedTabs.includes(tabId);
        const isChildOfKnownTab = openerTabId !== undefined && allowedTabs.includes(openerTabId);
        // Bootstrap fallback only — START_SESSION already seeds the active tab, so this
        // should rarely be what actually grants access; kept in case that seeding failed
        // (e.g. chrome.tabs.query threw) so a session doesn't end up unusable.
        const isFirstEverRequest = allowedTabs.length === 0;

        if (!isFirstEverRequest && !isKnownTab && !isChildOfKnownTab) {
          log.warn('context requested from a tab outside this session\'s tracked tabs; refusing', {
            tab_id: tabId,
            opener_tab_id: openerTabId ?? null,
            allowed_tabs: allowedTabs,
          });
          return { type: 'CONTEXT', session: null, candidate: null, config_override: override };
        }
        if (!isKnownTab) log.info('tab added to this session\'s tracked set', { tab_id: tabId, via: isFirstEverRequest ? 'bootstrap' : 'opener' });
        await sessions.allowTab(tabId);
      }

      if (!session.portal_domain) {
        // Recorded for reporting only now — not an access gate.
        const { hostname } = new URL(message.url);
        await sessions.setPortalContext(hostname);
      }

      const candidate = await sessions.getCandidate();
      return { type: 'CONTEXT', session, candidate, config_override: override };
    }

    case 'EVENT_BATCH': {
      const stored = await events.append(message.events);
      await sessions.touch();
      // Opportunistic upload once a full batch is available; the alarm covers the rest.
      if ((await events.size()) >= getConfig().api.max_batch_size) void uploader.drain(1);
      return { ok: stored >= 0 };
    }

    case 'FIELD_SNAPSHOT': {
      await sessions.upsertFields(message.fields);
      const first = message.fields
        .filter((f) => f.interaction.first_fill_at)
        .sort((a, b) => (a.interaction.fill_sequence_number ?? 0) - (b.interaction.fill_sequence_number ?? 0))[0];
      if (first?.interaction.first_fill_at) await sessions.markFirstFill(first.interaction.first_fill_at);
      return { ok: true };
    }

    case 'PAGE_SNAPSHOT': {
      await sessions.upsertPages(message.pages);
      // Opening the candidate record is inferred from the page type, then recorded once.
      if (message.pages.some((p) => p.page_type === 'candidate_record')) {
        const first = message.pages.filter((p) => p.page_type === 'candidate_record')[0];
        if (first) await sessions.markCandidateRecordOpened(first.first_seen_at);
      }
      return { ok: true };
    }

    case 'SUBMISSION_UPDATE': {
      await sessions.setSubmission(message.assessment);
      return { ok: true };
    }

    case 'CONTENT_READY': {
      // Now that the content script has picked an adapter, record what actually matched.
      const { hostname } = new URL(message.url);
      await sessions.setPortalContext(
        hostname,
        message.adapter_name,
        message.adapter_kind === 'known' ? 'known' : 'unknown',
      );
      return { ok: true };
    }

    default:
      return undefined;
  }
}

// ---- popup messages -------------------------------------------------------

async function buildPopupState(): Promise<PopupState> {
  const [session, candidate, submission, fields, queued, authState] = await Promise.all([
    sessions.get(),
    sessions.getCandidate(),
    sessions.getSubmission(),
    sessions.getFields(),
    events.size(),
    getAuth(),
  ]);
  const uploadState = uploader.getState();
  const allEvents = session ? await events.allForSession(session.session_id) : [];

  return {
    session,
    candidate,
    submission: session ? submission : null,
    field_count: fields.length,
    filled_count: fields.filter((f) => f.state !== 'empty').length,
    event_count: allEvents.length,
    queued_events: queued,
    last_upload_at: uploadState.last_upload_at,
    last_upload_error: uploadState.last_error,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    auth: authState ? { email: authState.email, name: authState.name, role: authState.role } : null,
  };
}

async function handlePopupMessage(message: PopupToBackground): Promise<BackgroundToPopup> {
  switch (message.type) {
    case 'GET_STATE':
      return { type: 'STATE', state: await buildPopupState() };

    case 'START_SESSION': {
      const candidateEmail = message.candidate_email?.trim();
      if (!candidateEmail) {
        return { type: 'ERROR', message: 'A candidate email is required to start a session.' };
      }

      const authState = await getAuth();
      if (!NO_BACKEND_MODE && !authState) {
        return { type: 'ERROR', message: 'Please log in before starting a session.' };
      }
      const operatorId = authState?.email ?? 'local-dev';

      const started = NO_BACKEND_MODE
        ? { ok: true, data: { session_id: uuid(), candidate_id: uuid(), email: candidateEmail } }
        : await api.startSession(candidateEmail, operatorId, message.client_id ?? null);
      if (!started.ok || !started.data) {
        return { type: 'ERROR', message: 'Could not start a session.' };
      }

      const existing = await sessions.get();
      if (existing && existing.state !== 'ended') {
        // Finish the previous session cleanly rather than losing its evidence.
        await sessions.end('operator_ended');
        await uploader.finalize();
      }
      await events.clear();
      const session = await sessions.start({
        session_id: started.data.session_id,
        candidate_id: started.data.candidate_id,
        candidate_email: started.data.email,
        operator_id: operatorId,
      });
      if (NO_BACKEND_MODE) {
        await sessions.setCandidate(null);
        log.info('NO_BACKEND_MODE: skipped fetchCandidate; matching will report not_available');
      } else {
        const candidate = await api.fetchCandidate(session.session_id);
        await sessions.setCandidate(candidate.ok ? candidate.data : null);
        if (!candidate.ok) log.warn('candidate record unavailable; matching will report not_available');
      }

      // Seed the tab lock with the tab the operator is actually looking at *right now*,
      // rather than passively waiting to see which tab's content script asks for context
      // first. "Whoever asks first" is racy — any other tab that happens to (re)load at
      // the wrong moment could steal that slot and leave the real tab refused.
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id !== undefined) {
          await sessions.allowTab(activeTab.id);
          log.info('session seeded on the active tab', activeTab.id);
        }
      } catch (err) {
        log.warn('could not determine the active tab to seed the session on', err);
      }

      await ensureAlarms();
      await broadcastToTabs({ type: 'SESSION_RESUMED', session_id: session.session_id });
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'MARK_CANDIDATE_RECORD_OPENED':
      await sessions.markCandidateRecordOpened();
      return { type: 'STATE', state: await buildPopupState() };

    case 'PAUSE_SESSION': {
      await sessions.pause();
      const s = await sessions.get();
      await broadcastToTabs({ type: 'SESSION_PAUSED', session_id: s?.session_id ?? '' });
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'RESUME_SESSION': {
      await sessions.resume();
      const s = await sessions.get();
      await broadcastToTabs({ type: 'SESSION_RESUMED', session_id: s?.session_id ?? '' });
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'END_SESSION': {
      await broadcastToTabs({ type: 'FLUSH_NOW' });
      // Give content scripts a moment to flush their in-page buffers.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const ended = await sessions.end(message.reason === 'abandoned' ? 'abandoned' : 'operator_ended');
      // Tell every tracked tab's Observer to actually stop: unlike PAUSE_SESSION and the
      // idle-timeout path (both already broadcast this), END_SESSION never told content
      // scripts the session was over — so `stop()` (and with it, hiding the on-page
      // capture indicator) never ran, and the indicator stayed visible after Stop.
      await broadcastToTabs({ type: 'SESSION_PAUSED', session_id: ended?.session_id ?? '' });
      const ok = await uploader.finalize();
      await sessions.setCandidate(null);
      if (!ok) log.warn('finalize could not be delivered; it will retry on the next alarm');
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'DISCARD_SESSION': {
      // The operator is declining this job right now, not finishing it — nothing about
      // this attempt should ever reach the backend. Unlike END_SESSION, this never calls
      // `uploader.finalize()` (which is what actually creates the visible session record
      // server-side): the session and any queued-but-not-yet-uploaded events are wiped
      // locally instead, and every tracked tab is told to stop immediately.
      const s = await sessions.get();
      await broadcastToTabs({ type: 'SESSION_PAUSED', session_id: s?.session_id ?? '' });
      await sessions.clear();
      await events.clear();
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'FLUSH_QUEUE':
      await uploader.drain();
      return { type: 'STATE', state: await buildPopupState() };

    case 'GET_PAYLOAD': {
      const payload = await buildSessionPayload(sessions, events, { partial: true });
      if (!payload) return { type: 'ERROR', message: 'no active session' };
      return { type: 'PAYLOAD', payload };
    }

    case 'LOGIN': {
      const result = await api.login(message.email, message.password);
      if (!result.ok || !result.data) {
        return { type: 'ERROR', message: result.error ?? 'Login failed.' };
      }
      await setAuth(result.data);
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'LOGOUT': {
      await clearAuth();
      return { type: 'STATE', state: await buildPopupState() };
    }

    case 'LIST_CLIENTS': {
      const result = await api.listClients();
      if (!result.ok || !result.data) {
        return { type: 'ERROR', message: result.error ?? 'Could not load clients.' };
      }
      return {
        type: 'CLIENTS',
        items: result.data.items.map((c) => ({ id: c.id, name: c.name, email: c.contact_email })),
      };
    }

    default:
      return { type: 'ERROR', message: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((message: ContentToBackground | PopupToBackground, sender, sendResponse) => {
  void (async () => {
    try {
      await loadConfig();
      const isPopup = [
        'GET_STATE',
        'START_SESSION',
        'END_SESSION',
        'DISCARD_SESSION',
        'PAUSE_SESSION',
        'RESUME_SESSION',
        'FLUSH_QUEUE',
        'GET_PAYLOAD',
        'MARK_CANDIDATE_RECORD_OPENED',
        'LOGIN',
        'LOGOUT',
        'LIST_CLIENTS',
      ].includes(message.type);
      const response = isPopup
        ? await handlePopupMessage(message as PopupToBackground)
        : await handleContentMessage(message as ContentToBackground, sender);
      sendResponse(response);
    } catch (err) {
      log.error('message handling failed', err);
      sendResponse({ type: 'ERROR', message: err instanceof Error ? err.message : 'unknown error' });
    }
  })();
  return true; // response is async
});

/** Sends a message to every tab running a content script, ignoring tabs without one. */
async function broadcastToTabs(message: BackgroundToContent): Promise<void> {
  if (!chrome.tabs?.query) return;
  try {
    const origins = getConfig().allowed_origins.map((o) => `${o}/*`);
    const tabs = await chrome.tabs.query({ url: origins.length ? origins : undefined });
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          /* no content script in that tab */
        }
      }),
    );
  } catch (err) {
    log.debug('broadcast failed', err);
  }
}

void loadConfig();
