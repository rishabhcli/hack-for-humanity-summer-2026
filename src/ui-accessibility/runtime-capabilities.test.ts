import { describe, expect, it } from 'vitest';

import {
  assessRuntimeCapabilities,
  canBeginCameraCalibration,
  type RuntimeProbe,
} from './runtime-capabilities';

const supportedProbe: RuntimeProbe = {
  hasCameraApi: true,
  hasLocalStorage: true,
  isSecureContext: true,
  prefersReducedMotion: false,
};

describe('runtime capability assessment', () => {
  it('permits calibration only when every required local capability is available', () => {
    const capabilities = assessRuntimeCapabilities(supportedProbe);

    expect(canBeginCameraCalibration(capabilities)).toBe(true);
  });

  it.each(['hasCameraApi', 'hasLocalStorage', 'isSecureContext'] as const)(
    'withholds calibration when %s is unavailable',
    (key) => {
      const capabilities = assessRuntimeCapabilities({ ...supportedProbe, [key]: false });

      expect(canBeginCameraCalibration(capabilities)).toBe(false);
      expect(capabilities.some((capability) => capability.status === 'unavailable')).toBe(true);
    },
  );

  it('treats reduced motion as a presentation preference rather than a failure', () => {
    const capabilities = assessRuntimeCapabilities({
      ...supportedProbe,
      prefersReducedMotion: true,
    });

    expect(canBeginCameraCalibration(capabilities)).toBe(true);
    expect(capabilities.find(({ key }) => key === 'reduced-motion')?.status).toBe('preference');
  });
});
