// Comment-box dictation (E11): whether speech goes into an open comment box on its own ('auto', the default) or only
// while its mic button is on ('push').

import { Label, RadioGroup, RadioGroupItem } from '@inkup/ui';
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
    <section aria-labelledby="dictation" className="flex flex-col gap-3">
      <h2 id="dictation" className="text-lg font-bold tracking-tight">
        Comment boxes
      </h2>
      <RadioGroup
        value={current}
        onValueChange={(value) =>
          void captureSettings
            .getValue()
            .then((s) => captureSettings.setValue({ ...s, boxDictation: value as BoxDictation }))
        }
      >
        {CHOICES.map((c) => (
          <div key={c.value} className="flex items-start gap-3">
            <RadioGroupItem
              id={`box-dictation-${c.value}`}
              value={c.value}
              data-testid={`box-dictation-${c.value}`}
              className="mt-0.5"
            />
            <Label htmlFor={`box-dictation-${c.value}`} className="flex-col items-start gap-0.5 leading-snug">
              <span>{c.label}</span>
              <span className="font-normal text-muted-foreground">{c.note}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
    </section>
  );
}
