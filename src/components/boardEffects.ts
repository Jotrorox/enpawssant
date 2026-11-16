// One-shot board effects built on the Web Animations API. They create short-lived elements (or
// animate existing ones) and clean up after themselves, so they never touch reactive state.

type Cell = [x: number, y: number];

export const CAPTURE_COLORS = [
  "var(--color-rose)",
  "var(--color-blush-400)",
  "var(--color-rose-strong)",
  "var(--color-peach)",
];
export const SPARKLE_COLORS = ["var(--color-cream)", "var(--color-peach)", "#ffd36e", "#ffffff"];
export const CONFETTI_COLORS = [
  "var(--color-rose)",
  "var(--color-peach)",
  "var(--color-cream)",
  "var(--color-nag-interesting)",
  "var(--color-nag-good)",
  "var(--color-blush-400)",
];

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Squash and stretch, as if the piece were a little soft when it lands. */
export function squash(el: HTMLElement | undefined, delay: number) {
  el?.animate(
    [
      { transform: "scale(1, 1)" },
      { transform: "scale(1.1, 0.88)", offset: 0.3 },
      { transform: "scale(0.96, 1.05)", offset: 0.65 },
      { transform: "scale(1, 1)" },
    ],
    { duration: 320, delay, easing: "ease-out" },
  );
}

/** A startled wobble, for a king that has just been checked. */
export function wiggle(el: HTMLElement | undefined, delay: number) {
  el?.animate(
    [
      { transform: "rotate(0deg)" },
      { transform: "rotate(-12deg)" },
      { transform: "rotate(10deg)" },
      { transform: "rotate(-6deg)" },
      { transform: "rotate(3deg)" },
      { transform: "rotate(0deg)" },
    ],
    { duration: 560, delay, easing: "ease-in-out" },
  );
}

/** A quick "nope" head-shake, for a piece dropped on a square it can't reach. */
export function shake(el: HTMLElement | undefined, delay: number) {
  el?.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-8%)" },
      { transform: "translateX(7%)" },
      { transform: "translateX(-4%)" },
      { transform: "translateX(2%)" },
      { transform: "translateX(0)" },
    ],
    { duration: 340, delay, easing: "ease-out" },
  );
}

/** A ring spreading out from a square, like a pebble dropped in water. */
export function ripple(layer: HTMLElement | undefined, [x, y]: Cell, delay: number) {
  if (!layer) return;
  const ring = document.createElement("span");
  ring.className = "board-ripple";
  ring.style.left = `${x * 12.5}%`;
  ring.style.top = `${y * 12.5}%`;
  layer.append(ring);
  const animation = ring.animate(
    [
      { transform: "scale(0.35)", opacity: 0.85 },
      { transform: "scale(1.5)", opacity: 0 },
    ],
    { duration: 560, delay, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "backwards" },
  );
  animation.onfinish = () => ring.remove();
  animation.oncancel = () => ring.remove();
}

type BurstOptions = {
  delay: number;
  colors: string[];
  count: number;
  /** How far particles fly, in squares. */
  spread?: number;
  /** Mix four-pointed sparkles in with the round particles. */
  sparkles?: boolean;
};

/** Particles bursting out of a square and drifting down as they fade. */
export function burst(layer: HTMLElement | undefined, [x, y]: Cell, options: BurstOptions) {
  if (!layer) return;
  const square = layer.clientWidth / 8;
  if (!square) return;
  const spread = options.spread ?? 1;
  for (let i = 0; i < options.count; i++) {
    const particle = document.createElement("span");
    particle.className =
      options.sparkles && i % 2 === 0 ? "board-particle board-sparkle" : "board-particle";
    const size = square * (0.08 + Math.random() * 0.08) * (options.sparkles ? 1.4 : 1);
    particle.style.left = `${(x + 0.5) * 12.5}%`;
    particle.style.top = `${(y + 0.5) * 12.5}%`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.background = options.colors[i % options.colors.length];
    layer.append(particle);

    const angle = (i / options.count) * Math.PI * 2 + Math.random() * 0.7;
    const distance = square * spread * (0.45 + Math.random() * 0.5);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const spin = (Math.random() - 0.5) * 360;
    const at = (fx: number, fy: number) =>
      `translate(calc(-50% + ${dx * fx}px), calc(-50% + ${dy * fx + square * fy}px))`;
    const animation = particle.animate(
      [
        { transform: `${at(0, 0)} scale(0.3) rotate(0deg)`, opacity: 0 },
        {
          transform: `${at(0.75, 0)} scale(1.15) rotate(${spin * 0.6}deg)`,
          opacity: 1,
          offset: 0.3,
        },
        { transform: `${at(1, 0.22)} scale(0) rotate(${spin}deg)`, opacity: 0 },
      ],
      {
        duration: 560 + Math.random() * 220,
        delay: options.delay,
        easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
        fill: "backwards",
      },
    );
    animation.onfinish = () => particle.remove();
    animation.oncancel = () => particle.remove();
  }
}
