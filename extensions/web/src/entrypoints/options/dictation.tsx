// Comment-box dictation (E11): whether speech goes into an open comment box on its own ('auto', the default) or only
// while its mic button is on ('push').

import { useStorageItem } from '@/lib/use-storage-item';
import { type BoxDictation, captureSettings } from '@/settings';

const CHOICES: { value: BoxDictation; label: string; note: string }[] = [
  {
    value: 'auto',
    label: 'Speak into the box',
    note: 'While a comment box is open, what you say goes into it (not the Session transcript). Its mic button switches to typing.',
  },
  {
    value: 'push',
    label: 'Type, and dictate with the mic button',
    note: 'The box opens for typing; its mic button dictates while it is on.',
  },
];

export function DictationSection() {
  const settings = useStorageItem(captureSettings);
  const current = settings?.boxDictation ?? 'auto';
  return (
    <section aria-labelledby="dictation" className="flex flex-col gap-2">
      <h2 id="dictation" className="text-base font-semibold">
        Comment boxes
      </h2>
      {CHOICES.map((c) => (
        <label key={c.value} className="flex items-start gap-2">
          <input
            type="radio"
            name="box-dictation"
            className="mt-1"
            value={c.value}
            data-testid={`box-dictation-${c.value}`}
            checked={current === c.value}
            onChange={() =>
              void captureSettings.getValue().then((s) => captureSettings.setValue({ ...s, boxDictation: c.value }))
            }
          />
          <span>
            {c.label}
            <span className="block text-muted-foreground">{c.note}</span>
          </span>
        </label>
      ))}
    </section>
  );
}
