export type RuntimeCapabilityKey =
  'secure-context' | 'camera-api' | 'local-storage' | 'reduced-motion';

export type RuntimeCapability = Readonly<{
  detail: string;
  key: RuntimeCapabilityKey;
  label: string;
  status: 'available' | 'preference' | 'unavailable';
}>;

export type RuntimeProbe = Readonly<{
  hasCameraApi: boolean;
  hasLocalStorage: boolean;
  isSecureContext: boolean;
  prefersReducedMotion: boolean;
}>;

export function assessRuntimeCapabilities(probe: RuntimeProbe): readonly RuntimeCapability[] {
  return [
    {
      detail: probe.isSecureContext
        ? 'This page is running in a secure context.'
        : 'Camera measurement is withheld because this page is not in a secure context.',
      key: 'secure-context',
      label: 'Secure context',
      status: probe.isSecureContext ? 'available' : 'unavailable',
    },
    {
      detail: probe.hasCameraApi
        ? 'The browser exposes the camera permission API.'
        : 'Camera measurement is unsupported in this browser.',
      key: 'camera-api',
      label: 'Camera interface',
      status: probe.hasCameraApi ? 'available' : 'unavailable',
    },
    {
      detail: probe.hasLocalStorage
        ? 'Session-only browser storage is available. Raw frames are not stored.'
        : 'Session persistence is unavailable; measurement remains withheld.',
      key: 'local-storage',
      label: 'Local session storage',
      status: probe.hasLocalStorage ? 'available' : 'unavailable',
    },
    {
      detail: probe.prefersReducedMotion
        ? 'Reduced-motion presentation will be used.'
        : 'Standard motion presentation is permitted by browser preference.',
      key: 'reduced-motion',
      label: 'Motion preference',
      status: probe.prefersReducedMotion ? 'preference' : 'available',
    },
  ];
}

export function canBeginCameraCalibration(capabilities: readonly RuntimeCapability[]): boolean {
  const requiredKeys: readonly RuntimeCapabilityKey[] = [
    'secure-context',
    'camera-api',
    'local-storage',
  ];

  return requiredKeys.every((requiredKey) =>
    capabilities.some(
      (capability) => capability.key === requiredKey && capability.status === 'available',
    ),
  );
}
