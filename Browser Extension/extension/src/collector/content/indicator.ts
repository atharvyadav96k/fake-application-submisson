/**
 * On-page indicator that activity capture is running.
 *
 * Transparency, not stealth: whoever is at the keyboard while a session is `active`
 * should be able to see, at a glance, that field metadata and submission signals are
 * being recorded. Rendered in closed shadow DOM so the portal's own styles and scripts
 * can neither see nor restyle it, and it carries no interactive controls of its own —
 * pausing/ending stays in the popup.
 */

const HOST_ID = '__aav_capture_indicator__';

export function showCaptureIndicator(doc: Document = document): void {
  if (doc.getElementById(HOST_ID)) return;

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'false');
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    zIndex: '2147483647',
    bottom: '16px',
    right: '16px',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(20, 22, 27, 0.92);
      color: #f2f4f7;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef6f6a;
      animation: pulse 1.6s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  `;

  const badge = doc.createElement('div');
  badge.className = 'badge';
  const dot = doc.createElement('span');
  dot.className = 'dot';
  const label = doc.createElement('span');
  label.textContent = 'Application activity is being recorded';
  badge.append(dot, label);

  shadow.append(style, badge);
  doc.documentElement.appendChild(host);
}

export function hideCaptureIndicator(doc: Document = document): void {
  doc.getElementById(HOST_ID)?.remove();
}
