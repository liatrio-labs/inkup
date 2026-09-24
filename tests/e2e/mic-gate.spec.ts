// PRD P0-1, E11: the microphone is optional. Before onboarding recorded the grant, Start is still possible (a Session
// without voice, proven end to end in voice-optional.spec.ts) and the panel says what granting adds; onboarding's mic
// step can be skipped.
// Automation limit: --auto-accept-camera-and-microphone-capture accepts every getUserMedia call, so a real "Block"
// click in Chrome's prompt cannot be simulated. The denied-permission branch (navigator.permissions reports 'denied')
// is on docs/manual-checks.md.
import { expect, test } from './fixtures';

test('without the microphone grant Start is possible, and setup can skip or grant it', async ({
  context,
  site,
  openExtensionPage,
}) => {
  await (await context.newPage()).goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('start')).toBeEnabled();
  await expect(panel.getByTestId('mic-gate')).toContainText('No microphone yet');

  // Onboarding opened itself on install: its mic step can be skipped, or granted, which the panel follows live.
  const onboarding =
    context.pages().find((p) => p.url().endsWith('/onboarding.html')) ?? (await openExtensionPage('onboarding.html'));
  await expect(onboarding.getByTestId('privacy-notice')).toContainText('Keystrokes are never captured');
  await onboarding.getByTestId('skip-mic').click();
  await expect(onboarding.getByTestId('mic-skipped')).toContainText(
    'Sessions record ink, picks, typed comments and screenshots',
  );
  await onboarding.reload();
  await onboarding.getByTestId('allow-mic').click();
  await expect(onboarding.getByTestId('mic-status')).toBeVisible();
  await expect(panel.getByTestId('start')).toBeEnabled();
  await expect(panel.getByTestId('mic-gate')).toHaveCount(0);
});
