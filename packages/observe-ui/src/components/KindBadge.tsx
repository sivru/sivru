import type { SivruEventKind } from "../types";

const KIND_LABEL: Record<SivruEventKind, string> = {
  user_message: "USR",
  assistant_message: "AST",
  tool_use: "TOOL",
  tool_result: "RES",
  system: "SYS",
  unknown: "UNK",
};

const KIND_CLASS: Record<SivruEventKind, string> = {
  user_message: "bg-sky-900/40 text-sky-200",
  assistant_message: "bg-sivru-amber/15 text-sivru-amber",
  tool_use: "bg-emerald-900/30 text-emerald-200",
  tool_result: "bg-zinc-700/50 text-zinc-200",
  system: "bg-zinc-800/60 text-sivru-mute",
  unknown: "bg-zinc-800/60 text-sivru-mute",
};

type Size = "sm" | "md";

type Props = {
  kind: SivruEventKind;
  size?: Size;
};

export function kindLabel(kind: SivruEventKind): string {
  return KIND_LABEL[kind];
}

export function KindBadge({ kind, size = "sm" }: Props): JSX.Element {
  const sizeCls =
    size === "md"
      ? "px-1.5 py-0.5 text-[11px] min-w-[44px]"
      : "w-12 px-1 py-0.5 text-[10px]";
  return (
    <span
      className={
        "inline-flex shrink-0 items-center justify-center rounded-sivru font-medium uppercase tracking-wider " +
        sizeCls +
        " " +
        KIND_CLASS[kind]
      }
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
