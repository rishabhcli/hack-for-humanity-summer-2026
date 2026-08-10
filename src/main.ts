import './ui-accessibility/styles.css';

import {
  assessRuntimeCapabilities,
  canBeginCameraCalibration,
  type RuntimeCapability,
} from './ui-accessibility/runtime-capabilities';

function storageIsAvailable(): boolean {
  try {
    const key = '__runtime_probe__';
    window.sessionStorage.setItem(key, '1');
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readCapabilities(): readonly RuntimeCapability[] {
  return assessRuntimeCapabilities({
    hasCameraApi:
      typeof navigator.mediaDevices !== 'undefined' &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
    hasLocalStorage: storageIsAvailable(),
    isSecureContext: window.isSecureContext,
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}

function capabilityMarkup(capability: RuntimeCapability): string {
  const statusLabel =
    capability.status === 'available'
      ? 'Available'
      : capability.status === 'preference'
        ? 'Preference detected'
        : 'Unavailable';

  return `
    <li class="capability capability--${capability.status}">
      <span class="capability__signal" aria-hidden="true"></span>
      <div>
        <div class="capability__heading">
          <strong>${capability.label}</strong>
          <span>${statusLabel}</span>
        </div>
        <p>${capability.detail}</p>
      </div>
    </li>
  `;
}

const app = document.querySelector<HTMLDivElement>('#app');

if (app === null) {
  throw new Error('APP_ROOT_MISSING');
}

app.innerHTML = `
  <header class="masthead">
    <p class="eyebrow">Cervical joint-position measurement</p>
    <div class="status-chip" role="status">
      <span aria-hidden="true"></span>
      Not yet in production
    </div>
  </header>

  <main id="main-content">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero__copy">
        <p class="index">Instrument status · 00</p>
        <h1 id="page-title">Measure less.<br /><em>Know what holds.</em></h1>
        <p class="lede">
          This tool is being built to measure an eyes-closed return to neutral while refusing
          low-confidence geometry and changes that do not exceed measurement noise.
        </p>
      </div>

      <aside class="safety-card" aria-labelledby="safety-title">
        <p class="safety-card__label">Before any session</p>
        <h2 id="safety-title">This is not a diagnosis or a return-to-activity decision.</h2>
        <p>
          Stop the activity if symptoms are concerning or worsen. Seek care from a qualified
          clinician. No measurement is currently available while validation gates remain open.
        </p>
      </aside>
    </section>

    <section class="readiness" aria-labelledby="readiness-title">
      <div class="readiness__heading">
        <div>
          <p class="index">Local readiness · 01</p>
          <h2 id="readiness-title">Environment check</h2>
        </div>
        <button id="run-check" type="button">Run check <span aria-hidden="true">↗</span></button>
      </div>

      <p class="readiness__intro">
        This check stays in the browser. It does not request camera permission and does not send
        or retain a frame.
      </p>

      <div id="check-result" class="check-result" aria-live="polite">
        <p>Run the check to inspect this browser's local prerequisites.</p>
      </div>
    </section>
  </main>

  <footer>
    <p>Raw camera frames must remain on this device.</p>
    <p>Measurement remains withheld until calibration and quality requirements pass.</p>
  </footer>
`;

const runCheckButton = document.querySelector<HTMLButtonElement>('#run-check');
const checkResult = document.querySelector<HTMLDivElement>('#check-result');

if (runCheckButton === null || checkResult === null) {
  throw new Error('READINESS_CONTROL_MISSING');
}

runCheckButton.addEventListener('click', () => {
  const capabilities = readCapabilities();
  const environmentReady = canBeginCameraCalibration(capabilities);
  const summary = environmentReady
    ? 'Local prerequisites are available. Measurement is still withheld pending validation.'
    : 'Local prerequisites are incomplete. Camera calibration must remain unavailable.';

  checkResult.innerHTML = `
    <p class="check-result__summary" data-ready="${String(environmentReady)}">${summary}</p>
    <ul>${capabilities.map(capabilityMarkup).join('')}</ul>
  `;
});
