import type { ReactNode } from "react";

type Tone = "amber";

type Props = {
  tone?: Tone;
  children: ReactNode;
};

const TONE_CLASS: Record<Tone, string> = {
  amber: "bg-sivru-amber/10 border-sivru-amber/40 text-sivru-amber",
};

export function Banner({ tone = "amber", children }: Props): JSX.Element {
  return (
    <div
      className={
        "flex items-center gap-2 border-b px-4 py-2 text-xs " + TONE_CLASS[tone]
      }
      role="status"
    >
      {children}
    </div>
  );
}
