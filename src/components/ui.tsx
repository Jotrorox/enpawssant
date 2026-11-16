import { createEffect, For, type JSX, splitProps } from "solid-js";
import { CloseIcon } from "./Icons";

/** Class names for a main action button and a secondary one. */
export const PRIMARY_BUTTON =
  "flex h-9 items-center gap-2 rounded-xl bg-blush-400 px-4 text-[14px] font-bold whitespace-nowrap text-ink shadow-[inset_0_-2px_0_rgb(224_112_143/0.6)] transition-colors hover:bg-blush-300 disabled:opacity-50 disabled:hover:bg-blush-400";
export const SECONDARY_BUTTON =
  "flex h-9 items-center gap-2 rounded-xl bg-blush-100 px-4 text-[14px] font-bold whitespace-nowrap text-ink transition-colors hover:bg-blush-200 disabled:opacity-50";

export function Card(props: JSX.HTMLAttributes<HTMLElement>) {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <section
      class={`rounded-[20px] border border-blush-200/80 bg-white/80 shadow-card ${local.class ?? ""}`}
      {...rest}
    >
      {local.children}
    </section>
  );
}

export function CardTitle(props: { children: JSX.Element }) {
  return <h2 class="font-display text-[15px] font-semibold text-ink">{props.children}</h2>;
}

type SegmentedProps<T extends string> = {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "sm";
  class?: string;
};

/** A row of mutually exclusive tabs. */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  const sm = () => props.size === "sm";
  return (
    <div
      role="tablist"
      aria-label={props.label}
      class={`flex rounded-2xl bg-blush-100 ${sm() ? "rounded-xl p-[3px]" : "p-1"} ${props.class ?? ""}`}
    >
      <For each={props.options}>
        {(option) => {
          const selected = () => option.value === props.value;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={selected()}
              onClick={() => props.onChange(option.value)}
              class={`flex-1 whitespace-nowrap transition-colors ${
                sm()
                  ? "rounded-[9px] px-2.5 py-0.5 text-[13px]"
                  : "rounded-xl px-3 py-1.5 text-[14px]"
              } ${
                selected()
                  ? "bg-white font-bold text-ink shadow-[0_1px_3px_rgb(74_50_71/0.12)]"
                  : "font-semibold text-ink/75 hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

export function IconButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; boxed?: boolean },
) {
  const [local, rest] = splitProps(props, ["label", "boxed", "class", "children"]);
  return (
    <button
      type="button"
      aria-label={local.label}
      title={local.label}
      class={`grid size-9 place-items-center rounded-xl text-ink transition-colors hover:bg-blush-100 disabled:opacity-35 disabled:hover:bg-transparent ${
        local.boxed ? "bg-blush-100/70" : ""
      } ${local.class ?? ""}`}
      {...rest}
    >
      {local.children}
    </button>
  );
}

export function EmptyState(props: { children: JSX.Element; class?: string }) {
  return (
    <div
      class={`grid place-items-center rounded-2xl border border-dashed border-blush-300 px-4 py-6 text-center text-[13px] text-muted ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

/** A modal dialog; Escape, the close button and clicks on the backdrop call `onClose`. */
export function Modal(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively.
    <dialog
      ref={dialog}
      aria-label={props.title}
      onClose={() => props.onClose()}
      // Clicks on the backdrop land on the dialog element itself.
      onClick={(event) => event.target === dialog && dialog.close()}
      class="m-auto w-[min(640px,calc(100vw-32px))] rounded-[20px] border border-blush-200 bg-blush-50 text-ink shadow-card backdrop:bg-plum/30"
    >
      <div class="flex max-h-[calc(100vh-64px)] flex-col gap-3 p-5">
        <div class="flex items-center">
          <h2 class="font-display text-[17px] font-semibold">{props.title}</h2>
          <IconButton label="Close" class="ml-auto" onClick={() => dialog.close()}>
            <CloseIcon class="size-4" />
          </IconButton>
        </div>
        {props.children}
      </div>
    </dialog>
  );
}
