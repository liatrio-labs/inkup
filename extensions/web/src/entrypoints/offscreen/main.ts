// Offscreen document (reason USER_MEDIA). Only chrome.runtime is available here, so all configuration arrives
// in messages from the service worker and results go back as responses.
import { onMessage } from '@/messaging';
import {
  boxDictation,
  muteCapture,
  pauseCapture,
  resumeCapture,
  startCapture,
  stopCapture,
  switchMic,
  voiceOn,
} from './capture';
import { listMicsIdle } from './mic-source';
import { stopTabVideo } from './video';

onMessage('offscreenStart', ({ data }) => startCapture(data));
onMessage('offscreenStop', () => stopCapture());
onMessage('offscreenVideoStop', () => stopTabVideo());
onMessage('offscreenPause', () => pauseCapture());
onMessage('offscreenResume', () => resumeCapture());
onMessage('offscreenMute', ({ data }) => muteCapture(data));
onMessage('offscreenBoxDictation', ({ data }) => boxDictation(data));
onMessage('offscreenVoiceOn', ({ data }) => voiceOn(data));
onMessage('offscreenMicDevice', ({ data }) => switchMic(data));
// This context's own inputs (its origin's deviceIds and labels), also with no Session: the idle toolbar's picker.
onMessage('offscreenListMics', () => listMicsIdle());
onMessage('ortSelfTest', async ({ data }) => (await import('./ort-self-test')).runOrtSelfTest(data));
