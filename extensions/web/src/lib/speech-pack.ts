// On-device speech language pack state and install (SpeechRecognition.available / install). install() needs
// user activation, so it runs from a click in an extension page (onboarding or the side panel), never offscreen.
import { useCallback, useEffect, useState } from 'react';
import { findSpeechRecognition } from '@/adapters/transcription/webspeech';

export type SpeechPack = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

type Installable = NonNullable<ReturnType<typeof findSpeechRecognition>> & {
  install?: (o: unknown) => Promise<boolean>;
};

const installable = () => findSpeechRecognition() as Installable | undefined;
const packOptions = (lang: string) => ({ langs: [lang], processLocally: true });

export function useSpeechPack(lang: string): [SpeechPack, () => Promise<void>] {
  const [state, setState] = useState<SpeechPack>('checking');
  useEffect(() => {
    const SR = installable();
    if (!SR?.available) return setState('unsupported');
    SR.available(packOptions(lang))
      .then((s) => setState(s as SpeechPack))
      .catch(() => setState('unsupported'));
  }, [lang]);
  const install = useCallback(async () => {
    const SR = installable();
    const opts = packOptions(lang);
    if (!SR?.install || !SR.available) return;
    setState('downloading');
    try {
      await SR.install(opts);
    } catch {
      /* state below says what happened */
    }
    setState((await SR.available(opts)) as SpeechPack);
  }, [lang]);
  return [state, install];
}
